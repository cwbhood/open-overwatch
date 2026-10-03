"""Build the GitHub Pages site: the current main branch at the root, plus a frozen copy of every released version.

    python .github/build_site.py [out_dir]          (default: _site)

- Root: everything committed at HEAD except bulky sources the site never loads (brand/source, brand/blend).
- /v/<tag>/: the app files of each `v*` tag, taken straight from git (git archive), so old versions keep working
  exactly as released without storing copies in the repo.
- /versions.json: the list the landing page reads for its version picker and version history.
- /data/tle/<group>.txt: a copy of each CelesTrak satellite group the apps use (the workflow also runs every 6 h to
  refresh it). The website reads these instead of CelesTrak, which firewalls networks that download too often; the
  download version falls back to them when CelesTrak fails.
"""
import io, json, os, subprocess, sys, tarfile, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '_site'))
SKIP_ROOT = ('brand/source/', 'brand/blend/', '.github/', 'brand/models/previews/')
# everything an archived app loads at run time (missing ones are skipped per tag); keep in sync with what the pages fetch.
# solar.html's big data/textures (data/solar, brand/textures/planets, sky_equirect) are NOT copied per version: the page
# falls back to the site root for them, which keeps each archived version small.
APP_PATHS = ['open-overwatch.html', 'globe.html', 'solar.html', 'README.txt', 'src', 'brand/emblem', 'brand/hero', 'brand/sprites',
             'brand/models', 'brand/textures/night', 'brand/textures/earth_fx_8k.jpg', 'brand/textures/earth_fx_4k.jpg', 'brand/textures/earth_fx_2k.jpg',
             'brand/textures/sky', 'brand/textures/sky_1k', 'brand/social/og-1200x630.png']
SKIP_VERSION = ('brand/models/previews/', 'brand/sprites/raw/')
# every group globe.html (LAYERS sat:) and open-overwatch.html (Sats.GROUPS) can ask for
TLE_GROUPS = ['stations', 'visual', 'last-30-days', 'military', 'radar', 'gps-ops', 'glo-ops', 'galileo', 'beidou',
              'weather', 'goes', 'resource', 'science', 'iridium-NEXT', 'geo', 'oneweb', 'starlink',
              'cosmos-2251-debris', 'iridium-33-debris', 'fengyun-1c-debris', 'active']
SOCRATES_CSV = 'https://celestrak.org/SOCRATES/sort-minRange.csv'
SOCRATES_KEEP = 300    # the closest upcoming conjunctions, for the globe's close-approach list


def git(*args, binary=False):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode('utf-8', 'replace').strip()


def exists(ref, path):
    return subprocess.run(['git', 'cat-file', '-e', f'{ref}:{path}'], cwd=ROOT, capture_output=True).returncode == 0


def extract(ref, paths, dest, skip):
    data = git('archive', '--format=tar', ref, '--', *paths, binary=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        members = [m for m in t.getmembers() if not m.name.startswith(skip)]
        t.extractall(dest, members=members, filter='data')
    return len(members)


def mirror_tles(dest):
    """Best effort: a group that fails is simply missing from this build (the apps then try CelesTrak)."""
    os.makedirs(dest, exist_ok=True)
    index = {'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'groups': {}}
    for g in TLE_GROUPS:
        url = f'https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=TLE'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/cwbhood/open-overwatch)'})
            txt = urllib.request.urlopen(req, timeout=90).read().decode('utf-8', 'replace')
            n = sum(1 for l in txt.splitlines() if l.startswith('1 '))
            if n == 0:
                raise ValueError('no TLEs in the response: ' + txt[:80].strip())
            with open(os.path.join(dest, g + '.txt'), 'w', encoding='utf-8', newline=chr(10)) as f:
                f.write(txt)
            index['groups'][g] = n
            print(f'tle {g}: {n}')
        except Exception as e:
            print(f'tle {g}: FAILED {e}')
        time.sleep(2)   # be gentle with CelesTrak
    with open(os.path.join(dest, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=1)


def mirror_socrates(path):
    """Best effort: SOCRATES close approaches (CSV, every conjunction under 5 km in the next 7 days) -> the closest
    upcoming ones as JSON, in the shape src/core/socrates.js parseSocrates() returns (the globe reads this file)."""
    import csv, datetime
    try:
        req = urllib.request.Request(SOCRATES_CSV, headers={'User-Agent': 'open-overwatch site build (github.com/cwbhood/open-overwatch)'})
        rows = list(csv.DictReader(io.StringIO(urllib.request.urlopen(req, timeout=120).read().decode('utf-8', 'replace'))))
        now = datetime.datetime.now(datetime.timezone.utc)

        def obj(r, n):
            name = r[f'OBJECT_NAME_{n}'].strip(); status = ''
            if name.endswith(']') and '[' in name:
                name, status = name[:name.rindex('[')].strip(), name[name.rindex('[') + 1:-1]
            return {'id': str(int(r[f'NORAD_CAT_ID_{n}'])), 'name': name, 'status': status, 'dse': float(r.get(f'DSE_{n}') or 0) or None}
        out = []
        for r in rows:
            try:
                t = datetime.datetime.fromisoformat(r['TCA'].strip().replace(' ', 'T')).replace(tzinfo=datetime.timezone.utc)
                if t <= now:
                    continue
                out.append({'a': obj(r, 1), 'b': obj(r, 2), 'tca': int(t.timestamp() * 1000), 'rangeKm': float(r['TCA_RANGE']),
                            'speedKmS': float(r['TCA_RELATIVE_SPEED']), 'maxProb': float(r['MAX_PROB']) if r.get('MAX_PROB') else None})
            except (KeyError, ValueError):
                continue
        out.sort(key=lambda x: (x['rangeKm'], x['tca']))
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'source': 'CelesTrak SOCRATES (' + SOCRATES_CSV + ')',
                       'screened': len(rows), 'rows': out[:SOCRATES_KEEP]}, f, separators=(',', ':'))
        print(f'socrates: {len(rows)} conjunctions, kept {min(len(out), SOCRATES_KEEP)}')
    except Exception as e:
        print(f'socrates: FAILED {e}')


