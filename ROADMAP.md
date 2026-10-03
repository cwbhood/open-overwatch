# Roadmap — the rebuild

Work happens on the local `rebuild` branch. **Release freeze:** nothing is pushed, tagged or deployed until the whole
chunk below is done and reviewed; the next public version will be v0.9.1. (`git push` on this branch fails on purpose.)

Goal: one coherent, well-engineered project that zooms from a street to the Local Group on real, open data — code a
programmer would enjoy reading, not three big HTML files.

## Stage 1 — credible codebase
- [x] Plan + architecture docs (`docs/ARCHITECTURE.md`), lean `CLAUDE.md`
- [x] `src/core/`: time, units & frames, Kepler, planets + Moon, IAU rotation, small-body format, assets, formatting
- [x] Tests for the core (`node --test`), checked against JPL Horizons fixtures
- [x] Solar System view moved onto `src/core` + `src/solar/` modules (solar.html = markup + styles only)
- [x] Satellite feed (TLE fetch, mirror, cache, parse) as `src/core/tle.js` (globe and 2D map)
- [x] 3D globe moved onto modules (`src/globe/`), aircraft dead reckoning shared via `src/core/geo.js`
- [x] 2D map split into modules (`src/map/`, generated from an AST analysis of the old script), keeping its layer contract; satellites via `src/core/tle.js`
- [x] CI: syntax check, page→module links, tests on every push (`.github/workflows/ci.yml`; runs once we publish)
- [x] `docs/DATA_SOURCES.md` (every feed: what, licence, refresh, accuracy)
- [ ] Honest README with a demo clip (do with Stage 3, once the zoom exists)

Housekeeping before publishing: `src`, `earth_fx_2k.jpg` and `brand/textures/moons` are now in `APP_PATHS` / the release zip;
check any new runtime asset is too (archived /v/<tag>/ copies fall back to the site root only for big data and textures).

## Stage 2 — the signature: one zoom from street to galaxy
- [x] Seamless globe ↔ Solar System hand-off (matched camera and field of view, cross-fade, roll to the ecliptic, both directions)
- [x] One time control for everything: globe time bar (satellites follow it, aircraft hide off-live), carried across the hand-off both ways
- [x] Everything CelesTrak publishes in orbit (all active satellites + the three big debris clouds; the full catalogue is
      Space-Track's and can't be redistributed) + "Near misses": SOCRATES close approaches, watched live at the TCA
      (data appears once the site build runs: `active`, `fengyun-1c-debris` and `socrates.json` are new in build_site.py)
- [x] Major moons (Mars to Pluto, 20): Horizons-fitted orbits, tidally locked, orbit lines and labels near their planet
- [x] Cosmic-web finale: 43,480 2MRS galaxies, cluster labels on the real overdensities, a ladder rung and the tour's last stop

## Stage 2b — the overkill wow (2026-10-02)
- [x] Light delay (ghost where Earth sees the focused body) and our radio bubble (since 1920, stars inside tinted)
- [x] Other solar systems: 6,339 NASA exoplanets at their stars; fly into any system (real sizes, habitable zone, transit-timed positions)
- [x] Look-up mode (globe band → Look up): your sky from your location, phone sensors or drag; planets, bright stars,
      overhead satellites and aircraft, compass ring, next ISS pass (core/passes.js, core/orientation.js, tested).
      Needs the real-phone check: iOS compass + Android absolute orientation
- [ ] Total solar eclipse of 2 August 2027: the Moon's shadow on the globe, next eclipse from your place
- [ ] Accuracy + nerd panel (error vs JPL, fps, data age)

## Stage 3 — launch like engineers
- [x] Performance numbers + fixes (docs/PERFORMANCE.md, brand/tools/perf.mjs): shader pre-warm, graphics levels with auto step-down, software-GPU hint, phone header fix
- [x] First-visit phone journey, emulated (brand/tools/mobile_journey.mjs): load times halved, touch picking, layout fixes on all three views
- [ ] Real-phone pass on the published beta (iPhone Safari + Android Chrome: a real GPU, memory limits) and README numbers
- [ ] 30-second capture of the full zoom
- [ ] Decide how the public history looks (squash / fresh repo) — the user's call
- [ ] Publish as v0.9.1

## Rules of thumb
- One clear goal per session; read this file first, tick boxes as they land.
- Core code is plain ES modules with no DOM/three.js imports, so Node can test it.
- No build step: browsers load `src/` directly; CDN libraries via import maps.
- Never point automated runs at CelesTrak (the site mirrors TLEs); look-dev renders use `brand/tools/globe_shot.mjs`.
