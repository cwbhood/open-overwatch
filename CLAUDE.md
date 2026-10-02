# Open Overwatch

Single-page live situation map (aircraft, satellites, ships, quakes, storms, cameras, news, …) built on
Leaflet 1.9.4 + satellite.js 5.0.0 from CDNs. No build step, no dependencies.

## Files
- `index.html` — the landing page (GitHub Pages root). Hero clip/stills from brand/tools/lander_hero.py, feature icons
  from brand/tools/feature_icons.py, phone clips from the capture footage; live ISS (wheretheiss.at) + USGS in the hero.
- `open-overwatch.html` — the entire app: CSS (18-335), HTML skeleton (337-406), one inline script (408-2093).
  Lines 409-410 are giant data tables (COUNTRY, COUNTRY_ALIAS); don't read them in full.
- `globe.html` — PROTOTYPE 3D view on CesiumJS 1.146 (CDN): space to street, Moon, ~10k satellites (SGP4 in a worker),
  OpenSky + adsb.lol mil aircraft, USGS quakes. Lessons: 4x MSAA and a single 8k imagery texture both broke globe
  rendering; city lights are a tile pyramid (brand/textures/night, made by brand/tools/make_night.py) shown only above
  300 km, where sun shading is on; ground atmosphere hides night lights, so it is off.
- `serve.js` / `serve.py` — twin local helpers: serve the folder on http://127.0.0.1:8787 and relay an https host
  allowlist at `/proxy?url=…` for sources that send no CORS header. Keep the two in sync.
- `Start Open Overwatch.bat` / `.vbs` — Windows launchers.
- `brand/` — brand + promo pack (3D emblem, globe hero, share images, TikTok promo video) and the scripts that
  rebuild it; see brand/README.md. The start screen's `.splash-globe` and the favicon/apple-touch-icon/og tags use it.
- `notes/review-2026-10-01.json` — full multi-agent review: per-subsystem summaries, key functions, extension
  notes, verified issues (with line numbers) and a feed-liveness check of every external endpoint.

## Publishing
Repo github.com/cwbhood/open-overwatch (public); Pages serves `main` root at https://cwbhood.github.io/open-overwatch/.
`Publish Update.bat` bumps OW_VERSION, commits, tags vX and pushes; .github/workflows/release.yml then builds
`open-overwatch.zip` (the download the lander links to via releases/latest/download). Keep the zip file list in that
workflow in sync when the app starts needing new files. gh CLI (portable): ~/bin/gh-cli/bin/gh.exe.

## Running
Preview config `open-overwatch` in `.claude/launch.json` (starts serve.js without popping the user's browser).
Then open http://localhost:8787/open-overwatch.html. On the boot screen, "Enter silent" skips audio.

## Script sections (line numbers drift as the file changes)
helpers 413 · store 452 · log/toast 459 · network+relay 490 · map 541 · canvas renderer (Glyphs.draw) 589 ·
layer registry 724 · feed scheduler 776 · detail panel 801 · tabs 840 · AIRCRAFT 851 ·
SATELLITES 1091 · point/vector layers 1246 · PRESETS 1583 · BRIEF 1644 · AUDIO 1759 · SETUP 1927 · SEARCH 2029 · INIT 2046

## Adding a layer (the contract the code enforces)
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

## Status as of 2026-10-01 (from the review)
Broken/stale feeds: RainViewer IR satellite (discontinued), RainViewer radar maxNativeZoom 12 (real limit is lower),
submarine cables (GitHub mirror is stale; the live TeleGeography fallback isn't relayed), GDACS only shows ~1-2 days
(100-result cap), 3 of 5 radio-browser hosts gone, GDELT flaky. GDELT now sends CORS headers (could skip the relay).
Top fixes: unescaped HTML in detail panels (SondeHub uploader_callsign = XSS path), header overlap below ~1500px,
satellite failures shown as green "ok", emergency squawk alert missed for aircraft already in view.
Agreed plan: foundation pass first (feeds + top bugs + git), then a small layer helper, then new features.

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
