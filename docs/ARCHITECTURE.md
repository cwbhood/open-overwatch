# Architecture

Open Overwatch is a static site: every view is an HTML page that loads ES modules straight from `src/` — no bundler,
no framework, no server you have to run (the optional local helper only relays a few feeds that send no CORS headers).
Third-party libraries come from a CDN through an import map, pinned to exact versions.

```
index.html            landing page
open-overwatch.html   2D map (Leaflet)            -> src/map/
globe.html            3D Earth (CesiumJS)         -> src/globe/
solar.html            Solar System -> Local Group -> cosmic web (three.js) -> src/solar/
src/core/             shared, DOM-free, tested: time, frames, orbits, data formats
test/                 node --test, fixtures from JPL Horizons
data/solar/           pre-built binary/JSON data (scripts in brand/tools/)
brand/                textures, models, promo assets and the scripts that make them
serve.js / serve.py   optional local helper: static files + a locked-down relay
```

## Conventions

**Units.** Distances in the Solar System are astronomical units (AU); interstellar ones are light-years converted to
AU (`LY_AU`). Angles are radians inside functions, degrees only in tables and UI. Time is a Julian Date (`jd`, days,
TT ≈ UTC — the 69 s difference is below anything we draw).

**Frames.** One frame for everything in space: heliocentric **ecliptic J2000** (x toward the March equinox, z toward
the ecliptic north pole). Equatorial inputs (RA/Dec, star catalogues, galaxies) are rotated once with
`eqToEcl`. Earth-fixed data (the globe) stays in Cesium's ECEF; the hand-off between the two goes through the Sun
direction and Earth's IAU rotation, both in `src/core`.

**Vectors.** Core functions write into an `out` object with `x, y, z` (a `THREE.Vector3` or a plain object), so the
same code runs in Node tests and in the render loop without allocating.

## The core (`src/core/`)

