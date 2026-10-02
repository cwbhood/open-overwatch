"""Star background for the 3D globe: NASA SVS Deep Star Maps 2020 (Hipparcos-2, Tycho-2, Gaia DR2) -> six cube faces.

    1. blender-launcher -b --factory-startup --python exr_dump.py -- brand/source/starmap_2020_4k.exr <work>/starmap.npy
    2. python make_skybox.py <work>/starmap.npy      ->  brand/textures/sky/{px,nx,py,ny,pz,nz}.jpg (2048 px faces)
                                                         and brand/textures/sky_1k/ (1024 px, phones)

Source: celestial (ICRF/J2000) plate carree, centred on RA 0h, RA increasing to the left, linear light.
Faces follow the OpenGL cube-map convention in ICRF axes (x = RA 0h on the equator, z = north celestial pole) but
stored bottom row first: Cesium.SkyBox reads every face vertically flipped (measured with direction-coded test faces). Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2:
ESA/Gaia/DPAC.
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

TEX = Path(__file__).resolve().parent.parent / 'textures'
EXPOSURE, FLOOR = 0.6, 0.011    # linear gain; black level removed so the sky stays black between stars

src = np.load(sys.argv[1]).astype(np.float32)          # H x W x 3, top row = Dec +90
H, W, _ = src.shape

def sample(d):
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    ra = np.arctan2(y, x)
    dec = np.arcsin(np.clip(z, -1, 1))
    u = ((0.5 - ra / (2 * np.pi)) % 1.0) * W - 0.5
    v = (0.5 - dec / np.pi) * H - 0.5
    x0 = np.floor(u).astype(int); y0 = np.floor(v).astype(int); fx = (u - x0)[..., None]; fy = (v - y0)[..., None]
    x1 = (x0 + 1) % W; x0 %= W; y1 = np.clip(y0 + 1, 0, H - 1); y0 = np.clip(y0, 0, H - 1)
    return (src[y0, x0] * (1 - fx) * (1 - fy) + src[y0, x1] * fx * (1 - fy) + src[y1, x0] * (1 - fx) * fy + src[y1, x1] * fx * fy)

for N, OUT in ((2048, TEX / 'sky'), (1024, TEX / 'sky_1k')):
    t = (np.arange(N) + 0.5) / N * 2 - 1
    sc, tc = np.meshgrid(t, t)                              # sc across, tc down (row 0 = t 0)
    one = np.ones_like(sc)
    FACES = {  # OpenGL: +X (s=-z, t=-y), -X (s=z, t=-y), +Y (s=x, t=z), -Y (s=x, t=-z), +Z (s=x, t=-y), -Z (s=-x, t=-y)
        'px': (one, -tc, -sc), 'nx': (-one, -tc, sc), 'py': (sc, one, tc),
        'ny': (sc, -one, -tc), 'pz': (sc, -tc, one), 'nz': (-sc, -tc, -one),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (a, b, c) in FACES.items():
        d = np.stack([a, b, c], -1); d /= np.linalg.norm(d, axis=-1, keepdims=True)
        lin = np.clip(sample(d) * EXPOSURE - FLOOR, 0, None)
        srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
        Image.fromarray((np.clip(srgb, 0, 1)[::-1] * 255 + 0.5).astype(np.uint8)).save(OUT / f'{name}.jpg', quality=90, optimize=True)
        print(OUT.name, name, (OUT / f'{name}.jpg').stat().st_size // 1024, 'KB')
