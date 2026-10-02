"""Build the star catalogue for solar.html from the HYG database.

    python brand/tools/make_stars.py

Source: HYG star database v4.x (astronexus/HYG-Database, CC BY-SA 4.0), cached in brand/source/hyg/.
Frame: heliocentric ECLIPTIC J2000, light-years (x -> vernal equinox, z -> ecliptic north pole).

Outputs
  data/solar/stars.bin   little-endian Float32, column-major, N stars sorted by distance (ascending):
                         x[N] y[N] z[N] (ly) | absmag[N] | ci[N] (B-V, 0.65 when missing)
  data/solar/stars.json  {count, source, license, layout, named: [[index, name, dist_ly, spect], ...]}
"""
import csv, json, math, os, struct, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.path.join(ROOT, 'brand', 'source', 'hyg')
OUT = os.path.join(ROOT, 'data', 'solar')
RAW = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/'
CANDIDATES = ['hygdata_v41.csv', 'hygdata_v40.csv.gz']   # newest first

PC_LY = 3.26156
EPS = math.radians(23.4392911)          # obliquity of the ecliptic, J2000
NEAREST_UNNAMED = 50

# Common names for nearby stars HYG leaves without a proper name (keyed by HYG "gl").
COMMON = {
    'Gl 65A': 'Luyten 726-8 A', 'Gl 65B': 'UV Ceti (Luyten 726-8 B)', 'Gl 244B': 'Sirius B',
    'Gl 280B': 'Procyon B', 'Gl 820A': '61 Cygni A', 'Gl 820B': '61 Cygni B',
    'Gl 15A': 'Groombridge 34 A', 'Gl 15B': 'Groombridge 34 B', 'Gl 845': 'Epsilon Indi',
    'GJ 1111': 'DX Cancri', 'Gl 71': 'Tau Ceti', 'Gl 54.1': 'YZ Ceti', 'Gl 860A': 'Kruger 60 A',
    'Gl 860B': 'Kruger 60 B', 'Gl 234A': 'Ross 614 A', 'Gl 234B': 'Ross 614 B',
    'Gl 473A': 'Wolf 424 A', 'Gl 473B': 'Wolf 424 B', 'Gl 83.1': 'TZ Arietis',
    'Gl 412A': 'Lalande 21258 A', 'Gl 412B': 'WX Ursae Majoris', 'Gl 380': 'Groombridge 1618',
    'Gl 388': 'AD Leonis', 'Gl 166A': '40 Eridani A', 'Gl 166B': '40 Eridani B', 'Gl 166C': '40 Eridani C',
    'Gl 702A': '70 Ophiuchi A', 'Gl 702B': '70 Ophiuchi B', 'Gl 873': 'EV Lacertae',
    'Gl 169.1A': 'Stein 2051 A', 'Gl 169.1B': 'Stein 2051 B', 'Gl 644B': 'Wolf 630 B', 'Gl 644C': 'VB 8',
    'Gl 725A': 'Struve 2398 A', 'Gl 725B': 'Struve 2398 B', 'Gl 191': "Kapteyn's Star",
    'Gl 825': 'Lacaille 8760', 'Gl 887': 'Lacaille 9352', 'Gl 729': 'Ross 154', 'Gl 905': 'Ross 248',
    'Gl 447': 'Ross 128', 'Gl 144': 'Epsilon Eridani', 'Gl 273': "Luyten's Star", 'Gl 866': 'EZ Aquarii',
    'Gl 411': 'Lalande 21185', 'Gl 406': 'Wolf 359', 'Gl 699': "Barnard's Star", 'Gl 551': 'Proxima Centauri',
}
# Proper names swapped for the better-known designation in labels.
RENAME = {'Rigil Kentaurus': 'Alpha Centauri A', 'Toliman': 'Alpha Centauri B'}
MUST_HAVE = ['Proxima Centauri', 'Alpha Centauri A', 'Alpha Centauri B', "Barnard's Star", 'Sirius',
             'Betelgeuse', 'Polaris', 'Vega', 'Rigel']

