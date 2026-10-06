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
import re, io, json, os, socket, subprocess, sys, tarfile, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '_site'))
SKIP_ROOT = ('brand/source/', 'brand/blend/', '.github/', 'brand/models/previews/')
# everything an archived app loads at run time (missing ones are skipped per tag); keep in sync with what the pages fetch.
# solar.html's big data/textures (data/solar, brand/textures/planets, sky_equirect) are NOT copied per version: the page
# falls back to the site root for them, which keeps each archived version small.
APP_PATHS = ['open-overwatch.html', 'globe.html', 'solar.html', 'tonight.html', 'manifest.webmanifest', 'README.txt', 'src', 'brand/emblem', 'brand/hero', 'brand/sprites',
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


SITE = 'https://destinjones.github.io/open-overwatch/'


def fix_archived_links(root):
    """Links in an archived version that would break: old tags still name the GitHub account's old name (cwbhood,
    renamed to destinjones on 2026-10-06; GitHub Pages doesn't redirect the old address), and their pages link to the
    landing page and about page, which aren't archived, so those point back at the site root."""
    for dirpath, _, files in os.walk(root):
        for name in files:
            if not name.endswith(('.html', '.js', '.json', '.webmanifest', '.txt', '.css', '.xml')):
                continue
            path = os.path.join(dirpath, name)
            with open(path, 'rb') as f:
                data = f.read()
            fixed = data.replace(b'cwbhood', b'destinjones')
            if name.endswith('.html') and dirpath == root:
                for page in (b'index.html', b'about.html'):
                    fixed = fixed.replace(b'href="' + page, b'href="../../' + page)
            if fixed != data:
                with open(path, 'wb') as f:
                    f.write(fixed)


def last_good(rel, timeout=30):
    """The copy the live site serves right now (bytes), or None. A source that refuses this build (CelesTrak timing out on
    GitHub's runners did that on 2026-10-06: every group FAILED and the deploy wiped the mirror) must not take the
    previous good copy down with it: visitors would otherwise go to the source directly, 20 downloads each."""
    try:
        req = urllib.request.Request(SITE + rel, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'})
        return urllib.request.urlopen(req, timeout=timeout).read()
    except Exception:
        return None


def keep_last(path, rel, what):
    """After a failed refresh: write the live site's current copy of rel to path, if it has one. True if kept."""
    old = last_good(rel)
    if not old:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(old)
    print(f'{what}: kept the live site\'s copy ({len(old)} bytes)')
    return True


def mirror_tles(dest):
    """Best effort: a group that fails keeps the copy the live site already has (with its age in index.json); only when
    there is none either is it missing from this build (the apps then try CelesTrak)."""
    os.makedirs(dest, exist_ok=True)
    index = {'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'groups': {}, 'kept': []}
    down = False   # after one timeout, stop waiting 90 s on every other group: CelesTrak is refusing this runner
    for g in TLE_GROUPS:
        url = f'https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=TLE'
        try:
            if down:
                raise TimeoutError('skipped: CelesTrak timed out earlier in this build')
            req = urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'})
            txt = urllib.request.urlopen(req, timeout=90).read().decode('utf-8', 'replace')
            n = sum(1 for l in txt.splitlines() if l.startswith('1 '))
            if n == 0:
                raise ValueError('no TLEs in the response: ' + txt[:80].strip())
            with open(os.path.join(dest, g + '.txt'), 'w', encoding='utf-8', newline=chr(10)) as f:
                f.write(txt)
            index['groups'][g] = n
            print(f'tle {g}: {n}')
        except Exception as e:
            if isinstance(e, (TimeoutError, socket.timeout)) or 'timed out' in str(e):
                down = True
            old = last_good(f'data/tle/{g}.txt')
            n = sum(1 for l in old.decode('utf-8', 'replace').splitlines() if l.startswith('1 ')) if old else 0
            if n:
                with open(os.path.join(dest, g + '.txt'), 'wb') as f:
                    f.write(old)
                index['groups'][g] = n
                index['kept'].append(g)
                print(f'tle {g}: FAILED {e} -> kept the live site\'s copy ({n})')
            else:
                print(f'tle {g}: FAILED {e}')
        time.sleep(2)   # be gentle with CelesTrak
    with open(os.path.join(dest, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=1)


def mirror_socrates(path):
    """Best effort: SOCRATES close approaches (CSV, every conjunction under 5 km in the next 7 days) -> the closest
    upcoming ones as JSON, in the shape src/core/socrates.js parseSocrates() returns (the globe reads this file)."""
    import csv, datetime
    try:
        req = urllib.request.Request(SOCRATES_CSV, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'})
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
        keep_last(path, 'data/socrates.json', 'socrates')


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
            req = urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'})
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
        keep_last(path, 'data/wind.json', 'wind')


def mirror_news(path, countries_path):
    """Best effort: English-language headlines from news outlets in the ~70 biggest economies (GDELT DOC API, open data), one request
    every 7 s as GDELT asks, as data/news.json: {t, countries: {ISO2: [{title, url, domain, date}]}}. The globe's country
    dossier reads this first, so a visitor's click never spends GDELT's one-request-per-few-seconds limit."""
    try:
        facts = json.load(open(countries_path, encoding='utf-8'))['countries']
    except Exception as e:
        print(f'news: no country list ({e})'); return
    top = sorted((iso for iso, f in facts.items() if f.get('gdp')), key=lambda i: -facts[i]['gdp'])[:70]
    out, fails, started = {}, 0, time.time()
    # A hard budget: this runs inside every site build, and GDELT answers 429 to the build servers at times. One 7 s pause between
    # requests, a 15 s timeout each, no retries, stop after 3 failures in a row or 5 minutes in all (whatever was collected is kept).
    for iso in top:
        if time.time() - started > 300: print('news: out of time, keeping what we have'); break
        name = re.sub(r'[^A-Za-z]', '', facts[iso]['name'])
        url = ('https://api.gdeltproject.org/api/v2/doc/doc?query=' + urllib.parse.quote(f'sourcecountry:{name} sourcelang:english')
               + '&mode=artlist&format=json&maxrecords=10&timespan=1d&sort=hybridrel')
        time.sleep(7)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'})
            txt = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'replace')
            d = json.loads(txt) if txt.strip().startswith('{') else None
            if d is None: raise ValueError(txt.strip()[:60])
            out[iso] = [{'title': a['title'][:160], 'url': a['url'], 'domain': a.get('domain', ''), 'date': a.get('seendate', '')} for a in d.get('articles', [])
                        if a.get('url', '').startswith(('http://', 'https://'))][:8]
            fails = 0
        except Exception as e:
            fails += 1; print(f'news {iso}: FAILED {e}')
            if fails >= 3: print('news: three failures in a row, giving up'); break
    if out:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'t': int(time.time() * 1000), 'source': 'GDELT Project (gdeltproject.org)', 'countries': out}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'news: {len(out)} countries, {sum(len(v) for v in out.values())} headlines')


def mirror_flybys(path):
    """Best effort: asteroid and comet close approaches inside ~20 lunar distances over the next 60 days (NASA/JPL CNEOS close-approach
    API, public domain; it sends no CORS headers, hence this copy) -> data/flybys.json: {t, rows: [{des, name, tca, au, minAu, kms, h, km}]}."""
    try:
        url = 'https://ssd-api.jpl.nasa.gov/cad.api?dist-max=0.05&date-min=now&date-max=%2B60&sort=date&fullname=true&diameter=true'
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'}), timeout=60))
        f = d['fields']; rows = []
        for r in d['data']:
            x = dict(zip(f, r))
            rows.append({'des': x['des'], 'name': (x.get('fullname') or x['des']).strip(), 'tca': round((float(x['jd']) - 2440587.5) * 86400000), 'au': float(x['dist']), 'minAu': float(x['dist_min']),
                         'kms': float(x['v_rel']), 'h': float(x['h']) if x.get('h') else None, 'km': float(x['diameter']) if x.get('diameter') else None})
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'t': int(time.time() * 1000), 'source': 'NASA/JPL CNEOS close-approach data', 'rows': rows}, fh, separators=(',', ':'))
        print(f'flybys: {len(rows)} approaches')
    except Exception as e:
        print(f'flybys: FAILED {e}')
        keep_last(path, 'data/flybys.json', 'flybys')


