"""The world's big employers for the globe: Wikidata (CC0) -> data/companies.json

    python make_companies.py        (answers are cached in brand/source/companies/; delete that folder to refresh)

Every company on Wikidata with an industry, a headquarters that has coordinates and at least 20,000 employees (the latest dated figure, so no
currency to get wrong; market value is NOT used: Wikidata's market caps are stale and in mixed currencies). Per company: name,
position, country, industry, employees, founding year, stock exchange, Wikidata id. Rows are arrays, columns in `cols`.
"""
import json, re, subprocess, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE.parent / 'source' / 'companies'
UA = 'open-overwatch/0.9 (https://github.com/destinjones/open-overwatch)'
BANDS = [(1_000_000, 10**9), (300_000, 1_000_000), (150_000, 300_000), (80_000, 150_000), (50_000, 80_000), (30_000, 50_000), (20_000, 30_000)]
Q = '''SELECT ?c ?cLabel ?e ?eDate ?coord ?countryLabel ?indLabel ?exLabel ?inc WHERE {
 ?c p:P1128 ?es . ?es ps:P1128 ?e . FILTER(?e >= %d && ?e < %d) OPTIONAL { ?es pq:P585 ?eDate }
  ?art schema:about ?c ; schema:isPartOf <https://en.wikipedia.org/> .   # an English Wikipedia article: a notability filter against vandalised or made-up items
  ?c wdt:P452 ?ind0 .   # an industry on record: that is what keeps universities, hospitals and armies out (the class path is far too slow)
  ?c wdt:P159 ?hq . ?hq wdt:P625 ?coord .
  FILTER NOT EXISTS { ?c wdt:P576 [] }
  OPTIONAL { ?c wdt:P17 ?country . } OPTIONAL { ?c wdt:P452 ?ind . } OPTIONAL { ?c wdt:P414 ?ex . } OPTIONAL { ?c wdt:P571 ?inc . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}'''


def band(lo, hi):
    f = CACHE / f'{lo}.json'
    if f.exists(): return json.loads(f.read_text(encoding='utf-8'))
    CACHE.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        r = subprocess.run(['curl', '-sSL', '--fail', '-m', '170', '-G', 'https://query.wikidata.org/sparql', '--data-urlencode', 'query=' + Q % (lo, hi), '-H', 'Accept: application/sparql-results+json', '-A', UA], capture_output=True)
        if r.returncode == 0:
            d = json.loads(r.stdout)['results']['bindings']; f.write_text(json.dumps(d), encoding='utf-8'); time.sleep(4); return d
        print(f'  band {lo}: attempt {attempt + 1} failed ({r.stderr.decode()[:70].strip()})'); time.sleep(30)
    raise SystemExit(f'band {lo} kept failing; run again (finished bands are cached)')


def main():
    best = {}
    for lo, hi in BANDS:
        for r in band(lo, hi):
            cid = r['c']['value'].rsplit('/', 1)[1]; name = r['cLabel']['value']
            if re.fullmatch(r'Q\d+', name): continue   # no English label
            m = re.match(r'Point\(([-\d.eE+]+) ([-\d.eE+]+)\)', r['coord']['value'])
            if not m: continue
            e = int(float(r['e']['value'])); date = r.get('eDate', {}).get('value', '')
            b = best.get(cid)
            if b is None or date > b['date'] or (date == b['date'] and e > b['e']):
                best[cid] = {'id': cid, 'name': name, 'lon': round(float(m.group(1)), 3), 'lat': round(float(m.group(2)), 3), 'e': e, 'date': date,
                             'country': r.get('countryLabel', {}).get('value', ''), 'ind': r.get('indLabel', {}).get('value', ''), 'ex': r.get('exLabel', {}).get('value', ''),
                             'inc': int(r['inc']['value'][:4]) if r.get('inc') and r['inc']['value'][:4].isdigit() else None}
            else:
                for k, key in (('indLabel', 'ind'), ('exLabel', 'ex'), ('countryLabel', 'country')):
                    if not b[key] and r.get(k): b[key] = r[k]['value']
    bad = re.compile(r'ministry|department of|ministère|army|navy|air force|police|university|hospital|school district|armed forces', re.I)
    # Wikidata is edited by volunteers: these items carry typos (a year entered as the headcount, a missing digit), found by eye
    wrong = {'International Broadcasting Multimedia Platform of Ukraine', 'ArcelorMittal Kryvyi Rih', 'Fintech Band', 'Kyivstar'}
    rows = [c for c in best.values() if 20000 <= c['e'] <= 3_000_000 and not bad.search(c['name']) and c['name'] not in wrong]   # no one employs more than ~3 million: those are typos
    for c in rows:
        if re.fullmatch(r'Q\d+', c['ind']): c['ind'] = ''
    rows.sort(key=lambda c: -c['e'])
    cols = ['name', 'lat', 'lon', 'country', 'industry', 'employees', 'founded', 'exchange', 'wiki']
    out = [[c['name'], c['lat'], c['lon'], c['country'], c['ind'], c['e'], c['inc'], c['ex'], c['id']] for c in rows]
    (ROOT / 'data' / 'companies.json').write_text(json.dumps({'source': 'Wikidata (CC0)', 'updated': time.strftime('%Y-%m-%d'), 'count': len(out), 'cols': cols, 'rows': out}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(out)} companies; top: ' + ', '.join(f'{r[0]} ({r[5] // 1000}k)' for r in out[:8]))
    print(f'with industry {sum(1 for r in out if r[4])}, exchange {sum(1 for r in out if r[7])}, founded {sum(1 for r in out if r[6])}; {(ROOT / "data" / "companies.json").stat().st_size / 1e3:.0f} kB')


if __name__ == '__main__':
    main()
