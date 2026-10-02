"""Moon surface maps for solar.html: USGS Astrogeology global mosaics resized for the web.

    python make_moon_textures.py   (raw downloads cached in brand/source/moons/, gitignored)
    ->  brand/textures/moons/<name>.jpg (2048x1024), <name>_1k.jpg (1024x512, phones) and maps.json

Sources: the USGS planetary WMS (planetarymaps.usgs.gov/cgi-bin/mapserv, one map file per body) asked for a
4096x2048 PNG in EPSG:4326 with bbox -180,-90,180,90, so every output is simple cylindrical, longitude EAST-positive,
-180 deg E at the left edge, 0 deg at the centre, +180 deg E at the right edge, north up (checked against known
features: Herschel on Mimas, Pele on Io, Valhalla on Callisto, Cassini Regio on Iapetus, Inktomi on Rhea, Xanadu on
Titan). Phobos uses the DLR HRSC/SRC GeoTIFF directly (its label: PositiveEast, -180..180), same convention.
The Uranian moons (Miranda, Ariel, Umbriel, Titania, Oberon) have no geospatial global map from USGS/NASA (Voyager 2
saw only their southern hemispheres; the USGS airbrush sheets are PDFs) so they keep their procedural surfaces.
"""
import io, json, urllib.request
from pathlib import Path
from PIL import Image, ImageFilter, ImageChops, ImageStat

Image.MAX_IMAGE_PIXELS = None
HERE = Path(__file__).resolve().parent
SRC = HERE.parent / 'source' / 'moons'
OUT = HERE.parent / 'textures' / 'moons'
SRC.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
WMS = ('https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/{map}_simp_cyl.map&service=WMS&version=1.1.1'
       '&request=GetMap&layers={layer}&styles=&srs=EPSG:4326&bbox=-180,-90,180,90&width=4096&height=2048'
       '&format=image/png&transparent=TRUE')
PD = 'public domain (NASA/USGS)'
MOONS = {  # name: source description
    'phobos': dict(url='https://planetarymaps.usgs.gov/mosaic/Phobos_ME_SRC_Mosaic_Global_16ppd.tif',
                   credit='ESA/DLR/FU Berlin (Mars Express HRSC-SRC), K. Willner et al.; via USGS Astrogeology',
                   licence='ESA/DLR/FU Berlin, free use with credit (ESA imagery: CC BY-SA 3.0 IGO)',
                   notes='Mars Express SRC global mosaic, 16 px/deg; small polar gaps filled'),
    'deimos': dict(map='mars/deimos', layer='VIKING', credit='NASA/JPL Viking; map by P. Stooke; USGS Astrogeology',
                   licence=PD, notes='Viking-based cylindrical map (Stooke 2001); a hand-made map, coarse'),
    'io': dict(map='jupiter/io', layer='SSI_VGR_color', credit='NASA/JPL/USGS (Galileo SSI + Voyager)',
               licence=PD, notes='Galileo SSI / Voyager merged colour mosaic, 1 km/px'),
    'europa': dict(map='jupiter/europa', layer='GALILEO_VOYAGER', credit='NASA/JPL/USGS (Galileo SSI + Voyager)',
                   licence=PD, notes='greyscale; low-resolution gap fill in places'),
    'ganymede': dict(map='jupiter/ganymede', layer='GALILEO_VOYAGER', credit='NASA/JPL/USGS (Galileo SSI + Voyager)',
                     licence=PD, notes='greyscale (USGS also has a 199 MB colour mosaic, not used)'),
    'callisto': dict(map='jupiter/callisto', layer='GALILEO_VOYAGER', credit='NASA/JPL/USGS (Galileo SSI + Voyager)',
                     licence=PD, notes='greyscale; 60 km/px gap fill in places'),
    'mimas': dict(map='saturn/mimas', layer='CASSINI_VOYAGER', credit='NASA/JPL/Space Science Institute',
                  licence=PD, notes='Cassini ISS with Voyager gap fill (CICLOPS, 2010)'),
    'enceladus': dict(map='saturn/enceladus', layer='CASSINI', credit='NASA/JPL/Space Science Institute',
                      licence=PD, notes='Cassini ISS global mosaic'),
    'tethys': dict(map='saturn/tethys', layer='CASSINI', credit='NASA/JPL/Space Science Institute',
                   licence=PD, notes='Cassini ISS global mosaic (PIA14931)'),
    'dione': dict(map='saturn/dione', layer='CASSINI_VOYAGER', credit='NASA/JPL/Space Science Institute',
                  licence=PD, notes='Cassini ISS with Voyager gap fill'),
    'rhea': dict(map='saturn/rhea', layer='CASSINI_VOYAGER', credit='NASA/JPL/Space Science Institute',
                 licence=PD, notes='Cassini ISS with Voyager gap fill (PIA12803)'),
    'titan': dict(map='saturn/titan', layer='CASSINI', credit='NASA/JPL-Caltech/Space Science Institute',
                  licence=PD, notes='Cassini ISS 938 nm albedo map (PIA19658); no shading (seen through haze)'),
    'iapetus': dict(map='saturn/iapetus', layer='CASSINI_VOYAGER', credit='NASA/JPL/Space Science Institute',
                    licence=PD, notes='Cassini ISS with Voyager gap fill; brightness normalised, so the dark leading hemisphere (Cassini Regio, centred 90 W) is only mildly darker - tint it in the shader'),
    'triton': dict(map='neptune/triton', layer='TRITON_VOYAGER2', credit='NASA/JPL/USGS; colour mosaic by P. Schenk (LPI)',
                   licence=PD, notes='Voyager 2; only ~40% seen (southern hemisphere); unseen area filled'),
    'charon': dict(map='pluto/charon', layer='NEWHORIZONS_CHARON_MOSAIC',
                   credit='NASA/Johns Hopkins APL/Southwest Research Institute/LPI', licence=PD,
                   notes='New Horizons LORRI/MVIC 300 m/px; encounter hemisphere only, unseen area filled'),
}