GREEK = {'Alp': 'Alpha', 'Bet': 'Beta', 'Gam': 'Gamma', 'Del': 'Delta', 'Eps': 'Epsilon', 'Zet': 'Zeta',
         'Eta': 'Eta', 'The': 'Theta', 'Iot': 'Iota', 'Kap': 'Kappa', 'Lam': 'Lambda', 'Mu': 'Mu',
         'Nu': 'Nu', 'Xi': 'Xi', 'Omi': 'Omicron', 'Pi': 'Pi', 'Rho': 'Rho', 'Sig': 'Sigma', 'Tau': 'Tau',
         'Ups': 'Upsilon', 'Phi': 'Phi', 'Chi': 'Chi', 'Psi': 'Psi', 'Ome': 'Omega'}
GENITIVE = {
    'And': 'Andromedae', 'Ant': 'Antliae', 'Aps': 'Apodis', 'Aqr': 'Aquarii', 'Aql': 'Aquilae', 'Ara': 'Arae',
    'Ari': 'Arietis', 'Aur': 'Aurigae', 'Boo': 'Bootis', 'Cae': 'Caeli', 'Cam': 'Camelopardalis',
    'Cnc': 'Cancri', 'CVn': 'Canum Venaticorum', 'CMa': 'Canis Majoris', 'CMi': 'Canis Minoris',
    'Cap': 'Capricorni', 'Car': 'Carinae', 'Cas': 'Cassiopeiae', 'Cen': 'Centauri', 'Cep': 'Cephei',
    'Cet': 'Ceti', 'Cha': 'Chamaeleontis', 'Cir': 'Circini', 'Col': 'Columbae', 'Com': 'Comae Berenices',
    'CrA': 'Coronae Australis', 'CrB': 'Coronae Borealis', 'Crv': 'Corvi', 'Crt': 'Crateris', 'Cru': 'Crucis',
    'Cyg': 'Cygni', 'Del': 'Delphini', 'Dor': 'Doradus', 'Dra': 'Draconis', 'Equ': 'Equulei',
    'Eri': 'Eridani', 'For': 'Fornacis', 'Gem': 'Geminorum', 'Gru': 'Gruis', 'Her': 'Herculis',
    'Hor': 'Horologii', 'Hya': 'Hydrae', 'Hyi': 'Hydri', 'Ind': 'Indi', 'Lac': 'Lacertae', 'Leo': 'Leonis',
    'LMi': 'Leonis Minoris', 'Lep': 'Leporis', 'Lib': 'Librae', 'Lup': 'Lupi', 'Lyn': 'Lyncis',
    'Lyr': 'Lyrae', 'Men': 'Mensae', 'Mic': 'Microscopii', 'Mon': 'Monocerotis', 'Mus': 'Muscae',
    'Nor': 'Normae', 'Oct': 'Octantis', 'Oph': 'Ophiuchi', 'Ori': 'Orionis', 'Pav': 'Pavonis',
    'Peg': 'Pegasi', 'Per': 'Persei', 'Phe': 'Phoenicis', 'Pic': 'Pictoris', 'Psc': 'Piscium',
    'PsA': 'Piscis Austrini', 'Pup': 'Puppis', 'Pyx': 'Pyxidis', 'Ret': 'Reticuli', 'Sge': 'Sagittae',
    'Sgr': 'Sagittarii', 'Sco': 'Scorpii', 'Scl': 'Sculptoris', 'Sct': 'Scuti', 'Ser': 'Serpentis',
    'Sex': 'Sextantis', 'Tau': 'Tauri', 'Tel': 'Telescopii', 'Tri': 'Trianguli', 'TrA': 'Trianguli Australis',
    'Tuc': 'Tucanae', 'UMa': 'Ursae Majoris', 'UMi': 'Ursae Minoris', 'Vel': 'Velorum', 'Vir': 'Virginis',
    'Vol': 'Volantis', 'Vul': 'Vulpeculae',
}


def fetch():
    os.makedirs(CACHE, exist_ok=True)
    for name in CANDIDATES:
        path = os.path.join(CACHE, name)
        if os.path.exists(path):
            return path
    for name in CANDIDATES:
        path = os.path.join(CACHE, name)
        try:
            print('downloading', RAW + name)
            urllib.request.urlretrieve(RAW + name, path + '.part')
            os.replace(path + '.part', path)
            return path
        except Exception as e:  # try the next candidate
            print('  failed:', e)
    sys.exit('could not fetch the HYG database')


