// Close approaches between objects in orbit: CelesTrak SOCRATES (https://celestrak.org/SOCRATES/), which screens the
// public catalogue for conjunctions within 5 km over the next 7 days. The site build keeps the closest upcoming ones in
// data/socrates.json (.github/build_site.py); this module reads that and the raw CSV (for tests and the build).

/** Split one RFC 4180 CSV line (quoted fields may contain commas and doubled quotes). */
export function csvFields(line) {
  const out = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f); return out;
}

// "STARLINK-1234 [+]": the SATCAT operational status is appended in brackets
const splitName = s => { const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(s || ''); return m ? [m[1], m[2]] : [(s || '').trim(), '']; };

/** SOCRATES CSV text -> conjunctions: { a, b: { id, name, status, dse }, tca (ms UTC), rangeKm, speedKmS, maxProb } */
export function parseSocrates(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = csvFields(lines[0]).map(h => h.trim().toUpperCase()), col = k => head.indexOf(k);
  const need = ['NORAD_CAT_ID_1', 'OBJECT_NAME_1', 'NORAD_CAT_ID_2', 'OBJECT_NAME_2', 'TCA', 'TCA_RANGE', 'TCA_RELATIVE_SPEED'];
  for (const k of need) if (col(k) < 0) throw new Error('SOCRATES CSV: missing column ' + k);
  const out = [];
  for (const line of lines.slice(1)) {
    const f = csvFields(line), obj = n => { const [name, status] = splitName(f[col('OBJECT_NAME_' + n)]); return { id: String(+f[col('NORAD_CAT_ID_' + n)]), name, status, dse: +f[col('DSE_' + n)] || null }; };
    const tca = Date.parse(f[col('TCA')].trim().replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(f[col('TCA')]) ? '' : 'Z'));
    const r = { a: obj(1), b: obj(2), tca, rangeKm: +f[col('TCA_RANGE')], speedKmS: +f[col('TCA_RELATIVE_SPEED')], maxProb: col('MAX_PROB') >= 0 ? +f[col('MAX_PROB')] : null };
    if (Number.isFinite(r.tca) && Number.isFinite(r.rangeKm) && r.a.id !== 'NaN' && r.b.id !== 'NaN') out.push(r);
  }
  return out;
}

/** The ones still ahead of `now` (ms), closest first, at most `limit`. */
export function upcoming(rows, now, limit = 200) {
  return rows.filter(r => r.tca > now).sort((x, y) => x.rangeKm - y.rangeKm || x.tca - y.tca).slice(0, limit);
}
