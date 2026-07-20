/**
 * fetch-map.js
 * Génère un plan simplifié (line-art) d'un quartier/ville, avec :
 *  - fallback sur plusieurs miroirs Overpass
 *  - sélection pondérée qui évite les zones vides (retry si trop peu de routes)
 *  - export docs/map.svg + docs/data.json + docs/preview.html (PNG e-ink pré-rendus)
 *
 * Pipeline visé : GitHub Actions cron -> ce script -> GitHub Pages -> Liquid TRMNL
 * Dépendances : node >= 18, sharp (npm i sharp) pour la rasterisation + dithering.
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// 1. CONFIG
// ---------------------------------------------------------------------------

const OUTPUT_DIR = "./docs";
const RADIUS_METERS = 900;
const SVG_WIDTH = 1872; // résolution X ; l'OG scale via viewBox côté CSS
const SVG_HEIGHT = 1404;

const MIN_HIGHWAY_COUNT = 25;
const MAX_ATTEMPTS = 6;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Dataset GeoNames (cities15000, ~34 000 villes > 15 000 hab, monde entier)
// converti par build-cities.js -> data/cities.json. Format compact par ville :
// [nom, code pays ISO, lat, lon, population]. Licence CC-BY 4.0, geonames.org.
const CITIES_PATH = new URL("./data/cities.json", import.meta.url);
let citiesCache = null;

async function loadCities() {
  if (citiesCache) return citiesCache;
  const raw = await fs.readFile(CITIES_PATH, "utf-8");
  citiesCache = JSON.parse(raw);
  return citiesCache;
}

// Rayon d'exploration adapté à la taille de la ville : une bourgade de 15k hab
// n'a pas besoin (et n'a pas la matière) d'un rayon de 3-4km comme une métropole.
function exploreRadiusFor(population) {
  const estimate = Math.sqrt(Math.max(population, 15000)) * 3;
  return Math.min(3500, Math.max(800, estimate));
}

// ---------------------------------------------------------------------------
// 2. SÉLECTION PONDÉRÉE D'UN POINT (évite les zones vides)
// ---------------------------------------------------------------------------

function randomOffset(exploreRadiusMeters) {
  const r = exploreRadiusMeters * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  return { dx: r * Math.cos(theta), dy: r * Math.sin(theta) };
}

function offsetLatLon(lat, lon, dxMeters, dyMeters) {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  return {
    lat: lat + dyMeters / metersPerDegLat,
    lon: lon + dxMeters / metersPerDegLon,
  };
}

async function candidateLocation(fixed) {
  if (fixed?.lat && fixed?.lon) {
    return { name: fixed.name ?? "Lieu personnalisé", lat: +fixed.lat, lon: +fixed.lon };
  }
  const cities = await loadCities();
  const [name, , lat, lon, population] = cities[Math.floor(Math.random() * cities.length)];
  const radius = exploreRadiusFor(population);
  const { dx, dy } = randomOffset(radius);
  const offset = offsetLatLon(lat, lon, dx, dy);
  return { name, lat: offset.lat, lon: offset.lon };
}

// ---------------------------------------------------------------------------
// 3. OVERPASS AVEC FALLBACK MULTI-MIROIRS
// ---------------------------------------------------------------------------

function buildOverpassQuery(lat, lon, radius) {
  return `
    [out:json][timeout:40];
    (
      way["highway"](around:${radius},${lat},${lon});
      way["waterway"](around:${radius},${lat},${lon});
      way["leisure"="park"](around:${radius},${lat},${lon});
    );
    out geom;
  `;
}

async function fetchOverpassOnce(endpoint, query, timeoutMs = 45000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": "trmnl-carte-souvenir/1.0 (+https://github.com/nbbou81000)",
      },
      body: query,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.elements ?? [];
  } finally {
    clearTimeout(t);
  }
}

async function fetchOverpassWithFallback(lat, lon, radius) {
  const query = buildOverpassQuery(lat, lon, radius);
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return await fetchOverpassOnce(endpoint, query, 25000);
    } catch (err) {
      lastErr = err;
      console.warn(`Overpass échec sur ${endpoint}: ${err.message} — miroir suivant`);
    }
  }
  throw new Error(`Tous les miroirs Overpass ont échoué : ${lastErr?.message}`);
}

// ---------------------------------------------------------------------------
// 4. BOUCLE "ÉVITE LE VIDE"
// ---------------------------------------------------------------------------

function densityScore(elements) {
  return elements.filter((el) => el.tags?.highway).length;
}

async function findPopulatedLocation(fixed) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const location = await candidateLocation(fixed);
    const elements = await fetchOverpassWithFallback(location.lat, location.lon, RADIUS_METERS);
    const score = densityScore(elements);
    console.log(`Tentative ${attempt}: ${location.name} (${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}) — ${score} routes`);
    if (score >= MIN_HIGHWAY_COUNT || fixed) {
      return { location, elements };
    }
  }
  throw new Error(`Aucun lieu suffisamment dense trouvé après ${MAX_ATTEMPTS} tentatives`);
}

// ---------------------------------------------------------------------------
// 5. PROJECTION + STYLE + SVG
// ---------------------------------------------------------------------------

function makeProjector(centerLat, centerLon, radiusMeters, width, height) {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  // scale en pixels PAR MÈTRE : dx/dy ci-dessous sont déjà en mètres, donc pas
  // besoin de repasser par les degrés ici (c'était le bug : mélange d'unités
  // qui produisait des coordonnées aberrantes, hors du viewBox -> rendu blanc).
  const scaleX = width / (radiusMeters * 2);
  const scaleY = height / (radiusMeters * 2);
  const scale = Math.min(scaleX, scaleY);
  return (lat, lon) => {
    const dx = (lon - centerLon) * metersPerDegLon;
    const dy = (lat - centerLat) * metersPerDegLat;
    return { x: width / 2 + dx * scale, y: height / 2 - dy * scale };
  };
}

function styleFor(tags) {
  if (tags.waterway) return { stroke: "#000", width: 3.2, opacity: 0.9 };
  if (tags.leisure === "park") return { stroke: "#000", width: 1, opacity: 0.2, fill: "#000", fillOpacity: 0.05 };
  if (tags.highway) {
    const trunk = ["motorway", "trunk"];
    const major = ["primary", "secondary"];
    const mid = ["tertiary", "unclassified", "residential"];
    const minor = ["service", "living_street", "pedestrian"];
    const path = ["footway", "path", "cycleway", "track", "steps"];
    if (trunk.includes(tags.highway)) return { stroke: "#000", width: 3.6, opacity: 1 };
    if (major.includes(tags.highway)) return { stroke: "#000", width: 2.4, opacity: 0.95 };
    if (mid.includes(tags.highway)) return { stroke: "#000", width: 1.3, opacity: 0.8 };
    if (minor.includes(tags.highway)) return { stroke: "#000", width: 0.7, opacity: 0.55 };
    if (path.includes(tags.highway)) return { stroke: "#000", width: 0.5, opacity: 0.35 };
    return { stroke: "#000", width: 0.9, opacity: 0.6 };
  }
  return { stroke: "#000", width: 0.5, opacity: 0.4 };
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

function formatCoords(lat, lon) {
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "E" : "O";
  return `${Math.abs(lat).toFixed(4)}°${latDir}  ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

function buildSVG(elements, project, { width, height, label }) {
  const paths = elements
    .filter((el) => el.geometry?.length > 1)
    .map((el) => {
      const style = styleFor(el.tags ?? {});
      const points = el.geometry.map(({ lat, lon }) => project(lat, lon));
      const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
      const fill = style.fill ? `fill="${style.fill}" fill-opacity="${style.fillOpacity}"` : `fill="none"`;
      return `<path d="${d}" stroke="${style.stroke}" stroke-width="${style.width}" stroke-opacity="${style.opacity}" ${fill} stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("\n");

  const cx = width / 2;
  const cy = height / 2;
  const margin = Math.round(width * 0.035);
  const vignetteRadius = 0.68 * Math.min(width, height);

  // Marqueur discret au point exact du tirage — utile pour le concept "souvenir".
  const marker = `
    <g stroke="#000" fill="none" stroke-width="${width * 0.0016}">
      <circle cx="${cx}" cy="${cy}" r="${width * 0.009}"/>
      <circle cx="${cx}" cy="${cy}" r="${width * 0.002}" fill="#000" stroke="none"/>
    </g>`;

  // Petite flèche de nord, coin haut-droit — repère cardinal classique des posters de plan.
  const northSize = width * 0.02;
  const northX = width - margin - 30;
  const northY = margin + 50;
  const north = `
    <g transform="translate(${northX}, ${northY})" stroke="#000" stroke-width="${width * 0.0012}" fill="#000">
      <line x1="0" y1="${northSize}" x2="0" y2="-${northSize}"/>
      <path d="M 0 ${-northSize} L ${northSize * 0.35} ${-northSize * 0.35} L 0 ${-northSize * 0.6} L ${-northSize * 0.35} ${-northSize * 0.35} Z"/>
      <text x="0" y="${northSize + 22}" text-anchor="middle" font-family="Georgia, serif" font-size="${width * 0.012}">N</text>
    </g>`;

  const caption = label
    ? `<g text-anchor="middle" font-family="Georgia, serif" fill="#000">
        <line x1="${cx - 90}" y1="${height - margin - 64}" x2="${cx + 90}" y2="${height - margin - 64}" stroke="#000" stroke-width="1.5"/>
        <text x="${cx}" y="${height - margin - 26}" font-size="${width * 0.021}" letter-spacing="1">${escapeXml(label.name)}</text>
        <text x="${cx}" y="${height - margin}" font-size="${width * 0.012}" fill="#000" opacity="0.75">${escapeXml(label.coords)}</text>
      </g>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="vignette" cx="50%" cy="50%" r="${vignetteRadius}" gradientUnits="userSpaceOnUse">
      <stop offset="55%" stop-color="#fff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="#fff"/>
  ${paths}
  ${marker}
  <rect width="100%" height="100%" fill="url(#vignette)"/>
  ${north}
  <rect x="${margin}" y="${margin}" width="${width - margin * 2}" height="${height - margin * 2}" fill="none" stroke="#000" stroke-width="2" stroke-opacity="0.7"/>
  <rect x="${margin + 8}" y="${margin + 8}" width="${width - margin * 2 - 16}" height="${height - margin * 2 - 16}" fill="none" stroke="#000" stroke-width="1" stroke-opacity="0.4"/>
  ${caption}
</svg>`;
}

// ---------------------------------------------------------------------------
// 6. DITHERING + RASTERISATION CÔTÉ SERVEUR (sharp) — pas de JS navigateur requis
// ---------------------------------------------------------------------------

function ditherFloydSteinberg(grayBuffer, width, height, levels) {
  const step = 255 / (levels - 1);
  const gray = Float32Array.from(grayBuffer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = gray[idx];
      const quant = Math.round(old / step) * step;
      const err = old - quant;
      gray[idx] = quant;
      if (x + 1 < width) gray[idx + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) gray[idx + width - 1] += (err * 3) / 16;
        gray[idx + width] += (err * 5) / 16;
        if (x + 1 < width) gray[idx + width + 1] += (err * 1) / 16;
      }
    }
  }
  const out = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) out[i] = Math.max(0, Math.min(255, Math.round(gray[i])));
  return out;
}

async function renderEinkPNG(svgString, width, height, levels) {
  const { data, info } = await sharp(Buffer.from(svgString), { density: 220 })
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const dithered = ditherFloydSteinberg(data, info.width, info.height, levels);
  return sharp(dithered, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .toBuffer();
}

function buildPreviewHTML(meta, ogB64, xB64) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Preview — ${escapeXml(meta.location)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #222; color: #eee; padding: 24px; }
  h1 { font-size: 18px; }
  .row { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 16px; }
  .card { background: #fff; padding: 8px; border-radius: 4px; }
  .card img { display: block; max-width: 100%; }
  .label { color: #ccc; font-size: 13px; margin-top: 6px; }
</style>
</head>
<body>
  <h1>${escapeXml(meta.location)} — ${meta.lat.toFixed(4)}, ${meta.lon.toFixed(4)}</h1>
  <p class="label">Généré le ${meta.generated_at}</p>
  <div class="row">
    <div>
      <div class="card"><img width="480" src="data:image/png;base64,${ogB64}"></div>
      <p class="label">Simulation TRMNL OG (800×480, 1-bit Floyd-Steinberg)</p>
    </div>
    <div>
      <div class="card"><img width="480" src="data:image/png;base64,${xB64}"></div>
      <p class="label">Simulation TRMNL X (16 niveaux de gris)</p>
    </div>
  </div>
</body>
</html>`;
  // Note : tout est en PNG statique en base64, aucun script requis pour l'affichage —
  // évite les soucis de CSP/canvas rencontrés avec l'ancienne version basée sur <canvas>.
}

// ---------------------------------------------------------------------------
// 7. MAIN
// ---------------------------------------------------------------------------

async function main(fixed) {
  const { location, elements } = await findPopulatedLocation(fixed);
  const project = makeProjector(location.lat, location.lon, RADIUS_METERS, SVG_WIDTH, SVG_HEIGHT);
  const meta = {
    location: location.name,
    lat: location.lat,
    lon: location.lon,
    generated_at: new Date().toISOString(),
  };
  const svg = buildSVG(elements, project, {
    width: SVG_WIDTH,
    height: SVG_HEIGHT,
    label: { name: location.name, coords: formatCoords(location.lat, location.lon) },
  });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, "map.svg"), svg, "utf-8");
  await fs.writeFile(path.join(OUTPUT_DIR, "data.json"), JSON.stringify({ ...meta, svg_url: "map.svg" }, null, 2));

  const ogPng = await renderEinkPNG(svg, 800, 480, 2);
  const xPng = await renderEinkPNG(svg, 936, 702, 16); // demi-résolution pour un preview plus léger
  await fs.writeFile(path.join(OUTPUT_DIR, "preview-og.png"), ogPng);
  await fs.writeFile(path.join(OUTPUT_DIR, "preview-x.png"), xPng);

  const preview = buildPreviewHTML(meta, ogPng.toString("base64"), xPng.toString("base64"));
  await fs.writeFile(path.join(OUTPUT_DIR, "preview.html"), preview, "utf-8");

  console.log(`OK — ${location.name}, preview: docs/preview.html (+ preview-og.png / preview-x.png)`);
}

// Pour un lieu fixe (ex: custom_fields TRMNL) :
// main({ lat: 48.8867, lon: 2.3431, name: "Notre premier rendez-vous" })
main().catch((err) => {
  // Si tous les miroirs Overpass sont injoignables (souvent lié aux IP
  // partagées des runners CI, rate-limitées côté Overpass), on ne fait pas
  // planter le workflow : on garde simplement la dernière carte générée et on
  // retentera au prochain passage du cron.
  console.error(`Génération annulée : ${err.message}`);
  console.error("La carte précédente reste en ligne, nouvel essai au prochain cron.");
  process.exit(0);
});
