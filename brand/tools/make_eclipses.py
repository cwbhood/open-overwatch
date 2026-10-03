"""Solar eclipses 2027-2030 for the globe: the Sun and Moon minute by minute from JPL Horizons -> data/eclipses.json

    python make_eclipses.py        (Horizons answers cached in brand/source/horizons/eclipses/)

For each eclipse: geocentric apparent positions (light time + stellar aberration, VEC_CORR=LT+S) of the Sun and the Moon
in the ICRF, km, every minute (UT) while the Moon's penumbra touches the Earth, plus 15 minutes either side. The globe
turns them into the shadow on the ground with Cesium's ICRF -> Earth-fixed rotation (src/core/eclipse.js does the
geometry). The window is found from a 10-minute pass over 36 hours around each date.
"""
import json, math, time, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE.parent / 'source' / 'horizons' / 'eclipses'
# date, type (NASA Five Millennium Canon)
ECLIPSES = [('2027-02-06', 'annular'), ('2027-08-02', 'total'), ('2028-01-26', 'annular'), ('2028-07-22', 'total'),
            ('2029-01-14', 'partial'), ('2029-06-12', 'partial'), ('2029-07-11', 'partial'), ('2029-12-05', 'partial'),
            ('2030-06-01', 'annular'), ('2030-11-25', 'total')]
R_SUN, R_MOON, R_EARTH = 695700.0, 1737.4, 6378.137


def vectors(body, start, stop, step):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f'{body}_{start}_{stop}_{step}.txt'.replace(':', '').replace(' ', 'T')
    if not f.exists():
        q = {'format': 'json', 'COMMAND': f"'{body}'", 'EPHEM_TYPE': 'VECTORS', 'CENTER': "'500@399'", 'REF_SYSTEM': 'ICRF', 'REF_PLANE': 'FRAME',
             'VEC_CORR': "'LT+S'", 'OUT_UNITS': 'KM-S', 'VEC_TABLE': '1', 'CSV_FORMAT': 'YES', 'TIME_TYPE': 'UT', 'OBJ_DATA': 'NO',
             'START_TIME': f"'{start}'", 'STOP_TIME': f"'{stop}'", 'STEP_SIZE': f"'{step}'"}
        f.write_text(json.load(urllib.request.urlopen('https://ssd.jpl.nasa.gov/api/horizons.api?' + urllib.parse.urlencode(q), timeout=120))['result'])
        time.sleep(1.0)
    txt = f.read_text()
    rows = []
    for line in txt[txt.index('$$SOE') + 5:txt.index('$$EOE')].strip().splitlines():
        c = [x.strip() for x in line.split(',')]
        rows.append((float(c[0]), float(c[2]), float(c[3]), float(c[4])))   # JD (UT), x, y, z
    return rows


def penumbra_touches(sun, moon):
    """Does the Moon's penumbral cone reach the Earth? Distance of the shadow axis from Earth's centre vs cone radius."""
    a = [m - s for m, s in zip(moon, sun)]; L = math.sqrt(sum(x * x for x in a)); a = [x / L for x in a]
    t = -sum(m * x for m, x in zip(moon, a))                  # along the axis from the Moon to the point nearest Earth
    if t < 0:
        return False
    d = math.sqrt(sum((m + x * t) ** 2 for m, x in zip(moon, a)))
    f1 = math.asin((R_SUN + R_MOON) / L)
    return d < R_EARTH + R_MOON / math.cos(f1) + t * math.tan(f1)


def jd_to_iso(jd):
    t = (jd - 2440587.5) * 86400
    return time.strftime('%Y-%m-%d %H:%M', time.gmtime(round(t / 60) * 60))


out = []
for date, kind in ECLIPSES:
    y, m, d = map(int, date.split('-'))
    t0 = time.strftime('%Y-%m-%d %H:%M', time.gmtime(time.mktime((y, m, d, 0, 0, 0, 0, 0, 0)) - time.timezone - 6 * 3600))
    t1 = time.strftime('%Y-%m-%d %H:%M', time.gmtime(time.mktime((y, m, d, 0, 0, 0, 0, 0, 0)) - time.timezone + 30 * 3600))
    S, M = vectors(10, t0, t1, '10m'), vectors(301, t0, t1, '10m')
    hit = [s[0] for s, mo in zip(S, M) if penumbra_touches(s[1:], mo[1:])]
    if not hit:
        print(date, 'no penumbral contact found?'); continue
    a, b = jd_to_iso(min(hit) - 25 / 1440), jd_to_iso(max(hit) + 25 / 1440)
    S, M = vectors(10, a, b, '1m'), vectors(301, a, b, '1m')
    out.append({'date': date, 'type': kind, 'jd0': S[0][0], 'step_s': 60,
                'sun': [[round(v, 1) for v in s[1:]] for s in S], 'moon': [[round(v, 3) for v in mo[1:]] for mo in M]})
    print(date, kind, a, '->', b, len(S), 'minutes')
dst = ROOT / 'data' / 'eclipses.json'
dst.write_text(json.dumps({'source': 'JPL Horizons, geocentric apparent (LT+S) ICRF vectors, km, UT', 'frame': 'ICRF, Earth-centred',
                           'radii_km': {'sun': R_SUN, 'moon': R_MOON}, 'eclipses': out}, separators=(',', ':')))
print(len(out), 'eclipses ->', dst, dst.stat().st_size // 1024, 'KB')