def fetch(name, m):
    url = m.get('url') or WMS.format(**m)
    path = SRC / (name + ('.tif' if 'url' in m else '.png'))
    if not path.exists():
        print('download', name, url)
        req = urllib.request.Request(url, headers={'User-Agent': 'open-overwatch make_moon_textures.py'})
        with urllib.request.urlopen(req, timeout=600) as r:
            data = r.read()
        Image.open(io.BytesIO(data)).verify()  # an XML error page from the WMS fails here
        path.write_bytes(data)
    return url, Image.open(path)


def fill_gaps(im, seen):
    """No-data pixels (seen == 0) -> per-latitude mean of the seen pixels, weighted by the row's coverage
    against the global mean, blurred; the seam is feathered. Returns the image and the filled fraction."""
    frac = 1 - ImageStat.Stat(seen).mean[0] / 255
    if frac < 0.001:
        return im, 0.0
    w, h = im.size
    gmean = tuple(int(v) for v in ImageStat.Stat(im, mask=seen).mean)
    rows = Image.new(im.mode, (1, h))
    for y in range(h):
        box = (0, y, w, y + 1)
        msk = seen.crop(box)
        cov = ImageStat.Stat(msk).mean[0] / 255  # rows mostly unseen lean on the global mean (limb colours skew)
        rmean = ImageStat.Stat(im.crop(box), mask=msk).mean if cov else gmean
        rows.putpixel((0, y), tuple(int(cov * v + (1 - cov) * gv) for v, gv in zip(rmean, gmean)))
    base = rows.resize((w, h), Image.NEAREST).filter(ImageFilter.GaussianBlur(h // 40))
    feather = seen.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.GaussianBlur(6))  # fade 10 px inside the edge
    return Image.composite(im, base, feather), frac


def save(im, path, limit):
    for q in (85, 82, 78, 74, 70):
        im.save(path, quality=q, optimize=True, progressive=True)
        if path.stat().st_size <= limit:
            return q
    return q


meta = {}
for name, m in MOONS.items():
    url, im = fetch(name, m)
    # seen = WMS alpha (transparent=TRUE marks no-data) and not pure black (gaps inside the GeoTIFF / mosaics)
    alpha = im.convert('RGBA').getchannel('A').point(lambda v: 255 if v > 127 else 0)
    im = im.convert('RGB')
    seen = ImageChops.multiply(alpha, im.convert('L').point(lambda v: 255 if v > 3 else 0))
    r, g, b = im.split()
    grey = all(ImageStat.Stat(ImageChops.difference(a, c), mask=seen).mean[0] < 0.5 for a, c in ((r, g), (g, b)))
    if grey:
        im = r
    if im.size != (4096, 2048):
        im, seen = im.resize((4096, 2048), Image.LANCZOS), seen.resize((4096, 2048), Image.NEAREST)
    im, frac = fill_gaps(im, seen)
    q2 = save(im.resize((2048, 1024), Image.LANCZOS), OUT / f'{name}.jpg', 600_000)
    q1 = save(im.resize((1024, 512), Image.LANCZOS), OUT / f'{name}_1k.jpg', 200_000)
    meta[name.capitalize()] = dict(
        file=f'brand/textures/moons/{name}.jpg', file_1k=f'brand/textures/moons/{name}_1k.jpg', source_url=url,
        credit=m['credit'], licence=m['licence'], left_edge_lon_east=-180, lon_positive='east',
        greyscale=grey, filled_fraction=round(frac, 3), notes=m['notes'])
    print(f'{name:10s} grey={grey!s:5s} filled={frac:.1%} q={q2}/{q1} '
          f'{(OUT / f"{name}.jpg").stat().st_size // 1024} KB / {(OUT / f"{name}_1k.jpg").stat().st_size // 1024} KB')

doc = {'_about': 'Simple cylindrical (equirectangular) moon maps, 2:1, north up. Every file: longitude east-positive, '
                 '-180 deg E at the left edge, 0 at the centre (u = (lon_east + 180) / 360). Uranian moons have no '
                 'global map (Voyager 2 saw only their southern hemispheres). Rebuild: brand/tools/make_moon_textures.py',
       'maps': meta}
(OUT / 'maps.json').write_text(json.dumps(doc, indent=1))
print(len(meta), 'maps,', sum(f.stat().st_size for f in OUT.glob('*.jpg')) // 1024, 'KB total')
