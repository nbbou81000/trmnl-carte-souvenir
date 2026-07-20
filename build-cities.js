/**
 * build-cities.js
 * À lancer ponctuellement (pas dans le cron TRMNL) pour régénérer data/cities.json
 * depuis le dump officiel GeoNames. Licence GeoNames : CC-BY 4.0 (attribution requise
 * si tu republies le dataset brut — mentionne "Data © GeoNames.org, CC-BY 4.0").
 *
 * Usage : node build-cities.js
 */

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const DUMP_URL = "http://download.geonames.org/export/dump/cities15000.zip"; // villes > 15 000 hab, ~34k entrées
const ZIP_PATH = "./cities15000.zip";
const TXT_PATH = "./cities15000.txt";
const OUT_PATH = "./data/cities.json";

async function download() {
  const res = await fetch(DUMP_URL);
  if (!res.ok) throw new Error(`Téléchargement échoué: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(ZIP_PATH));
}

async function unzip() {
  // Dépend de `unzip` disponible sur le système (present sur la plupart des runners CI/Linux).
  const { execSync } = await import("node:child_process");
  execSync(`unzip -o ${ZIP_PATH}`);
}

async function convert() {
  const raw = await fs.readFile(TXT_PATH, "utf-8");
  const rows = raw
    .trim()
    .split("\n")
    .map((line) => {
      const cols = line.split("\t");
      return [
        cols[1], // name
        cols[8], // country code ISO
        parseFloat(cols[4]), // lat
        parseFloat(cols[5]), // lon
        parseInt(cols[14], 10) || 0, // population
      ];
    });

  await fs.mkdir("./data", { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(rows));
  console.log(`${rows.length} villes écrites dans ${OUT_PATH}`);
}

async function cleanup() {
  await fs.rm(ZIP_PATH, { force: true });
  await fs.rm(TXT_PATH, { force: true });
}

async function main() {
  console.log("Téléchargement du dump GeoNames...");
  await download();
  console.log("Extraction...");
  await unzip();
  console.log("Conversion en JSON compact...");
  await convert();
  await cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