# the parts of a Launch Library 2 launch the globe reads (src/core/launches.js fromLL2 maps them; the build only trims)
LL2_KEEP = {'id': 1, 'name': 1, 'net': 1, 'window_start': 1, 'window_end': 1, 'net_precision': {'abbrev': 1, 'name': 1}, 'status': {'abbrev': 1, 'name': 1},
            'probability': 1, 'webcast_live': 1, 'launch_service_provider': {'name': 1}, 'rocket': {'configuration': {'name': 1, 'full_name': 1}},
            'mission': {'name': 1, 'type': 1, 'description': 1, 'orbit': {'name': 1, 'abbrev': 1}},
            'pad': {'name': 1, 'latitude': 1, 'longitude': 1, 'country': {'alpha_2_code': 1}, 'location': {'name': 1}},
            'vid_urls': [{'url': 1, 'title': 1, 'priority': 1, 'publisher': 1}]}


def _keep(o, spec):
    """Trim o to the keys in spec. Tolerant of odd shapes (a dict where a list was expected...): they become {} / [].
    Lists keep 3 items, highest 'priority' first (webcasts: the official stream must not be the one cut)."""
    if isinstance(spec, dict):
        return {k: _keep(o[k], v) for k, v in spec.items() if o.get(k) is not None} if isinstance(o, dict) else {}
    if isinstance(spec, list):
        items = [x for x in o if isinstance(x, dict)] if isinstance(o, list) else []
        items.sort(key=lambda x: -(x.get('priority') if isinstance(x.get('priority'), (int, float)) else 0))
        return [_keep(x, spec[0]) for x in items[:3]]
    return o if isinstance(o, (str, int, float, bool)) else None


