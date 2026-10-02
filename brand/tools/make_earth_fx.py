"""Effects texture for the 3D globe (globe.html): one equirectangular RGB JPEG.

    R = cloud density (NASA Blue Marble clouds, contrast-shaped, polar ice suppressed)
    G = water mask (1 = ocean or lake; from Natural Earth land, used for the sun glint)
    B = soft cloud density (blurred R, used for cloud shadows and the soft cloud edge)
    The image starts at longitude 0 (not -180), matching the texture coordinates of Cesium.EllipsoidGeometry.

    python make_earth_fx.py   ->  brand/textures/earth_fx_8k.jpg, earth_fx_4k.jpg and earth_fx_2k.jpg (phones)
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
HERE = Path(__file__).resolve().parent
SRC = HERE.parent / 'source'
TEX = HERE.parent / 'textures'
W, H = 8192, 4096

clouds = np.asarray(Image.open(SRC / 'cloud_combined_8192.tif').convert('L').resize((W, H), Image.LANCZOS), np.float32) / 255
lat = np.linspace(90, -90, H, dtype=np.float32)[:, None]
# the source shows Antarctica's ice sheet as "cloud"; fade it out south of ~65 S (real clouds there are thin anyway)
polar = 1 - 0.75 * np.clip((-lat - 64) / 10, 0, 1)
c = np.clip((clouds - 0.06) / 0.82, 0, 1) ** 1.15 * polar
soft = np.asarray(Image.fromarray((c * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6)), np.float32) / 255

land = np.asarray(Image.open(TEX / 'land_8k.png').convert('L').resize((W, H), Image.BOX), np.float32) / 255
water = 1 - land

rgb = np.stack([c, water, soft], -1)
# Cesium's EllipsoidGeometry starts its texture at longitude 0 (s = lon/360), not at -180 like the sources: roll half a turn
rgb = np.roll(rgb, W // 2, axis=1)
img = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
img.save(TEX / 'earth_fx_8k.jpg', quality=80, subsampling=0, optimize=True)
img.resize((4096, 2048), Image.LANCZOS).save(TEX / 'earth_fx_4k.jpg', quality=84, subsampling=0, optimize=True)
img.resize((2048, 1024), Image.LANCZOS).save(TEX / 'earth_fx_2k.jpg', quality=88, subsampling=0, optimize=True)   # phones
for n in ('earth_fx_8k.jpg', 'earth_fx_4k.jpg', 'earth_fx_2k.jpg'):
    print(n, (TEX / n).stat().st_size // 1024, 'KB')
