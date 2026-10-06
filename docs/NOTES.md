# Notes and hard-won lessons

Detail that used to live in CLAUDE.md. Read the section you need before touching that part.

## Files and per-view lessons
- `index.html` — the landing page (GitHub Pages root). Hero clip/stills from brand/tools/lander_hero.py, feature icons
  from brand/tools/feature_icons.py, phone clips from the capture footage; live ISS (wheretheiss.at) + USGS in the hero.
- `open-overwatch.html` — the 2D map's markup and styles; its code is ES modules in src/map/ (see below).
  Lines 417-418 are giant data tables (COUNTRY, COUNTRY_ALIAS); don't read them in full.
- `globe.html` — 3D view on CesiumJS 1.146 (CDN), needs the helper. Satellites: CelesTrak TLEs (Cache Storage, 2 h),
  SGP4 in a worker for the dots; the nearest 40 within 4,000 km get glTF models (brand/models/*.glb, Blender-built,
  +X ram / +Z zenith / solar_* nodes rotate about Y toward the sun), exact SGP4 per frame keyed to the Cesium clock.
  Objects within 5 km of the ISS/CSS are "docked" (no model, no dot). Aircraft: OpenSky snapshot (15 min) + adsb.lol mil,
  dead-reckoned up to 15 min; the nearest 200 within 300 km (camera < 600 km) get models (brand/models/aircraft) with
  heading, pitch from vertical rate and bank from turn rate. Follow camera = own preUpdate re-centring (Cesium's
  trackedEntity lags a tick ≈ 115 m at orbital speed). Lessons: 4x MSAA and one 8k single-tile imagery texture broke
  globe rendering; city lights are a tile pyramid shown only above 300 km (where sun shading is on); ground atmosphere
  hides night lights so it is off; below 300 km the scene light is an overhead fill (globe unlit there anyway);
  satellites in Earth's shadow get a CustomShader ambient term. A hidden Browser pane runs 0 fps: drive frames with
  viewer.render() when testing. MODEL_FIX = -90° about Z undoes Cesium's glTF forward-axis turn.
  Earth look (the `Earth` block): NASA GIBS Blue Marble NG (day, far, kept down to ~150 km) over Esri imagery (near), GIBS VIIRS Black Marble
  (night, gamma 0.4 then brightness, compensated for the lighting fade), ground atmosphere ON with nightFadeOut=1 /
  nightFadeIn=0 (else the night side turns black), lightingFade at R+20 km / R+200 km, no HDR (washes night purple).
  Two EllipsoidGeometry shells read brand/textures/earth_fx_*.jpg (make_earth_fx.py; rolled 180° because the shell's st
  starts at lon 0): glint + cloud shadows (premultiplied blend; needs orderIndependentTranslucency:false AND an
  appearance.getRenderState override, Cesium otherwise forces ALPHA_BLEND) plus open-ocean blue over Esri's seafloor
  shading; the GIBS layers use the EPSG:4326 set (pole to pole; 512 px tiles, 288° level 0) — don't paint polar caps,
  GlobeFS's day/night + ground atmosphere can't be matched by hand; clouds 9 km up (procedural detail + relief, dissolve below 250 km); a limb shell at
  115 km (additive; tangent-height layers: day blue, sunset bands, airglow). Shells need compressVertices:false. Cloud
  noise needs a float-safe hash (the classic fract(p*p*p) one makes zigzags at Earth-scale coordinates). Look-dev:
  render with brand/tools/globe_shot.mjs (headless Edge on the RTX GPU) — the Browser pane can't screenshot when the
  app is hidden. Pin the clock (clockStep TICK_DEPENDENT, multiplier 0) for repeatable lighting.
  Stars: NASA SVS Deep Star Maps 2020 cube faces (brand/textures/sky, sky_1k for phones) from make_skybox.py (EXR
  decoded by headless Blender via exr_dump.py; source EXR is gitignored). Cesium.SkyBox reads each face vertically
  flipped vs the OpenGL convention (verified with direction-coded faces; star positions checked against Orion/Sgr).
  camera.setView({orientation:{direction, up}}) far out in space can come back upside down; check camera.upWC.
  TLEs: the website build mirrors every CelesTrak group the apps use to /data/tle/<group>.txt (build_site.py; the Website
  workflow also runs every 6 h). Both apps read that copy first on cwbhood.github.io and fall back to it elsewhere.
  CelesTrak firewalled this PC's network on 2026-10-01 after many headless renders (fresh profile = no cache each run);
  globe_shot.mjs now blocks the live feed hosts. Never point automated runs at CelesTrak.
- `solar.html` — Solar System → Local Group view on Three.js 0.186 (importmap, CDN), one scene in AU with a log depth
  buffer; camera rides along with the focused body. Planets: JPL approximate elements (1800-2050) + IAU rotation models;
  textures brand/textures/planets (make_planet_textures.py, Solar System Scope CC BY 4.0). Small bodies: data/solar/
  asteroids_a.bin (brightest 300k; phones load only this) + asteroids_b.bin (rest, 1.57M total) + small_bodies.json
  (named, comets) from make_small_bodies.py (JPL SBDB); Kepler is solved per point in the vertex shader (15-byte
  records, see the script). Stars: data/solar/stars.bin (HYG v4.1, CC BY-SA) via make_stars.py; spacecraft:
  data/solar/spacecraft.json (JPL Horizons) via make_spacecraft.py. Sky: brand/textures/sky_equirect*.jpg sampled by
  direction in a shader (no cube-map conventions). Milky Way: NASA/JPL-Caltech R. Hurt top-down image on the galactic
  plane (115,000 ly square, Sun 26,000 ly from the centre). Big assets load relative first, then from the site root, so
  /v/<tag>/ copies only carry solar.html itself. window.OOSS is the console handle; globe_shot.mjs renders it with
  OO_URL=http://localhost:8787/solar.html.
- `serve.js` / `serve.py` — twin local helpers: serve the folder on http://127.0.0.1:8787 and relay an https host
  allowlist at `/proxy?url=…` for sources that send no CORS header. Keep the two in sync.
- `Start Open Overwatch.bat` / `.vbs` — Windows launchers.
- `brand/` — brand + promo pack (3D emblem, globe hero, share images, TikTok promo video) and the scripts that
  rebuild it; see brand/README.md. The start screen's `.splash-globe` and the favicon/apple-touch-icon/og tags use it.
- `notes/review-2026-10-01.json` — full multi-agent review: per-subsystem summaries, key functions, extension
  notes, verified issues (with line numbers) and a feed-liveness check of every external endpoint.

## Publishing
Repo github.com/cwbhood/open-overwatch (public); site https://cwbhood.github.io/open-overwatch/, built by the "Website"
workflow (.github/workflows/pages.yml -> .github/build_site.py): main at the root, every annotated v* tag frozen under
/v/<tag>/, and versions.json for the landing page's version picker and history (#launch). The /v/<tag>/ copies only
contain build_site.py's APP_PATHS: add every new runtime asset there (the Launch button opens /v/<latest>/), or
the archived app 404s on it (v0.7-v0.8 globe crashed that way until v0.8.1). Each archived version costs
~25 MB of the 1 GB Pages limit.
Mirrors are best effort, and a failed refresh must never take the previous copy down: on 2026-10-06 06:28 UTC the
scheduled build timed out on every CelesTrak group (90 s each, a 36-minute build that still "succeeded"), deployed with
an empty data/tle/, and the live globe fell back to CelesTrak directly for every visitor until the next build.
build_site.py now keeps the live site's copy of any feed it cannot refresh (last_good / keep_last), stops waiting on
CelesTrak after the first timeout, and index.json lists the groups it `kept`.
`Publish Update.bat` bumps OW_VERSION, commits, tags vX and pushes; .github/workflows/release.yml then builds
`open-overwatch.zip` (the download the lander links to via releases/latest/download). Keep the zip file list in that
workflow in sync when the app starts needing new files. gh CLI (portable): ~/bin/gh-cli/bin/gh.exe.

### Search and sharing (SEO)
`index.html`, `about.html` and the three app pages each carry a title, description, canonical URL, Open Graph and Twitter tags; the landing and About
pages also carry JSON-LD (`WebSite`, `SoftwareApplication`, `Person` with `sameAs` links to GitHub and Ironbound). `robots.txt` keeps the archived `/v/<tag>/`
copies and `/data/` out of search results and points at `sitemap.xml`: bump its `lastmod` when a release changes a page. `CITATION.cff` gives GitHub's
"Cite this repository" button; `LICENSE` (MIT) covers the code only, the data keeps its own licences (docs/DATA_SOURCES.md). The portrait is
`brand/about/destin-*.webp` (cropped from the owner's own photo).

## 2D map: modules (src/map/)
util (helpers, Store, Log/toast/Sound, Net + Relay, clock; `late` registry) · mapview (Leaflet map, base maps, Sun) ·
engine (Glyphs canvas renderer, Points, Layers registry + panel, feed scheduler) · detail (Detail panel, tracks, hover,
tabs/sheets) · aircraft · satellites (TLEs via src/core/tle.js) · feeds (all point/vector layers) · presets (views,
legend, Locate, Fun/ISS follow) · brief (Brief, Welcome) · audio · setup (Setup tab, Probe, search) · main (INIT, OW).
Modules import only from earlier ones; the five names used before they are defined (Sats, cableHit, Probe, Brief, Keys)
are read through `late.X`. OW_VERSION stays a classic <script> const in the HTML (Publish Update.bat edits that line).
A hidden tab pauses feeds by design: drive them with OW.Sats.reload() etc. when testing in a background pane.

## 2D map: adding a layer (the contract the code enforces)
1. `Layers.add({id, group, name, desc, color, default, points})` before INIT. `group` must be one of `UI.groups`
   or it never shows; keep `id` to `[a-z0-9_]`; `points` must equal the Points set id.
2. `Points.define(setId, ly.id, {minZoom})`, then `Points.set(setId, items)` in the fetch. Item colors must be `#hex`.
3. `feed(ly, {interval, fetch: async () => {...}, viewDependent?, minZoom?})`. The fetch must THROW on failure,
   set `ly.feed.count` itself, and must not set `ly.feed.status` / `nextAt` (runFeed overwrites them).
   Use `Net.json` / `Net.text` for every request.
4. `Detail.renderers[kind] = obj => html`. **Escape every upstream string with `esc()`** — `Detail.kv` values and
   the `Detail.head` sub-argument go into innerHTML raw. Check link schemes with `isHttp()`.
5. CORS-blocked source: add the host to `NEEDS_RELAY` in the html AND `ALLOWED_HOSTS` in serve.js AND serve.py.
Moving-object types (like aircraft/ships) have no generic path: they need a hand-written branch in Glyphs.draw.
A top-level exception anywhere aborts INIT, so test every new layer in the browser.

## Feed status as of 2026-10-02
The 2026-10-01 review's confirmed issues (notes/review-2026-10-01.json) were worked through on 2026-10-02: all fixed
except the antimeridian handling for point layers (design change) and a separate static-layer canvas (refactor).
Feeds now: IR clouds = NASA GIBS band-13 clean IR from GOES-East/West + Himawari (no Meteosat: no Europe/Africa);
RainViewer radar maxNativeZoom 7; submarine cables live from submarinecablemap.com via the helper (GitHub copy as
fallback); GDACS paged (up to 1000 events); radio-browser hosts all/de1/de2; GDELT not relayed (rate-limit replies
arrive without CORS and are reported as such); airplanes.live only when picked (403 without permission); CelesTrak
`noaa` group gone (in `weather`), `last-30-days` often has no TLE-format data (new catalog numbers outgrow TLE).
Helpers (serve.js/serve.py) are locked down: Host check, /proxy only for the helper's own pages, no ACAO, each
redirect hop re-checked against the allowlist. Keep their allowlists = NEEDS_RELAY (+ old hosts for archived pages).

## Blender (for 3D assets)
- Production renders run HEADLESS via the launcher (blocks, returns the exit code, but stdout is lost: log to files).
  Shared helpers: brand/tools/bl_common.py (5.2 compositor/VSE API notes inside). AgX whitens strong emission; the
  video encode uses the Standard view transform so footage colours pass through.
- The Store build is sandboxed: its writes under %LOCALAPPDATA% land in
  %LOCALAPPDATA%\Packages\BlenderFoundation.Blender_ppwjx1n5r4v9t\LocalCache\Local\…; use a work dir outside AppData
  (lander_hero.py uses ~/open-overwatch-work).
- Blender 5.2.2 is the Microsoft Store build. `blender.exe` can't be launched directly (Access denied);
  use the alias `%LOCALAPPDATA%\Microsoft\WindowsApps\blender-launcher.exe` (e.g. `-b --python-expr "…"`).
- The Blender Lab "MCP" add-on (v1.0.3) is installed and enabled, with online access on. With Blender open it
  listens on 127.0.0.1:9876; the Claude "Blender" desktop extension connects to it.
- The map is 2D, so 3D work goes in as pre-rendered icons/sprites, branding/promo renders, or a separate
  3D globe view (Three.js/CesiumJS + .glb models).
