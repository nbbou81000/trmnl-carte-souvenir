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

const OUTPUT_DIR = "."; // racine du repo — évite les soucis de sous-dossier avec GitHub Pages
const RADIUS_METERS = 900;
// 5:3 = ratio natif de l'OG (800×480) : réduit drastiquement le letterboxing
// de image--contain. Hauteur inchangée → l'échelle px/m et toutes les
// épaisseurs de traits restent identiques à la version précédente.
const SVG_WIDTH = 2340;
const SVG_HEIGHT = 1404;

// Le dessin doit continuer au-delà du cadre, jusqu'aux bords du canvas.
// L'échelle (px/m) reste calée sur RADIUS_METERS via min(width,height) : pour
// couvrir les COINS du canvas, il faut fetcher jusqu'à la demi-diagonale, soit
// radius * hypot(w,h)/min(w,h) ≈ 1.67 × le rayon → ~1500 m. (~2.8× de données
// Overpass, absorbé sans souci par les miroirs.)
const FETCH_RADIUS_METERS = Math.ceil(
  (RADIUS_METERS * Math.hypot(SVG_WIDTH, SVG_HEIGHT)) / Math.min(SVG_WIDTH, SVG_HEIGHT)
);

// IMPORTANT : à adapter à ton propre repo. TRMNL affiche cette valeur telle
// quelle dans <img src="...">, donc il faut une URL absolue.
const PAGES_BASE_URL = "https://nbbou81000.github.io/trmnl-carte-souvenir";

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
    return { name: fixed.name ?? "Lieu personnalisé", lat: +fixed.lat, lon: +fixed.lon, country: null, population: null };
  }
  const cities = await loadCities();
  const [name, country, lat, lon, population] = cities[Math.floor(Math.random() * cities.length)];
  const radius = exploreRadiusFor(population);
  const { dx, dy } = randomOffset(radius);
  const offset = offsetLatLon(lat, lon, dx, dy);
  return { name, lat: offset.lat, lon: offset.lon, country, population };
}

// ---------------------------------------------------------------------------
// 3. OVERPASS AVEC FALLBACK MULTI-MIROIRS
// ---------------------------------------------------------------------------

