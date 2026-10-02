# Performance

Measured with `brand/tools/perf.mjs` (headless Edge on an RTX 3060, serve.js on :8787):

```
node brand/tools/perf.mjs [desktop|phone|both] [page ...]     # OO_PROFILE=1 adds a CPU profile of the moving sample
```

*Desktop* is 1600×900. *Phone* is 390×844 at 3× with touch, a mobile user agent and the CPU throttled 4×. The GPU
can't be throttled, so phone numbers say nothing about a phone's graphics chip: that is what the automatic quality
step-down is for. *Still* samples 8 s with the camera at rest; *moving* samples 8 s of a scripted camera move:
- globe: the Street preset, a 3 s flight from 20,000 km to a London street;
- Solar System: Earth out past the asteroid belt;
- 2D map: continuous panning.

## Before and after (2026-10-02)

| Page · profile | Moving fps before | Worst frame before | Moving fps after | Worst frame after |
|---|---|---|---|---|
| Globe · desktop | 41 | 1,254 ms | 73–77 | 640–870 ms (one-off shader compiles) |
| Globe · phone | 8.6 | 1,533 ms | 69 | 490 ms |
| Solar System · desktop | 85 | 146 ms | 165 | 139 ms |
| Solar System · zoomed out (light-years+) | 16 | | 165 | |
| 2D map · both | 157–164 | 24 ms | unchanged | |

Every page runs at the display's refresh rate with the camera at rest.

## What was slow, and the fixes

- **Shader compiles mid-flight (globe).** Cesium compiles a program the first time each globe-tile imagery
  combination, or glTF material, is drawn: ~100 ms each under ANGLE/D3D11, and 27 of them during the flight. Fixes:
  - Hide imagery layers that can't be seen: the Esri base under an opaque Blue Marble, and the Blue Marble at alpha 0.
    That cut the globe variants from 11 to 6.
  - Pre-warm every aircraft and satellite model type at boot (`src/globe/warm.js`).
  - Model shaders still differ near the ground: fog adds an atmosphere stage to them. Those compile once per session.
- **Graphics levels** (`src/globe/quality.js`, `src/solar/quality.js`): High, Balanced and Low; phones and software
  renderers start on Low. In Auto, two 3-second windows with a median frame over 40 ms step down one level.
  - Globe levers: tile detail (screen-space error 2/3/4), model counts (aircraft 200/80/30, satellites 40/25/12),
    cloud noise octaves (4/2/1), 30 fps cap on Low.
  - Solar levers: pixel ratio (2/1.25/1), and all 1.57M asteroids or only the brightest 300k.
- **Faded point clouds still drawn (Solar System).** From light-years out the 1.57M asteroids land on a few pixels
  and additive blending serialises them: 60 ms frames at any zoom past the Oort cloud. Faded clouds are now hidden.
- **Software WebGL** (hardware acceleration off): detected from the renderer string (`src/core/gpu.js`). The page
  explains how to turn acceleration on, because no quality level makes software rendering usable.

## Load size

- Globe: 16 MB, plus 6.7 MB of satellite models warmed in the background (2 types on phones).
- Solar System: 42 MB on desktop, 19 MB of which is the second asteroid file, loaded after start. 14 MB on phones.
- 2D map: under 1 MB.
