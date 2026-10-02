"""Build deep-space spacecraft trajectories for solar.html from JPL Horizons.

    python brand/tools/make_spacecraft.py

Frame: heliocentric (Sun centre, 500@10) ECLIPTIC J2000, AU, TDB.
Raw Horizons responses are cached in brand/source/horizons/ (delete a file to refetch it).
Requests are sequential and at least 1 s apart.

Output data/solar/spacecraft.json:
  [{name, id, launch_jd, desc, events: [[jd, text], ...], t0_jd, step_days, n, end_jd,
    xyz: [x0, y0, z0, x1, ...]}]   # sample i is at t0_jd + i*step_days (uniform; interpolate by index)
"""
import datetime as dt, hashlib, json, math, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.path.join(ROOT, 'brand', 'source', 'horizons')
OUT = os.path.join(ROOT, 'data', 'solar', 'spacecraft.json')
API = 'https://ssd.jpl.nasa.gov/api/horizons.api'

GRID0 = 2440000.5            # sample times are GRID0 + k*step (0h TDB), so 5-day craft share planet samples
LIMIT_JD = None              # set in main(): 2035-01-01 00:00 TDB
CHECK_DATE = '2026-10-02'
MAX_POINTS = 5000

# events: (date 'YYYY-MM-DD[ HH:MM]' | 'auto', text, body for the closest-approach check or None)
# 'auto' events take the closest approach to `body` in the window (date range) given as the 4th item;
# 'end' events sit on the last sample of the track.
CRAFT = [
    dict(name='Voyager 1', id=-31, launch='1977-09-05 12:56', step=5,
         desc='Fastest-receding probe; flew past Jupiter and Saturn/Titan, first craft in interstellar space.',
         events=[('1979-03-05', 'Jupiter flyby', '599'), ('1980-11-12', 'Saturn flyby (Titan close pass)', '699'),
                 ('1990-02-14', '"Pale Blue Dot" family portrait of the Solar System', None),
                 ('1998-02-17', 'Overtook Pioneer 10 as the most distant human-made object', None),
                 ('2004-12-16', 'Crossed the termination shock', None),
                 ('2012-08-25', 'Crossed the heliopause into interstellar space', None)]),
    dict(name='Voyager 2', id=-32, launch='1977-08-20 14:29', step=5,
         desc='Grand Tour probe; the only spacecraft to visit Uranus and Neptune.',
         events=[('1979-07-09', 'Jupiter flyby', '599'), ('1981-08-26', 'Saturn flyby', '699'),
                 ('1986-01-24', 'Uranus flyby (first and only visit)', '799'),
                 ('1989-08-25', 'Neptune flyby (first and only visit)', '899'),
                 ('2007-08-30', 'Crossed the termination shock', None),
                 ('2018-11-05', 'Crossed the heliopause into interstellar space', None)]),
    dict(name='Pioneer 10', id=-23, launch='1972-03-03 01:49', step=5,
         desc='First craft through the asteroid belt and first to fly past Jupiter.',
         events=[('1972-07-15', 'First spacecraft to enter the asteroid belt', None),
                 ('1973-12-04', 'Jupiter flyby (first ever)', '599'),
                 ('1983-06-13', "Crossed Neptune's orbit, leaving the planetary region", None),
                 ('2003-01-23', 'Last signal received', None)]),
    dict(name='Pioneer 11', id=-24, launch='1973-04-06 02:11', step=5,
         desc='Second Jupiter flyby, then the first spacecraft to visit Saturn.',
         events=[('1974-12-03', 'Jupiter flyby', '599'), ('1979-09-01', 'Saturn flyby (first ever)', '699'),
                 ('1995-09-30', 'Last contact', None)]),
    dict(name='New Horizons', id=-98, launch='2006-01-19 19:00', step=5,
         desc='First mission to Pluto, then on to the Kuiper Belt object Arrokoth.',
         events=[('2007-02-28', 'Jupiter gravity assist', '599'), ('2015-07-14 11:49', 'Pluto flyby', '999'),
                 ('2019-01-01 05:33', 'Arrokoth flyby (most distant object ever visited)', None)]),
    dict(name='Parker Solar Probe', id=-96, launch='2018-08-12 07:31', step=2,
         desc='Dives through the solar corona; the closest and fastest human-made object.',
         events=[('2018-10-03', 'Venus flyby 1', '299'), ('2018-11-06', 'First perihelion', None),
                 ('2021-04-28', 'First spacecraft to fly through the solar corona', None),
                 ('2024-11-06', 'Venus flyby 7 (final)', '299'),
                 ('2024-12-24', 'Record perihelion: 6.1 million km above the surface, 191 km/s', None)]),
    dict(name='Europa Clipper', id=-159, launch='2024-10-14 16:06', step=5,
         desc="NASA's Europa mission, studying whether Jupiter's ice moon could support life.",
         events=[('auto', 'Mars gravity assist', '499', ('2025-02-01', '2025-04-01')),
                 ('auto', 'Earth gravity assist', '399', ('2026-11-01', '2027-01-31')),
                 ('auto', 'Jupiter arrival', '599', ('2030-01-01', '2030-08-01'))]),
    dict(name='Psyche', id=-255, launch='2023-10-13 14:19', step=5,
         desc='Electric-propulsion mission to the metal-rich asteroid 16 Psyche.',
         events=[('auto', 'Mars gravity assist', '499', ('2026-03-01', '2026-08-01')),
                 ('end', 'Trajectory ends on final approach to asteroid 16 Psyche (arrival planned 2029)',
                  None)]),
    dict(name='Lucy', id=-49, launch='2021-10-16 09:34', step=5,
         desc="First mission to Jupiter's Trojan asteroids, touring eight asteroids in all.",
         events=[('auto', 'Earth gravity assist 1', '399', ('2022-09-01', '2022-11-30')),
                 ('2023-11-01', 'Dinkinesh flyby (found the moon Selam)', None),
                 ('auto', 'Earth gravity assist 2', '399', ('2024-11-01', '2025-01-31')),
                 ('2025-04-20', 'Donaldjohanson flyby', None),
                 ('2027-08-12', 'Eurybates and its moon Queta flyby', None),
                 ('2027-09-15', 'Polymele flyby', None), ('2028-04-18', 'Leucus flyby', None),
                 ('2028-11-11', 'Orus flyby', None),
                 ('auto', 'Earth gravity assist 3', '399', ('2030-11-01', '2031-02-28')),
                 ('2033-03-02', 'Patroclus-Menoetius binary flyby', None)]),
    dict(name='JUICE', id=-28, launch='2023-04-14 12:14', step=5,
         desc="ESA's Jupiter Icy Moons Explorer, bound for Ganymede, Callisto and Europa.",
         events=[('auto', 'Lunar-Earth double flyby', '399', ('2024-07-15', '2024-09-30')),
                 ('auto', 'Venus gravity assist', '299', ('2025-07-15', '2025-10-15')),
                 ('auto', 'Earth gravity assist', '399', ('2026-08-15', '2026-11-15')),
                 ('auto', 'Final Earth gravity assist', '399', ('2028-11-01', '2029-03-31')),
                 ('end', 'Jupiter arrival (end of the published trajectory)', None)]),
]


