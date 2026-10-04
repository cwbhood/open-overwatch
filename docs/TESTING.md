# Testing

## Unit tests
`node --test` from the repo root: the maths in `src/core/` against JPL Horizons fixtures and textbook identities, the country lookup (`core/borders.js`: cities land in their countries, ocean is nobody's, every border has facts) and the share-link format (`core/viewlink.js`: round trip, bad links refused)
(no dependencies). CI runs them on every push, plus a syntax check of every module and a link check of every page.

## In the browser (needs `node serve.js` on :8787)
| Tool | What it does |
|---|---|
| `brand/tools/perf.mjs` | load size, still and moving frame rates, desktop and an emulated phone |
| `brand/tools/zoomtest.mjs` | real wheel events from Earth through the hand-off to the stars and back, frame by frame |
| `brand/tools/mobile_journey.mjs` | a first visit A to Z on a phone: landing, globe, Solar System, 2D map, with touch, screenshots and a layout audit |
| `brand/tools/webkit_journey.mjs` | the same journey in Safari's engine (Playwright WebKit) with an iPhone 15 profile |
| `brand/tools/wind_fixture.mjs` | a made-up wind grid the journeys serve as `data/wind.json` (and they block Open-Meteo: its per-IP hourly quota) |
| `brand/tools/android_features.mjs` | the newer globe features on the Android emulator, by touch: tap a country, the Explore sheet and Weather panel fit, the tour starts and a touch stops it, a shared link restores the view; screenshots in `brand/perf/android-features/` |
| `brand/tools/android_profile.mjs` | one gesture on the Android emulator with the JavaScript profiler on: `map`, `mapspace`, `mappinch`, `mapspacepinch`, `handoff`, `weather`; `OO_CSS='…'` A/B tests a style, `OO_CALLERS='regex'` prints who calls a slow native function |

All of them block the live feeds that must never see automated traffic (CelesTrak above all).

## Phones without phones
**Android: Google's emulator, driving real Chrome.** This is installed under your user profile, with no admin rights:
- Android SDK in `%LOCALAPPDATA%\Android\Sdk`;
- portable OpenJDK 17 in `%USERPROFILE%\tools\jdk17`;
- a virtual Pixel 8 called `OO_Pixel8`, running Android 15 with Google Play and 4 GB RAM.

```bash
"$LOCALAPPDATA/Android/Sdk/emulator/emulator.exe" -avd OO_Pixel8 -gpu host -no-snapshot-save -no-boot-anim
```
Once it has booted, open Chrome on it (the journey re-makes these links itself if adb drops them):
```bash
adb shell am start -a android.intent.action.VIEW -d http://localhost:8787/index.html com.android.chrome
adb reverse tcp:8787 tcp:8787                                   # the phone's localhost:8787 = this PC's server
adb forward tcp:9333 localabstract:chrome_devtools_remote       # DevTools into the phone's Chrome
```
Then run the journey:
```bash
OO_ANDROID=1 node brand/tools/mobile_journey.mjs                # screenshots in brand/perf/android/
```
Things to know about the emulator:
- **Secure context:** `localhost` on the phone is a secure context, so location and motion sensors work. In the
  emulator window, the "…" menu → Virtual sensors / Location moves them, which is how to try Look up.
- **Screenshots** come from `adb exec-out screencap`. Big DevTools screenshots of a WebGL page reset the adb link.
- **A fresh image** spends its first minutes updating Google Play Services. Each crash of Play Services takes Chrome
  down with it, so let it settle before measuring.
- **adb resets:** the emulator's adbd sometimes resets ("timeout expired while flushing socket"), which drops every
  forward and reverse. The journey re-makes only the missing ones, because replacing a live forward cuts DevTools,
  and retries a page that comes up as Chrome's "site can't be reached".
- **A first visit every time:** the journey and the profiler close leftover localhost tabs (a background globe tab
  costs about a second of load time) and clear the site's storage, so the welcome presets show and the map does not
  reopen wherever the last run left it.
- **Paint costs are noisy:** the emulator decodes and rasterises through the host GPU, so the 2D map's pinch p95
  moves between 80 and 180 ms run to run with an idle main thread. Run an A/B at least twice each way.

**iPhone: there is no iOS simulator outside a Mac.** `webkit_journey.mjs` catches WebKit-only breakage, for example
Cesium needing `OffscreenCanvas`, which iOS only has since 16.4 (the globe page now shims it). For the real iOS
Simulator, install Xcode (free) on a Mac and open the site in the Simulator's Safari.

## Latest results (2026-10-03, local build, Android emulator unless noted)
| | morning | evening |
|---|---|---|
| Globe on screen | 4.6 s | 4.3 s |
| Dragging the globe (all satellites loaded) | 14-16 fps | 47-57 fps |
| Zoom out to the Solar System | 8 long tasks, 2.4 s | 0 long tasks, 54 fps |
| Solar System drag + pinch | 53 fps | 60 fps |
| 2D map drag + pinch | 27-49 fps (noisy) | 60 fps |
| Opening Weather, first time | 12 long tasks, 2.2 s (a layer-count shader build, 0.6 s, plus tile uploads) | the 0.6 s moves to an idle moment ~16 s after load (`Weather.prewarm`); the open itself: 0 long tasks when run after idle. Opened straight after a busy gesture sequence (the journey) it can still land inside the step |
| iPhone profile (WebKit) | all steps pass | all steps pass, no errors |
| Desktop zoom, Earth to the stars | p95 6.2 ms | p95 6.2 ms, no frame over 50 ms |

**The satellite dots were the biggest cost on phones.** Every moved dot costs Cesium a high/low precision split, and once more
than a tenth of a point collection moves it re-uploads the whole vertex buffer: ~11,000 dots, every frame. Dragging the globe
ran at 15 fps with the dots and ~60 without. Far out they now all move together every few frames (8 on phones above 20,000 km,
4 above 1,500 km, 2 in low orbit) and nothing is uploaded in between; a dot moves ~125 m a frame, well under a pixel. Moving them
in rotating slices did not help: each slice was still over a tenth. It also showed a trap: an unpropagated satellite reads
`undefined`, not NaN, from the worker buffer and became a NaN position.

### Weather mode on the Android emulator (2026-10-03)
Measured with `android_profile.mjs weather`, the journey's "Weather with wind" step, and A/B runs (hide the canvas, empty it).

| | before | after |
|---|---|---|
| Wind streaks, still | 29-35 fps | 46 fps |
| Wind, dragging the globe | 32 fps | 43 fps |
| Wind + temperature wash | 28 fps | 42 fps |
| Clouds + radar only (no wind) | 44-55 fps | same |

What the A/B runs showed: the particles' JavaScript was never the main cost. A full-screen canvas laid over the WebGL globe costs
about 15 fps just to composite on the emulator (an empty one costs the same). What helped: updating the streaks at half the frame
rate on phones (about +15 fps), a canvas at 0.6 of the CSS pixels, projecting particles with our own matrix (Cesium's
`worldToWindowCoordinates` was 15% of the main thread; the maths is checked against it to 0 px), and skipping the satellite and
aircraft position updates while weather mode hides them (580 ms of work per profile). Left: opening the mode makes Cesium link a
new globe shader for the extra imagery layers (about 0.5 s, once), which a pre-warm at boot could hide.

**Test hygiene:** Open-Meteo limits each IP per hour (a live open is 612 locations). A burst of test runs exhausts it and wind then
silently does not draw, which looks like a speed-up. The site build now mirrors the grid (`data/wind.json`, every 6 h, see
`build_site.py`) and the browser reads that first; to test before a release, put a file of that shape in `data/` by hand and delete
it afterwards. Always check "wind canvas ... lit" is non-zero when measuring.

### A tap on a phone is a country, not a satellite (2026-10-04)
A finger covers ~28 px and 18,000 satellite dots mean one is nearly always under it, so the first Android run of `android_features.mjs`
opened a Starlink card when Japan was tapped. A tap now selects a satellite only when its dot is within 8 px of the touch; otherwise it
is treated as a tap on the ground (the country). Mouse clicks are unchanged (3 px).