def mirror_wind(path):
    """Best effort: a wind + temperature snapshot (Open-Meteo, CC BY 4.0, non-commercial) on the 10-degree grid src/globe/wind.js
    uses, as data/wind.json: {t, at, u, v, temp} (m/s east, m/s north, deg C; latitudes -80..80 south to north, then longitudes
    -180..170). The browser reads this file first, so visitors never spend Open-Meteo's per-IP quota (612 locations per open)."""
    import math
    try:
        pts = [(la, lo) for la in range(-80, 81, 10) for lo in range(-180, 180, 10)]
        u, v, t, when = [None] * len(pts), [None] * len(pts), [None] * len(pts), ''
        for i in range(0, len(pts), 306):
            part = pts[i:i + 306]
            url = ('https://api.open-meteo.com/v1/forecast?latitude=' + ','.join(str(a) for a, b in part) + '&longitude=' + ','.join(str(b) for a, b in part)
                   + '&current=wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=ms')
            req = urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/cwbhood/open-overwatch)'})
            rows = json.load(urllib.request.urlopen(req, timeout=120))
            if not isinstance(rows, list):
                raise ValueError(str(rows)[:120])
            for j, r in enumerate(rows):
                c = r['current']; d = math.radians(c['wind_direction_10m'])   # the direction the wind blows FROM
                u[i + j] = round(-c['wind_speed_10m'] * math.sin(d), 2); v[i + j] = round(-c['wind_speed_10m'] * math.cos(d), 2)
                t[i + j] = c['temperature_2m']; when = c['time']
            time.sleep(2)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'t': int(time.time() * 1000), 'at': when, 'u': u, 'v': v, 'temp': t}, f, separators=(',', ':'))
        print(f'wind: {len(pts)} points at {when}')
    except Exception as e:
        print(f'wind: FAILED {e}')


def main():
    os.makedirs(OUT, exist_ok=True)
    n = extract('HEAD', ['.'], OUT, SKIP_ROOT)
    print(f'root: {n} entries from HEAD')
    versions = []
    for tag in git('tag', '-l', 'v*', '--sort=-v:refname').split():
        paths = [p for p in APP_PATHS if exists(tag, p)]
        if 'open-overwatch.html' not in paths:
            continue
        n = extract(tag, paths, os.path.join(OUT, 'v', tag), SKIP_VERSION)
        notes = git('tag', '-l', '--format=%(contents)', tag) or git('log', '-1', '--format=%B', tag)
        lines = [l for l in notes.splitlines() if l.strip() and not l.startswith(('-----BEGIN', 'Co-Authored-By'))]
        versions.append({
            'tag': tag,
            'date': git('log', '-1', '--format=%cI', tag + '^{commit}'),
            'title': lines[0] if lines else tag,
            'notes': '\n'.join(lines[1:]),
            'map': f'v/{tag}/open-overwatch.html',
            'globe': f'v/{tag}/globe.html' if 'globe.html' in paths else None,
            'solar': f'v/{tag}/solar.html' if 'solar.html' in paths else None,
        })
        print(f'{tag}: {n} entries ({", ".join(paths)})')
    with open(os.path.join(OUT, 'versions.json'), 'w', encoding='utf-8') as f:
        json.dump({'latest': versions[0]['tag'] if versions else None, 'versions': versions}, f, indent=1)
    print(f'versions.json: {len(versions)} versions')
    mirror_tles(os.path.join(OUT, 'data', 'tle'))
    mirror_socrates(os.path.join(OUT, 'data', 'socrates.json'))
    mirror_wind(os.path.join(OUT, 'data', 'wind.json'))


if __name__ == '__main__':
    main()