def jd_of(s):
    d = dt.datetime.strptime(s, '%Y-%m-%d %H:%M') if ' ' in s else dt.datetime.strptime(s, '%Y-%m-%d')
    return (d - dt.datetime(2000, 1, 1, 12)).total_seconds() / 86400 + 2451545.0


def date_of(jd):
    return (dt.datetime(2000, 1, 1, 12) + dt.timedelta(days=jd - 2451545.0)).strftime('%Y-%m-%d %H:%M')


_last = [0.0]


def horizons(command, start, stop, step):
    params = dict(format='json', COMMAND=f"'{command}'", OBJ_DATA="'NO'", MAKE_EPHEM="'YES'",
                  EPHEM_TYPE="'VECTORS'", CENTER="'500@10'", REF_PLANE="'ECLIPTIC'", REF_SYSTEM="'ICRF'",
                  VEC_TABLE="'1'", OUT_UNITS="'AU-D'", CSV_FORMAT="'YES'", VEC_LABELS="'NO'",
                  START_TIME=f"'{start}'", STOP_TIME=f"'{stop}'", STEP_SIZE=f"'{step}'")
    url = API + '?' + urllib.parse.urlencode(params)
    key = re.sub(r'[^0-9A-Za-z_-]', '_', f'{command}_{start}_{stop}_{step}')
    path = os.path.join(CACHE, key + '_' + hashlib.sha1(url.encode()).hexdigest()[:8] + '.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    wait = 1.0 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    print(f'  horizons {command} {start} .. {stop} step {step}')
    req = urllib.request.Request(url, headers={'User-Agent': 'open-overwatch make_spacecraft.py'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.loads(r.read().decode('utf-8'))
            break
        except Exception as e:
            if attempt == 2:
                raise
            print('    retry after', e)
            time.sleep(5)
    _last[0] = time.time()
    os.makedirs(CACHE, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    return data


def coverage_error(data, which):
    """Parse 'No ephemeris for target ... prior to|after A.D. 1977-SEP-05 13:59:24.3830 TDB'."""
    text = (data.get('error') or '') + (data.get('result') or '')
    m = re.search(which + r' A\.D\. (\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2})', text)
    if not m:
        return None
    mon = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split().index(m.group(2)) + 1
    d = dt.datetime(int(m.group(1)), mon, int(m.group(3)), int(m.group(4)), int(m.group(5)), int(m.group(6)))
    return (d - dt.datetime(2000, 1, 1, 12)).total_seconds() / 86400 + 2451545.0


def parse_vectors(data):
    res = data.get('result') or ''
    if '$$SOE' not in res:
        return None
    body = res.split('$$SOE', 1)[1].split('$$EOE', 1)[0]
    rows = []
    for line in body.strip().splitlines():
        p = [s.strip() for s in line.split(',')]
        rows.append((float(p[0]), float(p[2]), float(p[3]), float(p[4])))
    return rows


def fetch_track(craft):
    cid, step = str(craft['id']), craft['step']
    probe = horizons(cid, '1950-01-01', '2035-01-01', '1000 d')
    start = coverage_error(probe, 'prior to')
    if start is None:
        sys.exit(f"{craft['name']}: could not read coverage start from Horizons:\n{probe.get('error') or probe.get('result', '')[:800]}")
    t0 = GRID0 + math.ceil((start + 0.25 - GRID0) / step) * step   # first grid point >= 6 h after coverage start
    stop = GRID0 + math.floor((LIMIT_JD - GRID0) / step) * step
    for _ in range(3):
        data = horizons(cid, f'JD{t0:.1f}', f'JD{stop:.1f}', f'{step} d')
        rows = parse_vectors(data)
        if rows:
            break
        end = coverage_error(data, 'after')
        if end is None:
            sys.exit(f"{craft['name']}: Horizons error:\n{data.get('error') or data.get('result', '')[:800]}")
        stop = GRID0 + math.floor((end - 0.25 - GRID0) / step) * step
    else:
        sys.exit(f"{craft['name']}: no data")
    for a, b in zip(rows, rows[1:]):
        assert abs(b[0] - a[0] - step) < 1e-6, (craft['name'], a[0], b[0])
    if len(rows) > MAX_POINTS:
        print(f"  warning: {craft['name']} has {len(rows)} points (> {MAX_POINTS})")
    return start, rows


def lagrange3(times, xyz, t):
    """Quadratic interpolation of a uniform series at time t."""
    step = times[1] - times[0]
    i = min(max(int(round((t - times[0]) / step)), 1), len(times) - 2)
    u = (t - times[i]) / step
    w = (u * (u - 1) / 2, 1 - u * u, u * (u + 1) / 2)
    return tuple(sum(w[k] * xyz[i - 1 + k][c] for k in range(3)) for c in range(3))


def closest(rows, body_rows, lo, hi):
    """Closest approach between craft samples and a body inside [lo, hi] -> (jd, dist AU).
    Refined with a parabola through d^2 of the three samples around the minimum (exact for a straight-line
    pass, d^2 = b^2 + v^2 (t - tc)^2)."""
    bt = [r[0] for r in body_rows]
    bx = [r[1:] for r in body_rows]
    sep = lambda r: math.dist(r[1:], lagrange3(bt, bx, r[0]))
    cand = [(i, sep(r)) for i, r in enumerate(rows) if lo <= r[0] <= hi]
    if not cand:
        return None
    i, d = min(cand, key=lambda c: c[1])
    if not 0 < i < len(rows) - 1:
        return rows[i][0], d
    y0, y1, y2 = sep(rows[i - 1]) ** 2, d * d, sep(rows[i + 1]) ** 2
    den = y0 - 2 * y1 + y2
    if den <= 0:
        return rows[i][0], d
    off = max(-1.0, min(1.0, 0.5 * (y0 - y2) / den))
    ymin = y1 - 0.25 * (y0 - y2) * off
    return rows[i][0] + off * (rows[1][0] - rows[0][0]), math.sqrt(max(ymin, 0.0))


def main():
    global LIMIT_JD
    LIMIT_JD = jd_of('2035-01-01')
    tracks = {}
    for c in CRAFT:
        print(c['name'])
        tracks[c['name']] = fetch_track(c)

    # bodies for flyby checks / auto event dates: one 5-day series covering every craft
    first = min(rows[0][0] for _, rows in tracks.values()) - 10
    bodies = sorted({e[2] for c in CRAFT for e in c['events'] if e[2]})
    body_rows = {}
    for b in bodies:
        lo = GRID0 + math.floor((first - GRID0) / 5) * 5
        data = horizons(b, f'JD{lo:.1f}', f'JD{LIMIT_JD:.1f}', '5 d')
        body_rows[b] = parse_vectors(data)
        if not body_rows[b]:
            sys.exit(f'body {b}: {data.get("error") or data.get("result", "")[:800]}')

    out = []
    print('\nEvents (curated date vs closest approach on the sampled track):')
    for c in CRAFT:
        start, rows = tracks[c['name']]
        events = [[round(jd_of(c['launch']), 4), 'Launch']]
        for e in c['events']:
            date, text, body = e[0], e[1], e[2]
            if date == 'end':
                jd = rows[-1][0]
            elif date == 'auto':
                lo, hi = jd_of(e[3][0]), jd_of(e[3][1])
                ca = closest(rows, body_rows[body], lo, hi)
                if ca is None:
                    print(f"  {c['name']}: {text}: outside the track, dropped")
                    continue
                jd = ca[0]
                print(f"  {c['name']:18s} {text:34s} auto  {date_of(jd)}  {ca[1] * 149597870.7:12,.0f} km")
            else:
                jd = jd_of(date)
                if body:
                    ca = closest(rows, body_rows[body], jd - 20, jd + 20)
                    if ca:
                        print(f"  {c['name']:18s} {text:34s} {date[:10]}  ca {date_of(ca[0])}  "
                              f"{ca[1] * 149597870.7:12,.0f} km")
            events.append([round(jd, 4), text])
        events.sort()
        step = c['step']
        xyz = []
        for r in rows:
            xyz.extend(round(v, 5) for v in r[1:])
        out.append(dict(name=c['name'], id=c['id'], launch_jd=round(jd_of(c['launch']), 4), desc=c['desc'],
                        events=events, t0_jd=rows[0][0], step_days=step, n=len(rows), end_jd=rows[-1][0],
                        coverage_start_jd=round(start, 4), xyz=xyz))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))

    print('\nTracks:')
    for o in out:
        print(f"  {o['name']:18s} {date_of(o['t0_jd'])[:10]} .. {date_of(o['end_jd'])[:10]}  "
              f"{o['n']:5d} pts @ {o['step_days']} d")
    tc = jd_of(CHECK_DATE)
    print(f'\nHeliocentric distance on {CHECK_DATE} 00:00 TDB:')
    for o in out:
        if o['t0_jd'] <= tc <= o['end_jd']:
            n, s = o['n'], o['step_days']
            pts = [o['xyz'][3 * i:3 * i + 3] for i in range(n)]
            p = lagrange3([o['t0_jd'] + i * s for i in range(n)], pts, tc)
            print(f"  {o['name']:18s} {math.hypot(*p):8.3f} AU")
    print(f'\nspacecraft.json {os.path.getsize(OUT):,} B')


if __name__ == '__main__':
    main()
