"""The 88 constellations' stick figures and names for look-up mode: d3-celestial (BSD 3-clause, Olaf Frohn) -> data/constellations.json

    python make_constellations.py        (the downloads are cached in brand/source/constellations/; delete them to refresh)

Output: {source, licence, figures: [{id, name, rank, c: [ra, dec], l: [[ra, dec, ra, dec, ...], ...]}]}. RA and Dec in degrees
(J2000), RA 0-360 (d3-celestial writes it -180..180), 2 decimals (0.01 deg is far finer than a phone screen). rank 1 = the
well-known figures, 2-3 = fainter ones (look-up mode names only rank 1-2 so the sky doesn't fill with text).
"""
import json, subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RAW = HERE.parent / 'source' / 'constellations'
BASE = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/'
FILES = {'lines': 'data/constellations.lines.json', 'names': 'data/constellations.json', 'licence': 'LICENSE'}


def get(key):
    p = RAW / Path(FILES[key]).name
    if not p.exists():
        RAW.mkdir(parents=True, exist_ok=True)
        subprocess.run(['curl', '-sSL', '--fail', '-m', '60', '-o', str(p), BASE + FILES[key]], check=True)
    return p.read_text(encoding='utf-8')


def ra(x): return round(x % 360, 2)


def main():
    lines = {f['id']: f for f in json.loads(get('lines'))['features']}
    names = {f['id']: f for f in json.loads(get('names'))['features']}
    licence = get('licence').splitlines()[0].strip()
    figures = []
    for cid, f in sorted(names.items()):
        p, (cx, cy) = f['properties'], f['geometry']['coordinates']
        segs = lines.get(cid, {}).get('geometry', {}).get('coordinates', [])
        figures.append({'id': cid, 'name': p.get('en') or p['name'], 'rank': int(p.get('rank', 3)), 'c': [ra(cx), round(cy, 2)],
                        'l': [[v for x, y in s for v in (ra(x), round(y, 2))] for s in segs]})
    out = ROOT / 'data' / 'constellations.json'
    out.write_text(json.dumps({'source': 'd3-celestial by Olaf Frohn (github.com/ofrohn/d3-celestial)', 'licence': f'BSD 3-clause, {licence}', 'figures': figures},
                              separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'{len(figures)} constellations, {sum(len(f["l"]) for f in figures)} line strings -> {out} ({out.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