| module | what it does |
|---|---|
| `units.js` | constants (AU, light-year, parsec, c), obliquity, `eqToEcl`, `radecToEcl`, galactic axes |
| `time.js` | Julian Date conversions, a simulation clock (rate, live/paused), UTC formatting |
| `kepler.js` | Kepler's equation (Newton, robust start for high e), elements → position |
| `planets.js` | JPL "approximate positions" elements (1800–2050), the Moon (Schlyter + main perturbations), physical data |
| `moons.js` | 20 major moons (Mars → Pluto): orbits fitted to Horizons over 2026, with node, periapsis and mean-longitude rates |
| `rotation.js` | IAU rotation models → body-fixed axes in the ecliptic frame (texture longitude 0 = +x) |
| `smallbodies.js` | the 15-byte-per-object asteroid format, decoding, comet elements |
| `assets.js` | fetch with a fallback to the published site (archived versions don't carry big data) |
| `format.js` | distances, light time, durations, HTML escaping |
| `tle.js` | satellite element sets: CelesTrak / site-copy order, 2 h cache, parsing, epochs |
| `geo.js` | great-circle destination, haversine, dead reckoning for aircraft and ships |
| `socrates.js` | CelesTrak SOCRATES close-approach CSV parsing, upcoming conjunctions |
| `passes.js` | satellite passes over an observer (rise / peak / set, look angles, sunlit + dark-sky visibility) |
| `orientation.js` | W3C device orientation → camera direction and screen-up (look-up mode) |
| `eclipse.js` | Moon shadow cones, where they meet the WGS84 ellipsoid, shadow outlines, what an observer sees |
| `accuracy.js` | errors against JPL Horizons (shared by the tests and the in-app "Under the hood" panel) |
| `gpu.js` | software-WebGL detection |

Accuracy, checked by the tests against JPL Horizons on 2026-10-02: planets within arcminutes (JPL's own stated
error for these formulas), main-belt asteroids within ~3×10⁻⁴ AU, the Moon within ~0.3°, the other moons within 0.4° of their orbit.
The moon fits drift slowly away from 2026 (no short-period terms); rerun `make_moons.py` with a new window then.

## The 3D globe (`src/globe/`)

Cesium and satellite.js load as classic scripts (globals); the app is ES modules on top: `env` (DOM, storage, network,
relay), `viewer` (viewer, camera limits, shared primitive collections, star box), `earth` (imagery, the three shader
shells, Sun/Moon directions), `layers` (switches + dock), `follow` (follow camera, glTF axis conventions),
`satellites` (TLEs via core, SGP4 worker, models), `aircraft` (feeds, dead reckoning, models), `quakes`, `ui` (stats,
band, presets, picking, card, lighting), `mobile` (phones only: bottom dock and sheets that click the existing controls) and `main` (wiring, timers, boot). `state.js` holds the selection and late-bound
hooks so feature modules never import the UI. `window.OO3D` is the console handle.

## One zoom from street to galaxy

`src/globe/space.js` loads `solar.html?embed=1` in an iframe once the globe camera climbs past 80,000 km, and hands
the camera over beyond 300,000 km (looking back at Earth): position, view direction and up vector go across as
Earth-centred vectors in ecliptic J2000 (Cesium Earth-fixed → ICRF with Cesium's IERS-based matrix → ecliptic), plus the
vertical field of view. The Solar System view places them around Earth's *centre* (not the Earth–Moon barycentre,
4,700 km away), so Earth sits in the same pixels at the switch; the two cross-fade in 0.7 s and the star backgrounds line
up. It then rolls the view to ecliptic north over 1.6 s. Zooming into Earth there (below 220,000 km, not mid-flight)
hands the camera back the same way. Only one renderer draws at a time: Cesium's render loop stops while the Solar
System is showing, and the Solar System's loop sleeps while the globe is.

## Data that is built offline

The browser never queries catalogues with millions of rows. Scripts in `brand/tools/` download once (cached in the
gitignored `brand/source/`), compress and write `data/solar/`:

- `asteroids_a.bin` / `asteroids_b.bin` — all 1.57M SBDB asteroids, 15 bytes each, propagated on the GPU
- `small_bodies.json` — named objects and comets · `stars.bin` / `stars.json` — HYG v4.1 in ecliptic light-years
- `spacecraft.json` — JPL Horizons trajectories at fixed steps · `moons.json` — 20 moon orbits fitted to Horizons
- `galaxies.bin` / `galaxies.json` — 43,480 2MASS Redshift Survey galaxies (Mpc, equatorial, Hubble-law distances)

Live feeds (satellites, aircraft, quakes, …) are fetched by the page; satellite TLEs come from a copy the site build
refreshes every 6 hours, so visitors never hit CelesTrak directly.

## Rendering notes (solar)

- One three.js scene in AU with a **logarithmic depth buffer** (near 1e-9 AU, far 1e15 AU): 26 orders of magnitude.
- The camera rides along with its focus body; model-view matrices are composed in double precision on the CPU, so
  objects stay steady even 1e11 AU from the origin.
- 1.57M asteroids: one `Points` draw per file; each vertex solves Kepler's equation in the shader from packed
  elements (Float32 a, five Uint16 angles/eccentricity, Uint8 class). 165 fps on an RTX 3060.
- Point clouds that have faded out are set invisible, not just transparent: from light-years away the asteroids all
  land on a few pixels and additive blending serialises them (42 ms a frame on an RTX 3060 before this).
- Graphics levels (`quality.js` in both 3D views) and the measurements are in `docs/PERFORMANCE.md`.
- The star map is sampled by direction in a shader (ecliptic → equatorial → RA/Dec), so there are no cube-map
  orientation conventions to get wrong.

## Testing

`node --test` (from the repo root) — no dependencies. Fixtures in `test/fixtures/` are real JPL Horizons vectors, so a regression in
the orbital maths shows up as a distance error in AU, not as a vague visual change.