def open_csv(path):
    if path.endswith('.gz'):
        import gzip
        return gzip.open(path, 'rt', encoding='utf-8', newline='')
    return open(path, encoding='utf-8', newline='')


def designation(r):
    """Fallback label for an unnamed star: common name, Bayer/Flamsteed, catalogue number."""
    if r['gl'] in COMMON:
        return COMMON[r['gl']]
    con = GENITIVE.get(r['con'], r['con'])
    comp = ''
    if r['gl'][-1:] in 'ABCD' and r['gl'][-2:-1].isdigit():
        comp = ' ' + r['gl'][-1]
    if r['bayer']:
        g = r['bayer'].rstrip('0123456789-')
        sup = r['bayer'][len(g):].lstrip('-')
        return f"{GREEK.get(g, g)}{('-' + sup) if sup else ''} {con}{comp}"
    if r['flam']:
        return f"{r['flam']} {con}{comp}"
    if r['gl']:
        return r['gl'].replace('Gl ', 'Gliese ')
    if r['hd']:
        return 'HD ' + r['hd']
    if r['hip']:
        return 'HIP ' + r['hip']
    return 'HYG ' + r['id']


def main():
    src = fetch()
    stars = []
    with open_csv(src) as f:
        for r in csv.DictReader(f):
            if r['id'] == '0':
                continue
            dist = float(r['dist'] or 1e9)
            if dist >= 100000 or dist <= 0:
                continue
            x, y, z = float(r['x']), float(r['y']), float(r['z'])
            ye = y * math.cos(EPS) + z * math.sin(EPS)
            ze = -y * math.sin(EPS) + z * math.cos(EPS)
            ci = r['ci'].strip()
            stars.append((dist, x * PC_LY, ye * PC_LY, ze * PC_LY,
                          float(r['absmag']), float(ci) if ci else 0.65, r))
    stars.sort(key=lambda s: s[0])
    n = len(stars)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'stars.bin'), 'wb') as f:
        for col in (1, 2, 3, 4, 5):
            f.write(struct.pack(f'<{n}f', *(s[col] for s in stars)))

    named, unnamed_left = [], NEAREST_UNNAMED
    for i, s in enumerate(stars):
        r = s[6]
        name = r['proper'].strip()
        if name:
            name = RENAME.get(name, name)
        elif unnamed_left > 0:
            name = designation(r)
            unnamed_left -= 1
        else:
            continue
        named.append([i, name, round(s[0] * PC_LY, 2), r['spect'].strip()])

    have = {e[1] for e in named}
    missing = [m for m in MUST_HAVE if m not in have]
    if missing:
        sys.exit(f'missing required names: {missing}')

    meta = {
        'count': n,
        'source': 'HYG star database ' + os.path.basename(src).split('.')[0].replace('hygdata_', '') +
                  ' by David Nash / astronexus (github.com/astronexus/HYG-Database)',
        'license': 'CC BY-SA 4.0',
        'frame': 'heliocentric ecliptic J2000, light-years',
        'layout': 'stars.bin: little-endian Float32 column-major, N=count: x[N] y[N] z[N] absmag[N] ci[N]; '
                  'sorted by distance ascending',
        'named': named,
    }
    with open(os.path.join(OUT, 'stars.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))

    # sanity checks
    by = {e[1]: e for e in named}
    for nm in ('Proxima Centauri', 'Alpha Centauri A', 'Sirius', 'Sirius B', "Barnard's Star", 'Vega',
               'Polaris', 'Betelgeuse', 'Rigel'):
        if nm in by:
            i = by[nm][0]
            x, y, z = stars[i][1:4]
            print(f'{nm:18s} idx {i:6d}  {math.sqrt(x*x+y*y+z*z):8.2f} ly  ecl ({x:+.2f},{y:+.2f},{z:+.2f})')
    print(f'{n} stars, {len(named)} named;',
          f"stars.bin {os.path.getsize(os.path.join(OUT, 'stars.bin'))} B,",
          f"stars.json {os.path.getsize(os.path.join(OUT, 'stars.json'))} B")


if __name__ == '__main__':
    main()
