# Open Overwatch

Live open-data situation views on a static site: a 2D map (Leaflet), a 3D Earth (CesiumJS) and a Solar System to
Local Group view (three.js). No build step; ES modules from `src/`, libraries via CDN import maps.

**Status: rebuild in progress on the local `rebuild` branch. RELEASE FREEZE — never push, tag, run
`Publish Update.bat` or deploy until the user says so. Local commits are fine. Next public version: v0.9.1.**

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