function buildOverpassQuery(lat, lon, radius) {
  return `
    [out:json][timeout:50];
    (
      way["highway"](around:${radius},${lat},${lon});
      way["waterway"](around:${radius},${lat},${lon});
      way["natural"="water"](around:${radius},${lat},${lon});
      way["railway"="rail"](around:${radius},${lat},${lon});
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
      // 40s par miroir : le rayon élargi (~4× de surface) rallonge un peu les
      // réponses des serveurs publics chargés.
      return await fetchOverpassOnce(endpoint, query, 40000);
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

// La densité se mesure sur la zone CENTRALE (celle qui finira dans le cadre),
// pas sur tout le rayon de fetch élargi : sinon un centre vide entouré de
// lotissements périphériques passerait le seuil à tort.
function densityScore(elements, centerLat, centerLon) {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return elements.filter((el) => {
    if (!el.tags?.highway) return false;
    const p = el.geometry?.[0];
    if (!p) return false;
    const dx = (p.lon - centerLon) * metersPerDegLon;
    const dy = (p.lat - centerLat) * metersPerDegLat;
    return Math.hypot(dx, dy) <= RADIUS_METERS;
  }).length;
}

async function findPopulatedLocation(fixed) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const location = await candidateLocation(fixed);
    const elements = await fetchOverpassWithFallback(location.lat, location.lon, FETCH_RADIUS_METERS);
    const score = densityScore(elements, location.lat, location.lon);
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

// Classification par couche, dessinées dans l'ordre : eau (fond) -> parcs ->
// rails -> routes (casing puis fill) -> petites voies. Épaisseurs relevées
// (~+40%) par rapport à la V1 : le dithering 1-bit de l'OG mange les traits
// fins, qui deviennent des pointillés.
function classify(tags) {
  if (tags.natural === "water") return { layer: "water_area" };
  if (tags.waterway) return { layer: "water_line" };
  if (tags.railway === "rail") return { layer: "rail" };
  if (tags.leisure === "park") return { layer: "park" };
  if (tags.highway) {
    const trunk = ["motorway", "trunk"];
    const major = ["primary", "secondary"];
    const mid = ["tertiary", "unclassified", "residential"];
    const minor = ["service", "living_street", "pedestrian"];
    const path = ["footway", "path", "cycleway", "track", "steps"];
    if (trunk.includes(tags.highway)) return { layer: "road_trunk" };
    if (major.includes(tags.highway)) return { layer: "road_major" };
    if (mid.includes(tags.highway)) return { layer: "road_mid" };
    if (minor.includes(tags.highway)) return { layer: "road_minor" };
    if (path.includes(tags.highway)) return { layer: "road_path" };
    return { layer: "road_mid" };
  }
  return null;
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

function formatCoords(lat, lon) {
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "E" : "O";
  return `${Math.abs(lat).toFixed(4)}°${latDir}  ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

const countryNames = new Intl.DisplayNames(["fr"], { type: "region" });

function formatCountry(isoCode) {
  if (!isoCode) return null;
  try {
    return countryNames.of(isoCode);
  } catch {
    return isoCode;
  }
}

function formatPopulation(pop) {
  if (!pop) return null;
  return `${pop.toLocaleString("fr-FR")} hab.`;
}

function buildSVG(elements, project, { width, height, label, radiusMeters }) {
  // Regroupe les éléments par couche, en pré-calculant le path SVG une seule fois.
  const layers = {
    water_area: [], water_line: [], park: [], rail: [],
    road_trunk: [], road_major: [], road_mid: [], road_minor: [], road_path: [],
  };
  for (const el of elements) {
    if (!el.geometry || el.geometry.length < 2) continue;
    const cls = classify(el.tags ?? {});
    if (!cls) continue;
    const points = el.geometry.map(({ lat, lon }) => project(lat, lon));
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    layers[cls.layer].push(d);
  }

  const line = (d, w, extra = "", color = "#000") =>
    `<path d="${d}" stroke="${color}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;

  // --- Couche eau : surfaces remplies en gris moyen (tiendra bien au dithering)
  const waterAreas = layers.water_area
    .map((d) => `<path d="${d} Z" fill="#9a9a9a" stroke="#000" stroke-width="1.4"/>`)
    .join("\n");
  const waterLines = layers.water_line.map((d) => line(d, 4.5, "", "#6e6e6e")).join("\n");

  // --- Parcs : hachures diagonales fines (pattern), tient mieux le 1-bit qu'un aplat léger
  const parks = layers.park
    .map((d) => `<path d="${d} Z" fill="url(#hatch)" stroke="#000" stroke-width="0.8" stroke-opacity="0.5"/>`)
    .join("\n");

  // --- Rails : trait plein + traverses (dasharray court perpendiculaire simulé
  //     par un second trait pointillé plus épais, style carte classique)
  const rails = layers.rail
    .map((d) => line(d, 2, "") + "\n" + line(d, 6, 'stroke-dasharray="2 26"'))
    .join("\n");

  // --- Routes majeures en "casing" : trait noir large dessous + trait blanc
  //     plus fin dessus = double-ligne façon gravure.
  const casing = (arr, outer, inner) =>
    arr.map((d) => line(d, outer)).join("\n") +
    "\n" +
    arr.map((d) => `<path d="${d}" stroke="#fff" stroke-width="${inner}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join("\n");

  const roadsTrunk = casing(layers.road_trunk, 7, 3.2);
  const roadsMajor = casing(layers.road_major, 5, 2.2);
  const roadsMid = layers.road_mid.map((d) => line(d, 2)).join("\n");
  const roadsMinor = layers.road_minor.map((d) => line(d, 1.1, 'stroke-opacity="0.75"')).join("\n");
  const roadsPath = layers.road_path.map((d) => line(d, 0.8, 'stroke-opacity="0.5" stroke-dasharray="4 5"')).join("\n");

  const cx = width / 2;
  const cy = height / 2;
  // uw = "largeur de référence" indexée sur la hauteur (équivaut à l'ancienne
  // largeur 4:3). Toutes les tailles UI (marqueur, boussole, textes) restent
  // ainsi identiques malgré le passage du canvas en 5:3.
  const uw = (Math.min(width, height) * 4) / 3;
  // Marge élargie (5% vs 3.5% avant) : c'est la bande où le dessin continue
  // au-delà du cadre avant de s'évanouir vers les bords du canvas.
  const margin = Math.round(uw * 0.05);

  // Marqueur discret au point exact du tirage.
  const marker = `
    <g stroke="#000" fill="none" stroke-width="${uw * 0.0016}">
      <circle cx="${cx}" cy="${cy}" r="${uw * 0.009}" fill="#fff" fill-opacity="0.7"/>
      <circle cx="${cx}" cy="${cy}" r="${uw * 0.002}" fill="#000" stroke="none"/>
    </g>`;

  // Flèche de nord, coin haut-droit.
  const northSize = uw * 0.02;
  const northX = width - margin - 40;
  const northY = margin + 60;
  const north = `
    <g transform="translate(${northX}, ${northY})" stroke="#000" stroke-width="${uw * 0.0012}" fill="#000">
      <line x1="0" y1="${northSize}" x2="0" y2="-${northSize}"/>
      <path d="M 0 ${-northSize} L ${northSize * 0.35} ${-northSize * 0.35} L 0 ${-northSize * 0.6} L ${-northSize * 0.35} ${-northSize * 0.35} Z"/>
      <text x="0" y="${northSize + 22}" text-anchor="middle" font-family="Georgia, serif" font-size="${uw * 0.012}">N</text>
    </g>`;

  // Barre d'échelle : segment gradué en bas-gauche. On connaît l'échelle
  // exacte : le SVG couvre 2*radiusMeters sur min(width,height).
  const pxPerMeter = Math.min(width, height) / (radiusMeters * 2);
  const niceScaleMeters = [100, 200, 250, 500, 1000].reduce((best, m) =>
    Math.abs(m * pxPerMeter - uw * 0.12) < Math.abs(best * pxPerMeter - uw * 0.12) ? m : best
  );
  const scalePx = niceScaleMeters * pxPerMeter;
  const scaleX = margin + 40;
  const scaleY = height - margin - 40;
  const scaleLabel = niceScaleMeters >= 1000 ? `${niceScaleMeters / 1000} km` : `${niceScaleMeters} m`;
  const scaleBar = `
    <g stroke="#000" stroke-width="${uw * 0.0012}" fill="#000" font-family="Georgia, serif">
      <line x1="${scaleX}" y1="${scaleY}" x2="${scaleX + scalePx}" y2="${scaleY}"/>
      <line x1="${scaleX}" y1="${scaleY - 7}" x2="${scaleX}" y2="${scaleY + 7}"/>
      <line x1="${scaleX + scalePx / 2}" y1="${scaleY - 4}" x2="${scaleX + scalePx / 2}" y2="${scaleY + 4}"/>
      <line x1="${scaleX + scalePx}" y1="${scaleY - 7}" x2="${scaleX + scalePx}" y2="${scaleY + 7}"/>
      <text x="${scaleX + scalePx / 2}" y="${scaleY - 14}" text-anchor="middle" font-size="${uw * 0.011}" stroke="none">${scaleLabel}</text>
    </g>`;

  const subtitleParts = [label?.country, label?.population].filter(Boolean);
  const subtitle = subtitleParts.join("  ·  ");

  const caption = label
    ? `<g text-anchor="middle" font-family="Georgia, serif" fill="#000">
        <line x1="${cx - 100}" y1="${height - margin - 100}" x2="${cx + 100}" y2="${height - margin - 100}" stroke="#000" stroke-width="1.5"/>
        <text x="${cx}" y="${height - margin - 62}" font-size="${uw * 0.021}" letter-spacing="1">${escapeXml(label.name)}</text>
        ${subtitle ? `<text x="${cx}" y="${height - margin - 34}" font-size="${uw * 0.013}" opacity="0.85">${escapeXml(subtitle)}</text>` : ""}
        <text x="${cx}" y="${height - margin - 6}" font-size="${uw * 0.011}" opacity="0.65">${escapeXml(label.coords)}</text>
      </g>`
    : "";

  // ─── Continuation hors cadre ───
  // La géométrie est définie UNE fois (defs > #mapart) puis dessinée deux fois :
  //  1. couche extérieure : visible uniquement HORS du cadre (le rect noir du
  //     mask occulte l'intérieur), pleine intensité au ras du cadre puis fondu
  //     linéaire vers le blanc sur la bande de marge, sur les 4 côtés — le
  //     dessin "passe sous le cadre" et se dissout aux bords du canvas.
  //  2. couche intérieure : clippée à l'intérieur du cadre, pleine intensité.
  // Le rect du clipPath et le rect noir du mask sont IDENTIQUES → continuité
  // parfaite au niveau du trait du cadre, aucune zone dessinée deux fois.
  // Remplace l'ancienne vignette radiale (le fondu périphérique est désormais
  // porté par le mask). Le double xlink:href + href sur <use> est volontaire :
  // les librsvg un peu anciens (runners CI) ne connaissent que la forme xlink.
  const frameX = margin;
  const frameY = margin;
  const frameW = width - margin * 2;
  const frameH = height - margin * 2;

  const edgeFade = `
    <linearGradient id="fadeL" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fadeR" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fadeT" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fadeB" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <mask id="edge-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#fff"/>
      <rect x="0" y="0" width="${margin}" height="${height}" fill="url(#fadeL)"/>
      <rect x="${width - margin}" y="0" width="${margin}" height="${height}" fill="url(#fadeR)"/>
      <rect x="0" y="0" width="${width}" height="${margin}" fill="url(#fadeT)"/>
      <rect x="0" y="${height - margin}" width="${width}" height="${margin}" fill="url(#fadeB)"/>
      <rect x="${frameX}" y="${frameY}" width="${frameW}" height="${frameH}" fill="#000"/>
    </mask>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="hatch" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="9" stroke="#000" stroke-width="0.9" stroke-opacity="0.4"/>
    </pattern>
    <g id="mapart">
      ${waterAreas}
      ${parks}
      ${waterLines}
      ${rails}
      ${roadsMinor}
      ${roadsPath}
      ${roadsMid}
      ${roadsTrunk}
      ${roadsMajor}
    </g>
    <clipPath id="frame-clip">
      <rect x="${frameX}" y="${frameY}" width="${frameW}" height="${frameH}"/>
    </clipPath>
    ${edgeFade}
  </defs>
  <rect width="100%" height="100%" fill="#fff"/>
  <g mask="url(#edge-fade)">
    <use xlink:href="#mapart" href="#mapart"/>
  </g>
  <g clip-path="url(#frame-clip)">
    <use xlink:href="#mapart" href="#mapart"/>
    ${marker}
  </g>
  ${north}
  ${scaleBar}
  <rect x="${frameX}" y="${frameY}" width="${frameW}" height="${frameH}" fill="none" stroke="#000" stroke-width="2" stroke-opacity="0.7"/>
  <rect x="${frameX + 8}" y="${frameY + 8}" width="${frameW - 16}" height="${frameH - 16}" fill="none" stroke="#000" stroke-width="1" stroke-opacity="0.4"/>
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
    .resize(width, height, { fit: "contain", background: "#ffffff" })
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
  const countryName = formatCountry(location.country);
  const populationLabel = formatPopulation(location.population);
  const coordsLabel = formatCoords(location.lat, location.lon);
  const meta = {
    location: location.name,
    country: countryName,
    population: location.population,
    population_label: populationLabel,
    coords_label: coordsLabel,
    lat: location.lat,
    lon: location.lon,
    generated_at: new Date().toISOString(),
  };
  // Pas de légende texte dans le SVG lui-même : à résolution fixe (1872x1404),
  // le texte devient illisible une fois écrasé pour rentrer dans les 480px de
  // hauteur de l'OG, puis massacré par le dithering 1-bit. La légende est
  // affichée en HTML natif par-dessus l'image côté template Liquid à la place
  // (texte net sur OG comme sur X, quelle que soit la résolution finale).
  const svg = buildSVG(elements, project, {
    width: SVG_WIDTH,
    height: SVG_HEIGHT,
    label: null,
    radiusMeters: RADIUS_METERS,
  });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, "map.svg"), svg, "utf-8");
  await fs.writeFile(path.join(OUTPUT_DIR, "data.json"), JSON.stringify({ ...meta, svg_url: `${PAGES_BASE_URL}/map.svg` }, null, 2));

  const ogPng = await renderEinkPNG(svg, 800, 480, 2);
  const xPng = await renderEinkPNG(svg, 936, 702, 16); // demi-résolution pour un preview plus léger
  await fs.writeFile(path.join(OUTPUT_DIR, "preview-og.png"), ogPng);
  await fs.writeFile(path.join(OUTPUT_DIR, "preview-x.png"), xPng);

  const preview = buildPreviewHTML(meta, ogPng.toString("base64"), xPng.toString("base64"));
  await fs.writeFile(path.join(OUTPUT_DIR, "preview.html"), preview, "utf-8");

  console.log(`OK — ${location.name}, preview: preview.html (+ preview-og.png / preview-x.png)`);
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
