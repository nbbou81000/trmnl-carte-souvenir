# Souvenir Map

A [TRMNL](https://usetrmnl.com) plugin that draws a random corner of the world on your e-ink display — a minimalist cartographic poster, regenerated automatically, revealing a new city every time.

**🌍 [Explore the Atlas](https://nbbou81000.github.io/trmnl-carte-souvenir/atlas.html)** — an interactive 3D globe and 2D map of every city the plugin has ever drawn, with detailed travel statistics.

---

## What it does

Every 30 minutes, a random populated place is picked somewhere on Earth. Its street network, waterways, railways and parks are pulled from OpenStreetMap and rendered as a clean line-art map, framed like a printed poster: a double border, a compass rose, a scale bar, and a discreet marker at the exact coordinates of the draw.

The drawing doesn't stop at the frame. It continues past it and fades gently towards the edges of the canvas, so the map reads as a fragment of a much larger world rather than a cropped rectangle.

Two orientations are generated from the same data — landscape and portrait — and the plugin markup picks whichever matches how your device is currently mounted.

---

## How it works

```
cron-job.org  ──POST──▶  GitHub Actions  ──▶  fetch-map.js
   (every 30 min)          (workflow_dispatch)      │
                                                    ├─▶ Overpass API (OpenStreetMap)
                                                    │
                                                    ▼
                                        map.svg + map-portrait.svg
                                        data.json + history.json
                                                    │
                                                    ▼
                                            GitHub Pages
                                              │        │
                                              ▼        ▼
                                        TRMNL device   atlas.html
```

1. **cron-job.org** fires a `workflow_dispatch` call to the GitHub API on a precise schedule. This replaces GitHub's native `schedule:` cron, which is best-effort and can drift by one to two hours under load.
2. **GitHub Actions** runs `fetch-map.js`, which picks a city, queries an Overpass mirror, checks the area is dense enough to be worth drawing (and retries elsewhere if not), and renders both SVG orientations.
3. **GitHub Pages** serves the results as static files.
4. **The TRMNL device** polls `data.json` at its own refresh rate and displays the matching image.

### Why an external cron?

GitHub schedules all `cron:` workflows through a shared queue and prioritises paid traffic, so runs regularly arrive well behind schedule. A `workflow_dispatch` call from an external scheduler executes immediately, which keeps generation times predictable.

---

## Files

| File | Role |
|---|---|
| `fetch-map.js` | Generation script: city draw, Overpass query, SVG rendering, history persistence |
| `.github/workflows/generate.yml` | GitHub Actions workflow (triggered externally via `workflow_dispatch`) |
| `atlas.html` | Standalone interactive atlas page (3D globe, 2D map, statistics) |
| `data.json` | Current city — the file the TRMNL device polls |
| `history.json` | Cumulative log of every city ever drawn — powers the atlas |
| `map.svg` / `map-portrait.svg` | Current map, landscape and portrait |
| `preview.html`, `preview-og.png`, `preview-x.png` | Local previews for both device generations |

### `data.json` schema

```json
{
  "location": "Onalaska",
  "country": "United States",
  "population": 18468,
  "population_label": "18,468 inhab.",
  "coords_label": "43.8842°N  91.2277°W",
  "lat": 43.8842,
  "lon": -91.2277,
  "generated_at": "2026-07-29T09:45:28.451Z",
  "svg_url": "https://nbbou81000.github.io/trmnl-carte-souvenir/map.svg",
  "svg_url_portrait": "https://nbbou81000.github.io/trmnl-carte-souvenir/map-portrait.svg"
}
```

`history.json` is an array of the same records minus the SVG URLs, appended to on every run. It grows by roughly 150–200 bytes per generation.

---

## Plugin markup

Both image variants live in the markup; CSS decides which one is actually shown, based on the device's orientation:

```liquid
<div class="layout layout--stretch">
  {% if svg_url %}
    <div class="hidden landscape:visible w--full h--full">
      <img class="image image--contain image-dither w--full h--full" src="{{ svg_url }}">
    </div>
  {% endif %}
  {% if svg_url_portrait %}
    <div class="hidden portrait:visible w--full h--full">
      <img class="image image--contain image-dither w--full h--full" src="{{ svg_url_portrait }}">
    </div>
  {% endif %}
</div>
```

Note the bare `landscape:` / `portrait:` modifiers rather than `lg:landscape:`. The `lg:` breakpoint is a **width** threshold that the TRMNL OG (800px) falls below, so gating on it would leave the OG showing nothing at all. Orientation alone is the right signal here, independent of screen size.

"Remove bleed margins" is enabled in the plugin settings, since the map already carries its own edge fade.

---

## The Atlas

**→ [nbbou81000.github.io/trmnl-carte-souvenir/atlas.html](https://nbbou81000.github.io/trmnl-carte-souvenir/atlas.html)**

A single self-contained HTML page, no build step, reading directly from `data.json` and `history.json`.

**3D globe** — realistic Earth texture with a specular map, drag to rotate, wheel to zoom. Past cities appear as red dots on white rims; the city currently on the display is marked by a pulsing gold beacon, and the globe auto-orients to face it on load. A trail links the cities in chronological order.

**2D map** — Leaflet with OpenStreetMap tiles, free zoom down to street level, popups on every marker.

**Statistics panel** — cumulative distance travelled (with equivalents in trips around the Earth and percentage of the Earth–Moon distance), longest and shortest hops, northernmost/southernmost/easternmost/westernmost records, hemisphere and climate-zone distribution, population statistics with quartiles, city typology from villages to megacities, and share of world population "visited" — alongside six charts: population distribution, city typology, population by latitude, cumulative inhabitants, generations per day, and cumulative distance.

Click the thumbnail in the bottom-left corner to view the current map full size.

---

## Running it yourself

1. Fork the repo and enable GitHub Pages (Settings → Pages → deploy from branch).
2. Update `PAGES_BASE_URL` in `fetch-map.js` and the two URLs at the top of the `atlas.html` script block to point at your own Pages domain.
3. Create a fine-grained GitHub token with **Actions: read and write** scoped to the repo.
4. Set up a scheduler (cron-job.org or equivalent) with:
   - **URL** `https://api.github.com/repos/<user>/<repo>/actions/workflows/generate.yml/dispatches`
   - **Method** `POST`
   - **Headers** `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`
   - **Body** `{"ref":"main"}`

   A successful call returns `204 No Content`.
5. Trigger a first run manually and check that `data.json` and `history.json` appear in the repo.

### Local run

```bash
npm install
npm run generate
```

Outputs land in the repo root, with `preview.html` showing how the result renders on both device generations.

---

## Technical notes

**Overpass fetch radius.** The frame covers a 900 m radius, but the fetch reaches ~1,755 m — the canvas half-diagonal — so geometry exists all the way into the corners for the edge fade. Same radius in both orientations, since swapping width and height doesn't change the diagonal, which is why the portrait variant costs no extra network request.

**Single geometry, drawn twice.** The map is defined once inside `<defs>` and rendered through two `<use>` elements: one masked to fade outside the frame, one clipped to full strength inside it. The clip rect and the mask rect are identical, so the drawing passes under the frame border with no seam and nothing is drawn twice.

**Density check.** A draw is rejected and retried if the central 900 m contains too few roads — measured on the centre only, so a deserted core ringed by distant suburbs doesn't slip through.

**Mirror fallback.** Overpass requests rotate through several public mirrors with per-mirror timeouts, since any single one can be slow or briefly unavailable.

---

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, queried via the [Overpass API](https://overpass-api.de/).

Built with [three.js](https://threejs.org), [Leaflet](https://leafletjs.com), [Chart.js](https://www.chartjs.org) and [sharp](https://sharp.pixelplumbing.com). Earth textures from the three.js examples.

Thanks to the TRMNL team for the recipe review.
