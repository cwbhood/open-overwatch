"""Countries for the globe's click-a-country dossier: facts + simplified borders -> data/countries.json, data/borders.json

    python make_countries.py        (answers are cached in brand/source/countries/; delete that folder to refresh)

Facts: Wikidata (CC0) for the capital, continent, languages and currency; the World Bank (CC BY 4.0) for the latest population, GDP,
GDP per person and life expectancy. Borders: Natural Earth 50 m (public domain, brand/source/countries-50m.json) decoded from
TopoJSON, simplified (Douglas-Peucker, 0.06 degrees) and matched to ISO codes by name.
"""
import json, re, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE.parent / 'source' / 'countries'
UA = 'open-overwatch/0.9 (https://github.com/cwbhood/open-overwatch)'
sys.path.insert(0, str(HERE))


def curl(args):   # curl, not urllib: some Windows Pythons have a stale certificate store
    return subprocess.run(['curl', '-sSL', '--fail', '-m', '120', '-A', UA, *args], capture_output=True, check=True).stdout


def cached(name, fn):
    f = CACHE / name
    if f.exists():
        return json.loads(f.read_text(encoding='utf-8'))
    CACHE.mkdir(parents=True, exist_ok=True)
    d = fn(); f.write_text(json.dumps(d), encoding='utf-8'); time.sleep(3); return d


SPARQL = '''SELECT ?c ?iso2 ?iso3 ?name ?capLabel ?contLabel ?langLabel ?curLabel WHERE {
  ?c wdt:P297 ?iso2 . OPTIONAL { ?c wdt:P298 ?iso3 . }
  ?c wdt:P31/wdt:P279* wd:Q6256 . FILTER NOT EXISTS { ?c wdt:P576 [] }
  OPTIONAL { ?c wdt:P36 ?cap . } OPTIONAL { ?c wdt:P30 ?cont . } OPTIONAL { ?c wdt:P37 ?lang . } OPTIONAL { ?c wdt:P38 ?cur . }
  ?c rdfs:label ?name . FILTER(LANG(?name) = "en")
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}'''


def wikidata():
    out = curl(['-G', 'https://query.wikidata.org/sparql', '--data-urlencode', 'query=' + SPARQL, '-H', 'Accept: application/sparql-results+json'])
    return json.loads(out)['results']['bindings']


def worldbank(ind):
    d = json.loads(curl([f'https://api.worldbank.org/v2/country/all/indicator/{ind}?format=json&mrnev=1&per_page=400']))
    return d[1]


