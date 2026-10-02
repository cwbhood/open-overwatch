"""Galaxy catalogue for the cosmic-web finale: the 2MASS Redshift Survey (2MRS; Huchra et al. 2012, ApJS 199, 26).

    python make_galaxies.py   (VizieR download cached in brand/source/2mrs/, gitignored)
    ->  data/solar/galaxies.bin   little-endian Float32 records [x, y, z, M_K], x/y/z in Mpc
        data/solar/galaxies.json  description

Frame: equatorial J2000 (x toward RA 0 Dec 0, y toward RA 90 deg Dec 0, z toward the north celestial pole), centred
on the Sun. Distance = cz_CMB / H0 with H0 = 70 km/s/Mpc (plain Hubble law, no peculiar-velocity model; fine past
~20 Mpc, "fingers of god" stretch clusters along the line of sight). cz_CMB adds the Sun's motion against the CMB
(369.82 km/s toward l = 264.021, b = 48.253 deg; Planck 2018) to the catalogue's barycentric cz. Galaxies without a
redshift or with cz_CMB < 300 km/s (Local Group / Local Volume, where the Hubble law is meaningless) are skipped.
M_K = Ktmag - 5 log10(d / 10 pc): absolute total Ks magnitude (extinction-corrected, no k-correction).
"""
import json, math, struct, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SRC = HERE.parent / 'source' / '2mrs'
SRC.mkdir(parents=True, exist_ok=True)
URL = ('https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=J/ApJS/199/26/table3&-out.max=unlimited'
       '&-out=ID,RAJ2000,DEJ2000,GLON,GLAT,Ktmag,cz')
H0, CZ_MIN = 70.0, 300.0
V_SUN, L_APEX, B_APEX = 369.82, 264.021, 48.253

raw = SRC / 'table3.tsv'
if not raw.exists():
    print('download', URL)
    req = urllib.request.Request(URL, headers={'User-Agent': 'open-overwatch make_galaxies.py'})
    with urllib.request.urlopen(req, timeout=600) as r:
        raw.write_bytes(r.read())


def unit(lon, lat):
    lon, lat = math.radians(lon), math.radians(lat)
    return math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)


apex = unit(L_APEX, B_APEX)
recs, total, no_z, near = [], 0, 0, 0
cols = None
for line in raw.read_text(encoding='utf-8').splitlines():
    if not line or line.startswith('#'):
        continue
    f = [s.strip() for s in line.split('\t')]
    if cols is None:
        cols = {k: i for i, k in enumerate(f)}
        continue
    if not f[cols['RAJ2000']][:1].isdigit():  # the units and dashes rows under the header, blank lines
        continue
    total += 1
    if not f[cols['cz']]:
        no_z += 1
        continue
    g = unit(float(f[cols['GLON']]), float(f[cols['GLAT']]))
    cz = float(f[cols['cz']]) + V_SUN * sum(a * b for a, b in zip(g, apex))
    if cz < CZ_MIN:
        near += 1
        continue
    d = cz / H0
    x, y, z = (d * c for c in unit(float(f[cols['RAJ2000']]), float(f[cols['DEJ2000']])))
    mk = float(f[cols['Ktmag']]) - 5 * math.log10(d * 1e5)
    recs.append((x, y, z, mk))

recs.sort(key=lambda r: r[3])  # brightest first, so a renderer can take a prefix for a lighter LOD
out = ROOT / 'data' / 'solar' / 'galaxies.bin'
out.write_bytes(b''.join(struct.pack('<4f', *r) for r in recs))
dist = sorted(math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2) for r in recs)
meta = {
    'count': len(recs), 'H0': H0, 'frame': 'equatorial J2000', 'units': 'Mpc', 'origin': 'Sun',
    'record': 'little-endian Float32 x4 = 16 bytes: [x, y, z, M_K]',
    'fields': {'x': 'Mpc toward RA 0, Dec 0', 'y': 'Mpc toward RA 90 deg, Dec 0', 'z': 'Mpc toward the north celestial pole',
               'M_K': 'absolute Ks magnitude (Ktmag - 5 log10(d/10 pc)); lower = brighter; records sorted by it'},
    'distance': f'cz_CMB / H0 (Hubble law, no peculiar-velocity correction); cz_CMB = barycentric cz + {V_SUN} km/s '
                f'toward l={L_APEX}, b={B_APEX} (Sun vs CMB, Planck 2018)',
    'cuts': f'skipped {no_z} without redshift and {near} with cz_CMB < {CZ_MIN:g} km/s, of {total}',
    'distance_Mpc': {'min': round(dist[0], 2), 'median': round(dist[len(dist) // 2], 1), 'max': round(dist[-1], 1)},
    'M_K_range': [round(recs[0][3], 2), round(recs[-1][3], 2)],
    'source': '2MASS Redshift Survey (2MRS), Huchra et al. 2012, ApJS 199, 26; VizieR J/ApJS/199/26 table3 '
              '(Ks <= 11.75, |b| > 5 deg, 8 deg near the Galactic centre)',
    'source_url': URL,
    'licence': 'free use with citation (CDS VizieR terms; cite Huchra et al. 2012)',
    'credit': 'Huchra et al. 2012 (2MRS), 2MASS (UMass/IPAC-Caltech, NASA/NSF); VizieR, CDS Strasbourg',
    'build': 'brand/tools/make_galaxies.py',
}
(ROOT / 'data' / 'solar' / 'galaxies.json').write_text(json.dumps(meta, indent=1))
print(meta['count'], 'galaxies;', meta['cuts'], ';', meta['distance_Mpc'], ';', out.stat().st_size // 1024, 'KB')
