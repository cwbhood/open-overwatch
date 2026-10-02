# Open Overwatch — brand + promo pack

Made with Blender 5.2 (headless, scripted), a little Python, and the app itself.

## What's here
- `video/open-overwatch-promo-music.mp4` — the vertical promo, 1080x1920, 30 fps, 31.5 s, H.264 + AAC, with an original
  soundtrack. `open-overwatch-promo-silent.mp4` is the same cut without audio (for adding a TikTok sound in the app).
- `emblem/` — the 3D radar-scope emblem: `emblem-1024/512/256.png` (transparent, 14° tilt), `emblem-front-1024.png`
  (straight-on), `emblem-on-dark-1024.png`, `profile-1080.png` (avatar), `apple-touch-icon.png`, `favicon.svg` (flat
  version for small sizes; the app embeds it).
- `hero/` — start-screen globe: `hero-wide.webp/.jpg` (2560x1600, the airglow crest sits 65% down) and
  `hero-tall.webp/.jpg` (1080x1920, crest 33.5% down; clear sky from y 220 to 610). The `.png` files are lossless masters.
- `social/` — `og-1200x630.png` (link preview), `square-1080.png`, `tiktok-cover-1080x1920.png`.
- `sprites/` — top-down aircraft icons for globe.html (airliner, prop, heli, fighter, heavy, tprop × civ/mil/emg),
  96 px with the layer-colour glow; `raw/` holds the plain 256 px Blender renders. Rebuild: `blender ... tools\plane_sprites.py -- brand\sprites`
  then `python tools\plane_sprites.py --post brand\sprites`.
- `models/` — glTF models for globe.html: satellites `iss, css, hubble, soyuz, starlink, gnss, geo, weather, smallsat,
  rocketbody` (tools/sat_models_stations.py, tools/sat_models_fleet.py; previews/ has 2x2 review sheets) and
  `aircraft/<shape>_<civ|mil>.glb` (tools/plane_models.py, same geometry as the sprites). Axes: +X forward, +Z up,
  metres; `solar_*` nodes turn about Y; the helicopter's `rotor` node spins. `test/axes.glb` is an axis-marker model.
- `textures/night/` — city-lights tile pyramid for the globe's night side (tools/make_night.py). No longer used by globe.html (it streams NASA's
  500 m Black Marble instead); kept for older archived versions.
- `textures/earth_fx_8k.jpg` / `_4k.jpg` — globe effects texture: R clouds, G water, B soft clouds (tools/make_earth_fx.py,
  from NASA Blue Marble clouds + Natural Earth). `tools/globe_shot.mjs` renders globe views headless for look-dev.
- `textures/sky/` (2048 px) and `textures/sky_1k/` — the globe's star field: NASA SVS Deep Star Maps 2020 as cube faces
  (tools/exr_dump.py in headless Blender decodes `source/starmap_2020_4k.exr`, then tools/make_skybox.py).
- `blend/` — `emblem.blend`, `globe.blend` (textures load from `textures/`).
- `textures/` — 8k Earth maps made by `tools/make_textures.py` from `source/`.
- `source/` — downloaded public-domain Earth data (see Credits).

## Landing page (`lander/`, used by index.html)
- `hero-loop.mp4/.webm` (1920x1080, 6 s, plays once and holds) + `hero-poster.jpg`, `hero-wide` (2560x1440) and
  `hero-tall` (1080x1920) stills: the ISS (models/iss.glb) over the night globe with flight arcs drawing in.
  `blender ... tools\lander_hero.py -- --do stills,anim` then `python tools\lander_hero.py --encode`
  (pip install imageio-ffmpeg). Frames go to ~/open-overwatch-work/anim/lander.
- `icons/` — six 3D feature icons (aircraft, satellite, ship, quake, storm, camera), 768 px RGBA:
  `blender ... toolseature_icons.py -- brand\lander\icons`
- `clips/` — 540x960 phone clips encoded from the capture footage (air_world, mil, space, hazards, ui).

## Where it's used in the app
The start screen shows `hero-wide.webp` (`hero-tall.webp` on portrait screens) behind the boot panel, with the horizon
pinned 245 px below the screen centre so it clears the Enter buttons (`.splash-globe` in open-overwatch.html). The
favicon, the home-screen icon and the share tags in `<head>` point at this folder.

## Rebuilding
Blender scripts run headless through the Microsoft Store build's launcher (it blocks until done; logs go to files):

    "%LOCALAPPDATA%\Microsoft\WindowsApps\blender-launcher.exe" -b --factory-startup --python brand\tools\<script>.py -- <args>

Working files (recorded footage, animation frames, caption cards, audio) live in `%LOCALAPPDATA%\open-overwatch-brand`
(outside OneDrive, about 1.5 GB). Set `OW_WORK` to use another folder.

| Step | Command |
|---|---|
| Earth textures | `python tools\make_textures.py` (about 20 s) |
| Emblem stills + 4 s sweep animation | `blender ... tools\emblem.py -- brand\emblem` |
| Globe stills + 4 s intro animation | `blender ... tools\globe.py -- --do stills,anim` |
| Record the live map (helper must be running) | `node tools\capture.mjs` (or `--shots=mil,space`) |
| Captions, intro, end card, share images | `node tools\make_cards.mjs captions intro end social` |
| Soundtrack | `python tools\make_music.py out.wav --duration 31.5 --cuts 3.5,8,12,16,20.5,24.5,28.5` |
| Assemble frames | `python tools\compose.py` (`--preview` writes a contact sheet) |
| Encode | `blender ... tools\encode_video.py -- <frames dir> <out.mp4> [audio.wav]` |
| Check an MP4 | `blender ... tools\probe_video.py -- <video.mp4> <out dir> 60,500,900` |

The recorder never uses "Around me" or any location lookup, never opens Setup, and never shows aircraft photos or
camera images. Captions quote the live counts it saved in `footage\manifest.json` at recording time
(1 Oct 2026, 21:08-21:39 UTC). If you re-record, re-run `make_cards.mjs captions` so the numbers match.

## Credits
- Night lights: NASA Earth Observatory, *Black Marble 2016* (public domain).
- Coastlines and borders: Natural Earth 1:50m, via the `world-atlas` npm package (public domain).
- Map footage: the Open Overwatch app. Basemap tiles © Esri and their data providers (kept visible in the map's
  attribution). Aircraft from adsb.lol / adsb.fi / airplanes.live / OpenSky, satellites from CelesTrak, hazards from
  USGS / NOAA / GDACS.
- Fonts: Big Shoulders Display, Barlow, IBM Plex Mono (SIL Open Font License, via Google Fonts).
- Music: original, generated by `tools/make_music.py`.
