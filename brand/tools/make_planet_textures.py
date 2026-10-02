"""Planet textures for solar.html: Solar System Scope maps (CC BY 4.0, solarsystemscope.com/textures) resized for the web.

    python make_planet_textures.py   (sources in brand/source/planets/, gitignored)
    ->  brand/textures/planets/<body>.jpg (desktop, up to 4096 wide) and <body>_2k.jpg (phones, 2048)
"""
from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = Path(__file__).resolve().parent
SRC = HERE.parent / 'source' / 'planets'
OUT = HERE.parent / 'textures' / 'planets'
OUT.mkdir(parents=True, exist_ok=True)
MAPS = {  # output name: (source file, desktop width)
    'sun': ('2k_sun.jpg', 2048), 'mercury': ('2k_mercury.jpg', 2048), 'venus': ('4k_venus_atmosphere.jpg', 4096),
    'earth': ('8k_earth_daymap.jpg', 4096), 'earth_night': ('8k_earth_nightmap.jpg', 4096),
    'earth_clouds': ('8k_earth_clouds.jpg', 4096), 'moon': ('8k_moon.jpg', 4096), 'mars': ('8k_mars.jpg', 4096),
    'jupiter': ('8k_jupiter.jpg', 4096), 'saturn': ('8k_saturn.jpg', 4096), 'uranus': ('2k_uranus.jpg', 2048),
    'neptune': ('2k_neptune.jpg', 2048),
}
for name, (src, w) in MAPS.items():
    im = Image.open(SRC / src)
    im = im.convert('L') if name == 'earth_clouds' else im.convert('RGB')
    for suffix, width in (('', w), ('_2k', 2048)):
        r = im.resize((width, width // 2), Image.LANCZOS) if im.width != width else im
        r.save(OUT / f'{name}{suffix}.jpg', quality=86, optimize=True, progressive=True)
# Saturn's rings: a radial strip (inner edge at the left), RGBA
ring = Image.open(SRC / '8k_saturn_ring_alpha.png').convert('RGBA')
ring.resize((2048, 64), Image.LANCZOS).save(OUT / 'saturn_ring.png', optimize=True)
total = sum(f.stat().st_size for f in OUT.iterdir())
print(len(list(OUT.iterdir())), 'files', total // 1024, 'KB')

# The Milky Way seen from above: NASA/JPL-Caltech/R. Hurt (SSC/Caltech), ssc2008-10a1 (spitzer.caltech.edu).
# Galactic centre at the image centre, the Sun ~26,000 ly straight below it, longitude 90 deg to the left
# (= seen from the north galactic pole). solar.html maps the 5600 px square to 115,000 ly.
mw = Image.open(SRC / 'milkyway_ssc2008-10a1.jpg').convert('RGB')
for suffix, width in (('', 4096), ('_2k', 2048)):
    mw.resize((width, width), Image.LANCZOS).save(OUT / f'milkyway{suffix}.jpg', quality=88, optimize=True)
print('milkyway', (OUT / 'milkyway.jpg').stat().st_size // 1024, 'KB')
