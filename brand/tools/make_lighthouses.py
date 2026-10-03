"""Lighthouses of the world for the globe: OpenStreetMap -> data/lighthouses.json

    python make_lighthouses.py        (Overpass answers are cached per tile in brand/source/lighthouses/; delete that folder to refresh)

Twelve Overpass queries (world tiles, one at a time) for everything tagged man_made=lighthouse (nodes and ways, a way's centre is used). Each entry keeps the
fields a visitor wants: name, position, height, how the light looks (colour, flash pattern, range in nautical miles), when
it was built and who runs it. The data is (c) OpenStreetMap contributors, ODbL; the globe credits it.

Output: {"source", "updated", "count", "cols": [...], "rows": [[...]]}  (rows are arrays, to keep the file small)
"""
import json, re, subprocess, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RAW = HERE.parent / 'source' / 'lighthouses.json'   # its folder holds the per-tile cache
OUT = ROOT / 'data' / 'lighthouses.json'
QUERY = '[out:json][timeout:300];(node["man_made"="lighthouse"];way["man_made"="lighthouse"];);out center tags;'
COLS = ['lat', 'lon', 'name', 'heightM', 'colour', 'character', 'rangeNm', 'built', 'operator', 'wiki', 'status']
COLOUR = {'W': 'white', 'R': 'red', 'G': 'green', 'Y': 'yellow', 'B': 'blue', 'O': 'orange', 'V': 'violet', 'white': 'white', 'red': 'red', 'green': 'green', 'yellow': 'yellow'}


def tile(south, west, north, east):
    f = RAW.parent / 'lighthouses' / f'{south}_{west}.json'
    if f.exists():
        return json.loads(f.read_text(encoding='utf-8'))
    q = f'[out:json][timeout:120];(node["man_made"="lighthouse"]({south},{west},{north},{east});way["man_made"="lighthouse"]({south},{west},{north},{east}););out center tags;'
    for attempt in range(4):   # one polite request at a time; the public server answers 429/504 when busy
        # curl, not urllib: Python's certificate store on some Windows installs is stale and rejects the (valid) Overpass certificate
        r = subprocess.run(['curl', '-sS', '--fail', '-m', '200', '-A', 'open-overwatch/0.9 (https://github.com/cwbhood/open-overwatch)',
                            '--data-urlencode', 'data=' + q, 'https://overpass-api.de/api/interpreter'], capture_output=True)
        if r.returncode == 0:
            d = json.loads(r.stdout)['elements']
            f.parent.mkdir(parents=True, exist_ok=True); f.write_text(json.dumps(d), encoding='utf-8'); time.sleep(12)
            return d
        print(f'  tile {south},{west}: attempt {attempt + 1} failed ({r.stderr.decode()[:80].strip()}); waiting'); time.sleep(40 * (attempt + 1))
    raise SystemExit(f'tile {south},{west} kept failing; run again later (finished tiles are cached)')


def fetch():
    els = {}
    for south in range(-90, 90, 60):
        for west in range(-180, 180, 90):
            for e in tile(south, west, south + 60, west + 90):
                els[(e['type'], e['id'])] = e   # a way on a tile edge can come twice
            print(f'tiles to {south},{west}: {len(els)} so far')
    return {'elements': list(els.values())}


def num(s):
    m = re.match(r'\s*(-?\d+(?:[.,]\d+)?)', s or '')
    return float(m.group(1).replace(',', '.')) if m else None


def year(t):
    m = re.search(r'(1[0-9]{3}|20[0-2][0-9])', t.get('start_date', '') or t.get('construction:date', '') or '')
    return int(m.group(1)) if m else None


def light(t):
    """Colour, character (Fl W 10s) and range of the main light, from the seamark:light:* tags."""
    col = t.get('seamark:light:colour') or t.get('seamark:light:1:colour') or ''
    cols = [COLOUR.get(c.strip(), c.strip()) for c in re.split('[;,]', col) if c.strip()]
    ch = t.get('seamark:light:character') or t.get('seamark:light:1:character') or ''
    per = t.get('seamark:light:period') or t.get('seamark:light:1:period') or ''
    grp = t.get('seamark:light:group') or t.get('seamark:light:1:group') or ''
    pattern = ch + (f'({grp})' if grp and grp != '1' else '') + (f' {per}s' if per else '')
    rng = num(t.get('seamark:light:range') or t.get('seamark:light:1:range'))
    return '/'.join(dict.fromkeys(cols)), pattern.strip(), rng


def main():
    d = fetch()
    rows, seen = [], set()
    for e in d['elements']:
        lat, lon = (e.get('lat'), e.get('lon')) if e['type'] == 'node' else (e.get('center', {}).get('lat'), e.get('center', {}).get('lon'))
        if lat is None or lon is None:
            continue
        t = e.get('tags', {})
        status = t.get('disused') == 'yes' or 'disused:man_made' in t or t.get('abandoned') == 'yes'
        if t.get('abandoned:man_made') or t.get('demolished:man_made'):
            continue
        colour, character, rng = light(t)
        h = num(t.get('height') or t.get('seamark:light:height') or t.get('seamark:tower:height'))
        key = (round(lat, 4), round(lon, 4), t.get('name', ''))
        if key in seen:
            continue
        seen.add(key)
        wiki = t.get('wikidata', '') or ''
        rows.append([round(lat, 5), round(lon, 5), t.get('name') or t.get('name:en') or '', h, colour, character, rng, year(t),
                     t.get('operator', ''), wiki, 'disused' if status else ''])
    rows.sort(key=lambda r: (r[0], r[1]))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({'source': 'OpenStreetMap contributors (ODbL), via the Overpass API', 'updated': time.strftime('%Y-%m-%d'),
                               'count': len(rows), 'cols': COLS, 'rows': rows}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    named = sum(1 for r in rows if r[2]); lit = sum(1 for r in rows if r[5]); tall = sum(1 for r in rows if r[3])
    print(f'{len(rows)} lighthouses ({named} named, {lit} with a light pattern, {tall} with a height); {OUT.stat().st_size / 1e3:.0f} kB')


if __name__ == '__main__':
    main()