def main():
    facts = {}
    for r in cached('wikidata.json', wikidata):
        iso = r['iso2']['value']
        f = facts.setdefault(iso, {'name': r['name']['value'], 'iso3': r.get('iso3', {}).get('value'), 'lang': [], 'cur': [], 'cont': set()})
        for k, key in (('capLabel', 'capital'),):
            if k in r: f.setdefault(key, r[k]['value'])
        if 'contLabel' in r: f['cont'].add(r['contLabel']['value'])
        if 'langLabel' in r and r['langLabel']['value'] not in f['lang']: f['lang'].append(r['langLabel']['value'])
        if 'curLabel' in r and r['curLabel']['value'] not in f['cur']: f['cur'].append(r['curLabel']['value'])
    by3 = {f['iso3']: iso for iso, f in facts.items() if f['iso3']}
    for key, ind in (('pop', 'SP.POP.TOTL'), ('gdp', 'NY.GDP.MKTP.CD'), ('gdpPc', 'NY.GDP.PCAP.CD'), ('life', 'SP.DYN.LE00.IN')):
        for r in cached(f'wb_{ind}.json', lambda ind=ind: worldbank(ind)):
            iso = by3.get(r.get('countryiso3code'))
            if iso and r.get('value') is not None:
                facts[iso][key] = round(r['value'], 1 if key == 'life' else 0); facts[iso][key + 'Year'] = int(r['date'])
    short = {m.group(1): (float(m.group(2)), float(m.group(3)), m.group(4)) for m in re.finditer(r'"([A-Z]{2})":\[(-?[\d.]+),(-?[\d.]+),"([^"]+)"\]', (ROOT / 'src' / 'map' / 'countries.js').read_text(encoding='utf-8'))}
    for iso, f in facts.items():
        if iso in short: f['name'] = short[iso][2]; f['lat'], f['lon'] = short[iso][0], short[iso][1]   # the short names the 2D map uses, and a centre
        f['cur'] = [{'Q4916': 'euro'}.get(c, c) for c in f['cur'] if not re.fullmatch(r'Q\d+', c) or c == 'Q4916']
        if len(f['lang']) > 3: f['lang'] = []   # Wikidata lists every official language of every territory (the US: Spanish, Chamorro...): say nothing rather than something odd
    for f in facts.values():
        f['cont'] = ', '.join(sorted(f['cont'])) if f['cont'] else ''
        f['lang'] = f['lang'][:4]; f['cur'] = f['cur'][:2]
        for k in [k for k, v in f.items() if v in (None, '', [])]: del f[k]
    (ROOT / 'data' / 'countries.json').write_text(json.dumps({'source': 'Wikidata (CC0), World Bank (CC BY 4.0)', 'updated': time.strftime('%Y-%m-%d'), 'countries': facts},
                                                            ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(facts)} countries; with GDP {sum(1 for f in facts.values() if "gdp" in f)}, life {sum(1 for f in facts.values() if "life" in f)}, capital {sum(1 for f in facts.values() if "capital" in f)}')
    borders(facts)


# --- borders
ALIAS = {'United States of America': 'US', 'Dem. Rep. Congo': 'CD', 'Congo': 'CG', 'Czechia': 'CZ', 'Bosnia and Herz.': 'BA', 'Central African Rep.': 'CF',
         'Dominican Rep.': 'DO', 'Eq. Guinea': 'GQ', 'S. Sudan': 'SS', 'Solomon Is.': 'SB', 'Falkland Is.': 'FK', 'Fr. S. Antarctic Lands': 'TF',
         'W. Sahara': 'EH', 'N. Cyprus': None, 'Somaliland': None, 'Côte d\'Ivoire': 'CI', 'Macedonia': 'MK', 'North Macedonia': 'MK', 'eSwatini': 'SZ',
         'Eswatini': 'SZ', 'Timor-Leste': 'TL', 'Myanmar': 'MM', 'Russia': 'RU', 'South Korea': 'KR', 'North Korea': 'KP', 'Palestine': 'PS', 'Kosovo': 'XK',
         'Turkey': 'TR', 'Syria': 'SY', 'Laos': 'LA', 'Vietnam': 'VN', 'Iran': 'IR', 'Moldova': 'MD', 'Tanzania': 'TZ', 'Bolivia': 'BO', 'Venezuela': 'VE',
         'Brunei': 'BN', 'Cabo Verde': 'CV', 'Gambia': 'GM', 'Bahamas': 'BS', 'Taiwan': 'TW', 'S. Georgia and the Islands': 'GS', 'Antarctica': 'AQ',
         'Netherlands': 'NL', 'China': 'CN', 'Micronesia': 'FM', 'Marshall Is.': 'MH', 'Vatican': 'VA', 'Hong Kong': 'HK', 'Macao': 'MO', 'St. Vin. and Gren.': 'VC', 'St. Kitts and Nevis': 'KN', 'Anguilla': 'AI', 'Bermuda': 'BM', 'Guam': 'GU', 'American Samoa': 'AS', 'Jersey': 'JE', 'Guernsey': 'GG', 'Isle of Man': 'IM', 'Faeroe Is.': 'FO', 'Cook Is.': 'CK', 'U.S. Virgin Is.': 'VI', 'British Virgin Is.': 'VG', 'Montserrat': 'MS', 'N. Mariana Is.': 'MP', 'Pitcairn Is.': 'PN', 'Saint Helena': 'SH', 'St. Pierre and Miquelon': 'PM', 'Wallis and Futuna Is.': 'WF', 'St-Martin': 'MF', 'Greenland': 'GL', 'New Caledonia': 'NC', 'Puerto Rico': 'PR', 'Fr. Polynesia': 'PF', 'Turks and Caicos Is.': 'TC', 'Cayman Is.': 'KY'}


def dp(pts, tol):   # Douglas-Peucker on a list of (x, y)
    if len(pts) < 3: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop(); (ax, ay), (bx, by) = pts[a], pts[b]; dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy; best, bi = 0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L == 0: d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L)); d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best: best, bi = d, i
        if best > tol * tol: keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def borders(facts):
    topo = json.loads((HERE.parent / 'source' / 'countries-50m.json').read_text(encoding='utf-8'))
    sx, sy = topo['transform']['scale']; tx, ty = topo['transform']['translate']
    arcs = []
    for a in topo['arcs']:
        x = y = 0; pts = []
        for dx, dy in a:
            x += dx; y += dy; pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        out = []
        for i in idx:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out += pts if not out else pts[1:]
        return out

    def norm(s): return re.sub(r'[^a-z]', '', s.lower())
    names = {norm(f['name']): iso for iso, f in facts.items()}
    result, missed = [], []
    for g in topo['objects']['countries']['geometries']:
        name = g['properties']['name']
        iso = ALIAS[name] if name in ALIAS else names.get(norm(name)) or ('ST' if name.startswith('S') and name.endswith('Principe') else None)
        if iso and iso not in facts: iso = None
        if not iso: missed.append(name); continue
        polys = g['arcs'] if g['type'] == 'MultiPolygon' else [g['arcs']] if g['type'] == 'Polygon' else []
        out = []
        for poly in polys:
            rings = []
            for r in poly:
                pts = dp(ring(r), 0.06)
                if len(pts) >= 4: rings.append([[round(x, 2), round(y, 2)] for x, y in pts])
            if rings: out.append(rings)
        if out: result.append({'iso': iso, 'name': name, 'poly': out})
    (ROOT / 'data' / 'borders.json').write_text(json.dumps(result, separators=(',', ':')), encoding='utf-8')
    print(f'{len(result)} borders, {(ROOT / "data" / "borders.json").stat().st_size / 1e3:.0f} kB; unmatched: {missed}')


if __name__ == '__main__':
    main()
