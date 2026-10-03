"""Every confirmed exoplanet, grouped by host star, for the Solar System view -> data/solar/exoplanets.json

    python make_exoplanets.py        (the archive answer is cached in brand/source/exoplanets/pscomppars.csv)

Source: NASA Exoplanet Archive, Planetary Systems Composite Parameters table (pscomppars: one row per planet, the
archive's best value for each parameter). Public domain (NASA); the archive asks to be acknowledged.

Per system: host name, ecliptic J2000 position in light-years (same frame as stars.bin), effective temperature, radius
(Suns), luminosity (log10 L/Lsun), conservative habitable zone (Kopparapu et al. 2014: runaway greenhouse for 1 Earth
mass to maximum greenhouse, effective fluxes as a polynomial in Teff for 2600-7200 K; distance = sqrt(L / S_eff)), and
its planets:
[name suffix, a (AU), period (days), e, i (deg), radius (Earth radii), mass (Earth masses), equilibrium T (K),
 transit mid-time (JD, or 0), discovery year, method, in-habitable-zone flag].
Missing a is derived from the period and the stellar mass (Kepler's third law) when possible.
"""
import csv, io, json, math, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE.parent / 'source' / 'exoplanets' / 'pscomppars.csv'
COLS = ['pl_name', 'hostname', 'ra', 'dec', 'sy_dist', 'pl_orbsmax', 'pl_orbper', 'pl_orbeccen', 'pl_orbincl', 'pl_rade',
        'pl_bmasse', 'pl_eqt', 'pl_tranmid', 'disc_year', 'discoverymethod', 'st_teff', 'st_rad', 'st_mass', 'st_lum', 'sy_pnum']
METHODS = {'Transit': 'T', 'Radial Velocity': 'RV', 'Microlensing': 'M', 'Imaging': 'I', 'Transit Timing Variations': 'TTV',
           'Eclipse Timing Variations': 'ETV', 'Orbital Brightness Modulation': 'OBM', 'Pulsar Timing': 'P', 'Astrometry': 'A',
           'Pulsation Timing Variations': 'PTV', 'Disk Kinematics': 'DK'}
EPS = math.radians(23.4392911)

if not CACHE.exists():
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    q = 'select ' + ','.join(COLS) + ' from pscomppars'
    url = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' + urllib.parse.urlencode({'query': q, 'format': 'csv'})
    CACHE.write_bytes(urllib.request.urlopen(url, timeout=180).read())
rows = list(csv.DictReader(io.StringIO(CACHE.read_text(encoding='utf-8'))))
num = lambda v: float(v) if v not in ('', None) else None


def habitable_zone(log_l, teff):
    """Kopparapu et al. 2014 conservative habitable zone (AU): runaway greenhouse (1 Earth mass) to maximum greenhouse."""
    t = max(2600, min(7200, teff or 5780)) - 5780
    seff = lambda s0, a, b, c, d: s0 + a * t + b * t ** 2 + c * t ** 3 + d * t ** 4
    s_in = seff(1.107, 1.332e-4, 1.580e-8, -8.308e-12, -1.931e-15)
    s_out = seff(0.356, 6.171e-5, 1.698e-9, -3.198e-12, -5.575e-16)
    L = 10 ** log_l
    return [round(math.sqrt(L / s_in), 5), round(math.sqrt(L / s_out), 5)]

systems = {}
for r in rows:
    d = num(r['sy_dist']); ra, dec = num(r['ra']), num(r['dec'])
    if d is None or ra is None or dec is None:
        continue
    h = r['hostname']
    if h not in systems:
        ly = d * 3.26156
        a_, d_ = math.radians(ra), math.radians(dec)
        x, y, z = math.cos(d_) * math.cos(a_), math.cos(d_) * math.sin(a_), math.sin(d_)
        ex, ey, ez = x, y * math.cos(EPS) + z * math.sin(EPS), -y * math.sin(EPS) + z * math.cos(EPS)   # equatorial -> ecliptic
        lum = num(r['st_lum'])
        if lum is None and num(r['st_rad']) and num(r['st_teff']):
            lum = math.log10(num(r['st_rad']) ** 2 * (num(r['st_teff']) / 5772) ** 4)
        hz = habitable_zone(lum, num(r['st_teff'])) if lum is not None else None
        systems[h] = {'host': h, 'p': [round(ex * ly, 4), round(ey * ly, 4), round(ez * ly, 4)], 'ly': round(ly, 3), 'teff': num(r['st_teff']),
                      'rs': num(r['st_rad']), 'lum': round(lum, 3) if lum is not None else None, 'hz': hz, 'pl': []}
    s = systems[h]
    a, P, ms = num(r['pl_orbsmax']), num(r['pl_orbper']), num(r['st_mass'])
    if a is None and P and ms:
        a = (ms * (P / 365.25) ** 2) ** (1 / 3)
    if a is None:
        continue                                     # nothing to draw (a few microlensing / imaging planets)
    suffix = r['pl_name'][len(h):].strip() if r['pl_name'].startswith(h) else r['pl_name']
    tm = num(r['pl_tranmid'])
    inhz = 1 if s['hz'] and s['hz'][0] <= a <= s['hz'][1] else 0
    s['pl'].append([suffix, round(a, 6), round(P, 5) if P else 0, round(num(r['pl_orbeccen']) or 0, 3), round(num(r['pl_orbincl']) or 90, 2),
                    round(num(r['pl_rade']) or 0, 2), round(num(r['pl_bmasse']) or 0, 2), round(num(r['pl_eqt']) or 0), round(tm, 5) if tm else 0,
                    int(r['disc_year'] or 0), METHODS.get(r['discoverymethod'], r['discoverymethod']), inhz])
out = sorted((s for s in systems.values() if s['pl']), key=lambda s: s['ly'])
for s in out:
    s['pl'].sort(key=lambda p: p[1])
n_pl = sum(len(s['pl']) for s in out)
dst = ROOT / 'data' / 'solar' / 'exoplanets.json'
dst.write_text(json.dumps({'source': 'NASA Exoplanet Archive, pscomppars (https://exoplanetarchive.ipac.caltech.edu)', 'licence': 'public domain (NASA); acknowledge the NASA Exoplanet Archive',
                           'frame': 'ecliptic J2000, light-years from the Sun', 'planet_fields': ['suffix', 'a_AU', 'P_days', 'e', 'i_deg', 'R_earth', 'M_earth', 'Teq_K', 'transit_JD', 'year', 'method', 'in_HZ'],
                           'systems': len(out), 'planets': n_pl, 'list': out}, separators=(',', ':')))
print(f'{len(rows)} rows -> {len(out)} systems, {n_pl} planets, {sum(p[11] for s in out for p in s["pl"])} in the habitable zone; {dst.stat().st_size // 1024} KB')
for name in ('TRAPPIST-1', 'Proxima Cen', 'Kepler-452', 'TOI-700', '51 Peg'):
    s = next((x for x in out if x['host'] == name), None)
    if s: print(name, s['ly'], 'ly', [(p[0], p[1], p[11]) for p in s['pl']])
