"""Build the GitHub Pages site: the current main branch at the root, plus a frozen copy of every released version.

    python .github/build_site.py [out_dir]          (default: _site)

- Root: everything committed at HEAD except bulky sources the site never loads (brand/source, brand/blend).
- /v/<tag>/: the app files of each `v*` tag, taken straight from git (git archive), so old versions keep working
  exactly as released without storing copies in the repo.
- /versions.json: the list the landing page reads for its version picker and version history.
"""
import io, json, os, subprocess, sys, tarfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '_site'))
SKIP_ROOT = ('brand/source/', 'brand/blend/', '.github/', 'brand/models/previews/')
APP_PATHS = ['open-overwatch.html', 'globe.html', 'README.txt', 'brand/emblem', 'brand/hero', 'brand/sprites',
             'brand/models', 'brand/textures/night', 'brand/social/og-1200x630.png']
SKIP_VERSION = ('brand/models/previews/', 'brand/sprites/raw/')


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


if __name__ == '__main__':
    main()
