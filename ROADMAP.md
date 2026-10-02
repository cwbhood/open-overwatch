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
- [ ] CI: lint-free syntax check + tests on every push (runs only once we publish)
- [ ] `docs/DATA_SOURCES.md` (every feed: what, licence, refresh, accuracy), honest README with a demo clip

Housekeeping to do before publishing: `.gitattributes` (LF everywhere, CRLF for .bat/.vbs) + renormalize; add `src`
to `APP_PATHS` in `.github/build_site.py` and to the release zip list (archived versions import modules from `src/`).

## Stage 2 — the signature: one zoom from street to galaxy
- [ ] Seamless globe ↔ Solar System hand-off (matched camera, shared clock, no page jump feel)
- [ ] One time control for everything (satellites, planets, asteroids)
- [ ] Every tracked object in orbit (full public catalogue incl. debris) + close-approach finder
- [ ] Moons of Jupiter and Saturn; cosmic-web finale beyond the Local Group

## Stage 3 — launch like engineers
- [ ] Performance budget + numbers in the README (fps, memory, load size), phone pass
- [ ] 30-second capture of the full zoom
- [ ] Decide how the public history looks (squash / fresh repo) — the user's call
- [ ] Publish as v0.9.1

## Rules of thumb
- One clear goal per session; read this file first, tick boxes as they land.
- Core code is plain ES modules with no DOM/three.js imports, so Node can test it.
- No build step: browsers load `src/` directly; CDN libraries via import maps.
- Never point automated runs at CelesTrak (the site mirrors TLEs); look-dev renders use `brand/tools/globe_shot.mjs`.