def mirror_launches(path):
    """Best effort: the next 40 rocket launches from The Space Devs' Launch Library 2 (free; 15 requests an hour without a key, so
    every visitor asking directly would soon be refused) -> data/launches.json: {t, source, results: [trimmed LL2 launches]}."""
    try:
        url = 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=40&mode=detailed&hide_recent_previous=true'
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'}), timeout=90))
        rows = []
        for r in d.get('results', []):
            k = _keep(r, LL2_KEEP)   # one odd record is dropped or trimmed, never the whole file
            m = k.get('mission') or {}
            if isinstance(m.get('description'), str): m['description'] = m['description'][:600]
            if k.get('pad'): rows.append(k)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'t': int(time.time() * 1000), 'source': 'The Space Devs, Launch Library 2 (thespacedevs.com)', 'results': rows}, fh, separators=(',', ':'))
        print(f'launches: {len(rows)} upcoming')
    except Exception as e:
        print(f'launches: FAILED {e}')
        keep_last(path, 'data/launches.json', 'launches')



def mirror_astronauts(path):
    """Best effort: who is in space right now (Launch Library 2 astronauts with in_space=true; the same free API and limits as
    the launches) -> data/astronauts.json: {t, source, results: [trimmed LL2 astronauts]} (src/core/crew.js reads them)."""
    try:
        url = 'https://ll.thespacedevs.com/2.3.0/astronauts/?in_space=true&mode=normal&limit=60'
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'open-overwatch site build (github.com/destinjones/open-overwatch)'}), timeout=90))
        keep = {'name': 1, 'type': {'name': 1}, 'agency': {'abbrev': 1, 'name': 1}, 'nationality': [{'alpha_2_code': 1}], 'time_in_space': 1, 'last_flight': 1, 'wiki': 1}
        rows = [k for k in (_keep(r, keep) for r in d.get('results', [])) if k.get('name')]   # odd shapes become {} / [], never an exception
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'t': int(time.time() * 1000), 'source': 'The Space Devs, Launch Library 2 (thespacedevs.com)', 'results': rows}, fh, separators=(',', ':'))
        print(f'astronauts: {len(rows)} in space')
    except Exception as e:
        print(f'astronauts: FAILED {e}')
        keep_last(path, 'data/astronauts.json', 'astronauts')

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
        fix_archived_links(os.path.join(OUT, 'v', tag))
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
    mirror_flybys(os.path.join(OUT, 'data', 'flybys.json'))
    mirror_launches(os.path.join(OUT, 'data', 'launches.json'))
    mirror_astronauts(os.path.join(OUT, 'data', 'astronauts.json'))
    mirror_news(os.path.join(OUT, 'data', 'news.json'), os.path.join(OUT, 'data', 'countries.json'))


if __name__ == '__main__':
    main()
