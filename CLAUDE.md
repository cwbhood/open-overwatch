# Open Overwatch

Live open-data situation views on a static site: a 2D map (Leaflet), a 3D Earth (CesiumJS) and a Solar System to
Local Group view (three.js). No build step; ES modules from `src/`, libraries via CDN import maps.

**Status: v0.9.2.6 published 2026-10-09 at the user's request (landing page rewrite; v0.9.2.5 on 2026-10-06, v0.9.2.4 and v0.9.2.3 on 2026-10-04, v0.9.2.2 and v0.9.2.1 on 2026-10-03, v0.9.1 the rebuild on 2026-10-02). Publish only when the user asks: never push,
tag, run `Publish Update.bat` or deploy on your own; work on the local `rebuild` branch (a local pre-push hook blocks pushes
unless OO_PUSH_OK=1, set only when the user says push). Versions stay tiny: next is v0.9.2.7, then v0.9.2.8.**

Read first: `ROADMAP.md` (what's next, tick boxes as you go) · `docs/ARCHITECTURE.md` (structure, units, frames) ·
`docs/NOTES.md` (per-view lessons, publishing pipeline, 2D map layer contract, feed status, Blender) — read only the
section you need.

## Rules
- `src/core/` is DOM-free and three.js-free so Node can test it; vectors are written into `out` objects (x, y, z).
- Space frame everywhere: heliocentric ecliptic J2000, AU, Julian Dates. Run `node --test` after core changes.
- 2D map: escape every upstream string with `esc()`; relayed hosts must be in NEEDS_RELAY + serve.js + serve.py.
- Never point automated runs at CelesTrak (it firewalled this PC once); renders go through `brand/tools/globe_shot.mjs`
  (headless Edge on the GPU; `OO_URL=…` for other pages). Downloads of new datasets need the user's OK.
- Keep edits targeted in big shared files; another session may also work in this folder.

## Running
Preview config `open-overwatch` (.claude/launch.json) serves the folder on http://localhost:8787 (serve.js).
Pages: /open-overwatch.html ("Enter silent" skips audio), /globe.html, /solar.html. Console handles: `window.OW`,
`window.OO3D`, `window.OOSS`.
