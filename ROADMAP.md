# Roadmap — the rebuild

Work happens on the local `rebuild` branch. Nothing is pushed, tagged or deployed until the user says so (a local
pre-push hook refuses pushes without OO_PUSH_OK=1). Published: v0.9.1 (2026-10-02), v0.9.2.1 and v0.9.2.2 (2026-10-03), v0.9.2.3 and v0.9.2.4 (2026-10-04); next v0.9.2.5.

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
- [x] Solar eclipses 2027–2030 (globe band → Eclipses): Horizons Sun/Moon every minute, live umbra + penumbra, path of
      totality, coverage from your location. 2027-08-02 greatest eclipse 25.51°N 33.16°E 10:06:39 UT, 6 min 27 s
      (NASA: 25°31'N 33°08'E, 6 min 23 s); the six central eclipses land within ~0.1° of NASA's points
- [x] Under the hood panels (` key / buttons): fps + frame times, draw calls, GPU, data sources and ages, SGP4 worker
      timing; the Solar System's errors measured live in the browser against JPL Horizons (core/accuracy.js, also tested)

## Stage 3 — launch like engineers
- [x] Performance numbers + fixes (docs/PERFORMANCE.md, brand/tools/perf.mjs): shader pre-warm, graphics levels with auto step-down, software-GPU hint, phone header fix
- [x] First-visit phone journey, emulated (brand/tools/mobile_journey.mjs): load times halved, touch picking, layout fixes on all three views
- [x] Phones without phones: real Chrome in Google's Android emulator and Safari's engine with an iPhone profile (docs/TESTING.md)
- [ ] Real-phone pass on the published beta (iPhone Safari + Android Chrome: a real GPU, memory limits) and README numbers
- [x] 30-second capture of the full zoom (brand/tools/zoom_capture.mjs → brand/clip/, full 1080×1920 in brand/video/)
- [ ] Decide how the public history looks (squash / fresh repo) — the user's call
- [x] Publish as v0.9.1 (2026-10-02)
- [x] Publish as v0.9.2.1 (2026-10-03): other solar systems, look up, eclipses, light delay, under the hood, phone fixes
- [x] Publish as v0.9.2.4 (2026-10-04): About the creator page, links to Ironbound, search tags, MIT licence, citation file
- [x] Publish as v0.9.2.3 (2026-10-04): country dossiers, big employers, volcanoes, aurora, flybys, sun and time zones, share links, the tour, 3D buildings (OpenStreetMap, no account)
- [x] Publish as v0.9.2.2 (2026-10-03): phone dock, desktop nav pad, lighthouses, weather mode (clouds, radar, rain, wind, temperature), phone performance

## Stage 4 — things people asked for (2026-10-05, not yet published; would be v0.9.2.5 with the notices commit)
- [x] Tonight above you (globe band → Tonight; `globe.html#go=tonight` from the landing page): visible ISS / Tiangong / Hubble
      passes, Starlink trains (launches still below ~470 km), the brightest satellites when high, the five bright planets,
      the Moon's phase, the aurora chance where you stand, all in plain words (core/sky.js, tested). Location saved on the
      device only, rounded; a returning visitor gets a one-line "ISS at 9:42 pm, look WNW" toast
- [x] Pass alerts: "Calendar" downloads an .ics with a 10-minute reminder (works with the site closed, no server);
      "Remind me" = a notification while the page is open (src/globe/alerts.js + notify-sw.js, re-armed on the next visit)
- [x] Aurora alerts: checked every 10 min while the page is open, only in the dark, once a night at most
- [x] Share a picture (navpad ◫ or P, phone menu): the view with a caption strip and the site address, to the share sheet
      with the link on phones, a PNG + copied link on desktops (src/globe/snapshot.js)
- [x] Find a flight (globe band → Find flight): ticket number (BA 123 → BAW123), callsign, registration or hex
      (core/flight.js, tested); the download version asks adsb.lol and refreshes every 15 s; the website searches what it
      has and otherwise opens adsb.lol's own map. Aircraft cards get "Share", and links carry the flight (`&f=BAW123`)
- [x] Meteor showers (core/meteors.js, tested): the ten major showers in Tonight with an honest rate from where you are
      (radiant height, Moon, suburban sky), a peak-night calendar reminder, and the active radiants marked in Look up
- [x] Search everything (band → ⌕ Search, or "/"): satellites by name, NORAD number or everyday name (ISS, Hubble,
      Tiangong), countries, flight numbers, views, and volcanoes / employers / lighthouses once their layers have loaded
- [x] Look up → "Sky on": any date 1800-2049 (planets, Moon, stars; satellites only within 3 days of today)
- [x] Satellite cards say what the thing is in one sentence (core/explain.js)
- [x] Install as an app (manifest.webmanifest: standalone, shortcuts to Tonight and Find a flight); "reduce motion"
      makes camera flights jump instead of swoop
- [x] Constellation figures and names in Look up (d3-celestial, BSD: data/constellations.json via brand/tools/make_constellations.py), "Figures" toggles them
- [x] Rocket launches (band → Launches, pads as orange markers with countdowns): Launch Library 2, copied by the site build every 6 h
      (build_site.py mirror_launches), countdown, how sure the time is, webcasts, calendar / notification reminders, fly to the pad
- [x] "When can I see it?" on every satellite card (its passes over you, 3 days); Tonight adds where the ISS is right now and
      launches within 1,000 km in the next week ("look toward the SSE"), plus the next launch anywhere
- [x] Embed mode (`globe.html#embed=1`, navpad "</>" or phone menu copies an iframe); landing page shows the next launch countdown
- [x] Keyboard focus outlines, labelled globe and card regions
- [x] Tonight: sunset / dark / sunrise, moonrise and set, the next full Moon by name (Harvest, Hunter's...; supermoons),
      "Farthest from home" (Voyagers, New Horizons, Pioneers: distance now and signal time), and a "look up now" nudge a
      minute before each visible ISS / Tiangong pass while the page is open
- [x] Look up "Red": a red-light view that keeps your eyes dark-adapted (remembered)
- [x] Clouds tonight (Open-Meteo, CC BY 4.0; location rounded to ~10 km): clear spells in words, the next clear night, and each
      pass marked clear / cloudy (core/clouds.js, tested)
- [x] "Coming up in the sky": the Moon within 5° of a bright planet, planets within 3° of each other, next 30 days (core/sky.js meetings)
- [x] Look up: tap a planet, the Moon, a bright star or a satellite to find out what it is (distance, light travel time,
      "the light reaching your eyes left Vega in 2001"; core/skyfacts.js)
- [x] Tonight "Share tonight": a one-line summary of your sky with a link, to the share sheet or the clipboard
- [x] Look up "Find": pick a planet, the Moon, the ISS or a bright star; an arrow and "turn right 32°, up 11°" lead you to it
      (core/orientation.js guide, tested)
- [x] Look up hides things on the ground (employer towers, volcanoes, lighthouses, pads, quakes, buildings): from eye height
      they were the "streaks" seen across the sky
- [x] Tonight: the next solar eclipse you can see from home (how much of the Sun, when; "Watch the shadow"); sections fold
      (remembered)
- [x] People in space right now (Launch Library 2 astronauts, build copy in data/astronauts.json, core/crew.js tested): a card
      with names, flags, agencies, days in space; "Aboard now: 11 people" on the ISS and Tiangong cards; in Tonight and search
- [x] tonight.html: the Tonight card without the 3D globe (src/sky/main.js wires light feeds into src/globe/tonight.js, which
      no longer imports the globe; core/observer.js replaces Cesium for passes). Phone profile: card 1.2 s, full answer 1.7 s
      after location. Landing page and the app shortcut link here
- [x] Bug hunt rounds 1-2 (2026-10-05/06): 24 + 56 confirmed defects fixed (three reviewers, then a 213-agent workflow:
      10 finders, 3 verifiers per finding, a seeded second round). Headline fixes: a ticket number like AA1234 was read as
      a hex address; "tonight" opened pre-dawn described the minutes to dawn; meteor peak nights were a day off west of
      UTC+6; cards overwrote each other; look-up leaked models, buildings and clicks; the build's launch/crew copies
      were all-or-nothing; the site build now keeps the last good copy of any feed it can't refresh (see NOTES.md)
- [ ] Live site 2026-10-06: data/tle/ is empty since the 06:28 UTC build (CelesTrak timed out on GitHub's runner); the
      next scheduled build (12:23 UTC) or a manual "Website" run restores it; with this branch's build_site.py a repeat
      would keep the previous copy instead
- [ ] Real-phone check: share sheet with a file (iOS Safari, Android Chrome), notifications on Android, .ics on iPhone

## Rules of thumb
- One clear goal per session; read this file first, tick boxes as they land.
- Core code is plain ES modules with no DOM/three.js imports, so Node can test it.
- No build step: browsers load `src/` directly; CDN libraries via import maps.
- Never point automated runs at CelesTrak (the site mirrors TLEs); look-dev renders use `brand/tools/globe_shot.mjs`.
