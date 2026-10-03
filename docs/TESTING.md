# Testing

## Unit tests
`node --test` from the repo root: the maths in `src/core/` against JPL Horizons fixtures and textbook identities
(no dependencies). CI runs them on every push, plus a syntax check of every module and a link check of every page.

## In the browser (needs `node serve.js` on :8787)
| Tool | What it does |
|---|---|
| `brand/tools/perf.mjs` | load size, still and moving frame rates, desktop and an emulated phone |
| `brand/tools/zoomtest.mjs` | real wheel events from Earth through the hand-off to the stars and back, frame by frame |
| `brand/tools/mobile_journey.mjs` | a first visit A to Z on a phone: landing, globe, Solar System, 2D map, with touch, screenshots and a layout audit |
| `brand/tools/webkit_journey.mjs` | the same journey in Safari's engine (Playwright WebKit) with an iPhone 15 profile |

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
  forward and reverse. The journey re-makes only the missing ones, because replacing a live forward cuts DevTools.

**iPhone: there is no iOS simulator outside a Mac.** `webkit_journey.mjs` catches WebKit-only breakage, for example
Cesium needing `OffscreenCanvas`, which iOS only has since 16.4 (the globe page now shims it). For the real iOS
Simulator, install Xcode (free) on a Mac and open the site in the Simulator's Safari.

## Latest results (2026-10-03, local build)
| | Android emulator (Pixel 8, Chrome 124, 4 GB) | WebKit, iPhone 15 profile |
|---|---|---|
| Globe on screen | 4.6 s | 6.2 s |
| Globe motion | 43–51 fps (60 Hz screen), worst frame 200 ms | — |
| Hand-off to the Solar System | works; 16 long tasks (2.8 s) while the view loads | — |
| Solar System | 49–56 fps | WebGL2, TRAPPIST-1 builds |
| 2D map drag + pinch | 27 fps (to look at) | works |
| JavaScript errors | none | none (after the OffscreenCanvas shim) |
