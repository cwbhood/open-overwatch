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
# everything an archived app loads at run time (missing ones are skipped per tag); keep in sync with what the pages fetch
APP_PATHS = ['open-overwatch.html', 'globe.html', 'README.txt', 'brand/emblem', 'brand/hero', 'brand/sprites',
             'brand/models', 'brand/textures/night', 'brand/textures/earth_fx_8k.jpg', 'brand/textures/earth_fx_4k.jpg',
             'brand/textures/sky', 'brand/textures/sky_1k', 'brand/social/og-1200x630.png']
SKIP_VERSION = ('brand/models/previews/', 'brand/sprites/raw/')
# every group globe.html (LAYERS sat:) and open-overwatch.html (Sats.GROUPS) can ask for
TLE_GROUPS = ['stations', 'visual', 'last-30-days', 'military', 'radar', 'gps-ops', 'glo-ops', 'galileo', 'beidou',
              'weather', 'goes', 'resource', 'science', 'iridium-NEXT', 'geo', 'oneweb', 'starlink',
              'cosmos-2251-debris', 'iridium-33-debris']


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
        })
        print(f'{tag}: {n} entries ({", ".join(paths)})')
    with open(os.path.join(OUT, 'versions.json'), 'w', encoding='utf-8') as f:
        json.dump({'latest': versions[0]['tag'] if versions else None, 'versions': versions}, f, indent=1)
    print(f'versions.json: {len(versions)} versions')
    mirror_tles(os.path.join(OUT, 'data', 'tle'))


if __name__ == '__main__':
    main()
