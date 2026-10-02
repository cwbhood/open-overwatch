"""Major moons for the Solar System view: orbits fitted near the present from JPL Horizons -> data/solar/moons.json.

    python make_moons.py      (Horizons responses cached in brand/source/horizons/moons/)

For each moon, Horizons gives osculating elements relative to its planet (ecliptic J2000) at five dates a quarter apart
(2026-01-01 .. 2027-01-01). From them we keep a, e, i and fit linear rates for the node, the periapsis and the mean
longitude (unwrapped quarter by quarter, so even Io's fast apsidal motion and Phobos' 7.7 h orbit are counted right).
JPL's year-2000 mean-element table was tried first: its rounded periods (Phobos: 4 digits) drift by whole orbits over
26 years. These fits are good to about a degree for a few years either side of 2026; src/core/moons.js documents it and
test/moons.test.mjs checks it against Horizons.
"""
import json, re, time, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE.parent / 'source' / 'horizons' / 'moons'
EPOCHS = [2461041.5, 2461132.75, 2461224.0, 2461315.25, 2461406.5]   # 2026-01-01 .. 2027-01-01, every quarter
# planet, Horizons id of the planet centre, moons: (name, id, mean radius km)
SYSTEMS = [
    ('mars', 499, [('Phobos', 401, 11.08), ('Deimos', 402, 6.2)]),
    ('jupiter', 599, [('Io', 501, 1821.5), ('Europa', 502, 1560.8), ('Ganymede', 503, 2631.2), ('Callisto', 504, 2410.3)]),
    ('saturn', 699, [('Mimas', 601, 198.2), ('Enceladus', 602, 252.1), ('Tethys', 603, 531.0), ('Dione', 604, 561.4), ('Rhea', 605, 763.5), ('Titan', 606, 2574.7), ('Iapetus', 608, 734.3)]),
    ('uranus', 799, [('Miranda', 705, 235.8), ('Ariel', 701, 578.9), ('Umbriel', 702, 584.7), ('Titania', 703, 788.9), ('Oberon', 704, 761.4)]),
    ('neptune', 899, [('Triton', 801, 1352.6)]),
    ('pluto', 999, [('Charon', 901, 606.0)]),
]


def horizons_elements(moon_id, center):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f'{moon_id}.txt'
    if not f.exists():
        q = {'format': 'json', 'COMMAND': f"'{moon_id}'", 'EPHEM_TYPE': 'ELEMENTS', 'CENTER': f"'500@{center}'", 'REF_PLANE': 'ECLIPTIC',
             'REF_SYSTEM': 'J2000', 'OUT_UNITS': 'KM-D', 'TLIST': ' '.join(f"'{e}'" for e in EPOCHS), 'TIME_TYPE': 'TDB', 'OBJ_DATA': 'NO'}
        f.write_text(json.load(urllib.request.urlopen('https://ssd.jpl.nasa.gov/api/horizons.api?' + urllib.parse.urlencode(q), timeout=90))['result'])
        time.sleep(1.2)
    blk = f.read_text()
    blk = blk[blk.index('$$SOE'):blk.index('$$EOE')]
    rows = []
    for rec in re.split(r'\n(?=\d{7}\.\d+ = )', blk.replace('$$SOE\n', '')):
        g = dict(re.findall(r'\b([A-Z]{1,2})\s*=\s*(-?[\d.]+E[+-]\d+)', rec))
        if g:
            rows.append({k: float(v) for k, v in g.items()})
    return rows


def unwrap(series, guess_rate, dt):
    """Angles (deg) at equal steps dt -> continuous, using the expected rate to pick whole turns between samples."""
    out = [series[0]]
    for a in series[1:]:
        expect = out[-1] + guess_rate * dt
        out.append(a + 360 * round((expect - a) / 360))
    return out


def fit_rate(values, dt):
    n = len(values); xs = [k * dt for k in range(n)]; mx = sum(xs) / n; my = sum(values) / n
    return sum((x - mx) * (y - my) for x, y in zip(xs, values)) / sum((x - mx) ** 2 for x in xs)


moons = []
for planet, center, members in SYSTEMS:
    for name, mid, radius in members:
        rows = horizons_elements(mid, center)
        assert len(rows) == len(EPOCHS), (name, len(rows))
        dt = EPOCHS[1] - EPOCHS[0]
        n_osc = sum(r['N'] for r in rows) / len(rows)                                  # deg/day
        lam = unwrap([r['OM'] + r['W'] + r['MA'] for r in rows], n_osc, dt)
        node = unwrap([r['OM'] for r in rows], 0, dt)
        peri = unwrap([r['OM'] + r['W'] for r in rows], 0, dt)                        # longitude of periapsis
        n, node_rate, varpi_rate = fit_rate(lam, dt), fit_rate(node, dt), fit_rate(peri, dt)
        r0 = rows[0]
        moons.append({'planet': planet, 'name': name, 'id': mid, 'epoch_jd': EPOCHS[0], 'radius_km': radius,
                      'a_km': round(sum(r['A'] for r in rows) / len(rows), 1), 'e': round(sum(r['EC'] for r in rows) / len(rows), 6),
                      'i': round(sum(r['IN'] for r in rows) / len(rows), 4), 'node': round(node[0], 4), 'varpi': round(peri[0], 4),
                      'lambda': round(lam[0], 4), 'n': n, 'node_rate': node_rate, 'varpi_rate': varpi_rate})
        print(f"{name:10s} a {moons[-1]['a_km']:>11,.0f} km  P {360 / n:9.5f} d  node {node_rate * 365.25:8.2f} deg/yr  periapsis {varpi_rate * 365.25:8.2f} deg/yr")
dst = ROOT / 'data' / 'solar' / 'moons.json'
dst.write_text(json.dumps({'source': 'JPL Horizons osculating elements, fitted over 2026 (brand/tools/make_moons.py)', 'frame': 'planet-centred ecliptic J2000; angles in degrees, rates per day', 'moons': moons}, indent=1))
print(len(moons), 'moons ->', dst)
