"""Colour night-side texture for the 3D globe (globe.html): warm city cores, a green haze around them, faint
green coastlines so dark continents still read. Built from the textures make_textures.py writes.

    python make_night.py [--tex DIR] [--out FILE] [--width 8192]
"""
import argparse
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
HERE = Path(__file__).resolve().parent

ap = argparse.ArgumentParser()
ap.add_argument('--tex', default=str(HERE.parent / 'textures'))
ap.add_argument('--out', default=str(HERE.parent / 'textures' / 'night_8k.jpg'))
ap.add_argument('--width', type=int, default=8192)
a = ap.parse_args()
W, H = a.width, a.width // 2
tex = Path(a.tex)

lights = np.asarray(Image.open(tex / 'lights_8k.png').resize((W, H), Image.BOX), dtype=np.float32)
lights /= 65535.0 if lights.max() > 255 else 255.0
coast = np.asarray(Image.open(tex / 'coast_8k.png').convert('L').resize((W, H), Image.BOX), dtype=np.float32) / 255.0

# haze: blur a quarter-size copy, which is cheap and plenty smooth
small = Image.fromarray((lights * 255).astype(np.uint8)).resize((W // 4, H // 4), Image.BOX)
haze = np.asarray(small.filter(ImageFilter.GaussianBlur(3)).resize((W, H), Image.BILINEAR), dtype=np.float32) / 255.0

warm = np.array([255, 238, 205], np.float32) / 255
green = np.array([125, 255, 166], np.float32) / 255
rgb = (lights[..., None] ** 1.15) * warm * 1.05 + (np.clip(haze * 2.2, 0, 1) ** 1.3)[..., None] * green * 0.42 \
    + coast[..., None] * green * 0.13
rgb += np.array([4, 6, 10], np.float32) / 255  # brand night base instead of pure black
out = (np.clip(rgb, 0, 1) ** (1 / 1.05) * 255).astype(np.uint8)
Image.fromarray(out, 'RGB').save(a.out, quality=86, subsampling=0, optimize=True)
print('wrote', a.out, Path(a.out).stat().st_size, 'bytes')

# Tile pyramid for Cesium (GeographicTilingScheme: 2x1 tiles at level 0, 256 px, {z}/{x}/{y}.jpg with y=0 at the
# north). One 8k single-tile texture broke Cesium's globe rendering in testing; tiles also stream in faster.
full = Image.fromarray(out, 'RGB')
tiles_dir = Path(a.out).parent / 'night'
n_tiles = 0
for z in range(5):
    w, h = 2 ** (z + 1) * 256, 2 ** z * 256
    lvl = full.resize((w, h), Image.LANCZOS) if (w, h) != full.size else full
    for x in range(w // 256):
        for y in range(h // 256):
            d = tiles_dir / str(z) / str(x); d.mkdir(parents=True, exist_ok=True)
            lvl.crop((x * 256, y * 256, x * 256 + 256, y * 256 + 256)).save(d / f'{y}.jpg', quality=84)
            n_tiles += 1
print('wrote', n_tiles, 'tiles to', tiles_dir)
