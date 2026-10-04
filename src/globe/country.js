// Click the Earth, get a dossier on the country under the cursor: its border lights up, facts (Wikidata, World Bank), what the
// globe knows about it right now (earthquakes, lighthouses, companies, the wind), and English-language headlines from its
// news outlets (GDELT, fetched live and politely: its limit is one request every few seconds). Data: data/countries.json and
// data/borders.json, made by brand/tools/make_countries.py; both load on the first click.
import { C, esc, fmt } from './env.js';
import { scene, camera } from './viewer.js';
import { fetchAsset } from '../core/assets.js';
import { prepare, inCountry, countryAt, mainBox } from '../core/borders.js';
import { Quakes } from './quakes.js';
import { Lighthouses } from './lighthouses.js';
import { Companies } from './companies.js';
import { hooks } from './state.js';
import { L } from './layers.js';

const flag = iso => /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
const big = n => n >= 1e12 ? (n / 1e12).toFixed(2) + ' trillion' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' billion' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' million' : fmt(n);

const lines = scene.primitives.add(new C.PolylineCollection());
let data = null, loading = null, news = new Map(), lastNews = 0, mirror;
const mirrorNews = async () => mirror !== undefined ? mirror : (mirror = await fetchAsset('data/news.json', 'json').catch(() => null));   // the site build's copy (build_site.py)

function load() {
  if (!loading) loading = Promise.all([fetchAsset('data/borders.json', 'json'), fetchAsset('data/countries.json', 'json')]).then(([b, c]) => {
    data = { borders: prepare(b), facts: c.countries, credit: c.source };
  }).catch(e => { loading = null; throw e; });
  return loading;
}

export const Country = {
  current: null,
  /** The country at a longitude/latitude (degrees), or null at sea. Loads the data on first use. */
  async at(lon, lat) {
    await load();
    const b = countryAt(data.borders, lon, lat);
    return b ? { kind: 'country', iso: b.iso, border: b, facts: data.facts[b.iso] || { name: b.name }, lon, lat } : null;
  },
  async byIso(iso) {
    await load(); const b = data.borders.find(b => b.iso === iso);
    return b ? { kind: 'country', iso, border: b, facts: data.facts[iso] || { name: b.name }, lon: 0, lat: 0 } : null;
  },
  highlight(o) {
    this.clear();
    const col = C.Color.fromCssColorString('#7dffa6');
    for (const p of o.border.poly) for (const ring of p) {
      const pos = C.Cartesian3.fromDegreesArray(ring.flat());
      lines.add({ positions: pos, width: 7, material: C.Material.fromType('Color', { color: col.withAlpha(0.18) }) });
      lines.add({ positions: pos, width: 2, material: C.Material.fromType('Color', { color: col.withAlpha(0.95) }) });
    }
    this.current = o; scene.requestRender();
  },
  clear() { lines.removeAll(); this.current = null; },
  rectangle(o) { const bx = mainBox(o.border); return C.Rectangle.fromDegrees(bx[0], bx[1], bx[2], bx[3]); },   // the biggest part: far islands do not drag the view
  fly(o) {
    const r = this.rectangle(o), pad = Math.max(0.15 * (r.east - r.west), 0.02);
    camera.flyTo({ destination: C.Rectangle.fromRadians(r.west - pad, Math.max(-1.45, r.south - pad), r.east + pad, Math.min(1.45, r.north + pad)), duration: 2.2 });
  },

  /** Card body: facts now, with slots (#cn*) that fill in as the live parts arrive (see after()). */
  html(o) {
    const f = o.facts, row = (k, v) => v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '';
    const stats = [row('Capital', f.capital), row('Region', f.cont), row('Population', f.pop ? `${big(f.pop)} (${f.popYear})` : ''), row('Economy', f.gdp ? `$${big(f.gdp)} (${f.gdpYear})` : ''),
      row('Per person', f.gdpPc ? `$${fmt(f.gdpPc)} a year` : ''), row('Life expectancy', f.life ? `${f.life} years` : ''), row('Languages', (f.lang || []).join(', ')), row('Currency', (f.cur || [])[0] || '')].join('');
    return `<div class="k" style="--c:#7dffa6">${flag(o.iso)} Country</div><h2>${esc(f.name)}</h2><dl>${stats}</dl>
      <div id="cnNow" class="cn-sec"></div><div id="cnCo" class="cn-sec"></div><div id="cnNews" class="cn-sec"><button class="chipbtn" id="cnNewsBtn">Headlines from ${esc(f.name)}</button></div>
      <div class="note" style="margin-top:8px">Wikidata · World Bank${f.gdp ? '' : ''}</div>`;
  },
  after(o) {
    const q = Quakes.list.filter(k => k.lon != null && inCountry(o.border, k.lon, k.lat)), lh = Lighthouses.list.length ? Lighthouses.list.filter(l => inCountry(o.border, l.lon, l.lat)) : null;
    const top = q.reduce((a, b) => (b.mag > (a ? a.mag : -1) ? b : a), null);
    const bits = [`${q.length} earthquake${q.length === 1 ? '' : 's'} in 24 h${top ? `, strongest M${top.mag.toFixed(1)}` : ''}`];
    if (lh) bits.push(`${fmt(lh.length)} lighthouses mapped`);
    const el = document.getElementById('cnNow'); if (el) el.innerHTML = `<h3>Right now</h3>${bits.map(b => `<div>${esc(b)}</div>`).join('')}`;
    const btn = document.getElementById('cnNewsBtn'); if (btn) btn.onclick = () => this.headlines(o);
    const co = Companies.list.length ? Companies.top(c => inCountry(o.border, c.lon, c.lat), 6) : [];
    const cel = document.getElementById('cnCo');
    if (cel && co.length) { cel.innerHTML = '<h3>Biggest employers here</h3>' + co.map((c, i) => `<button class="cn-co" data-i="${i}"><i style="background:${c.color}"></i><span>${esc(c.name)}</span><b>${fmt(c.employees)}</b></button>`).join('') + '<div class="note">Wikidata; by number of employees</div>'; cel.querySelectorAll('.cn-co').forEach(b => { b.onclick = () => hooks.reselect(co[+b.dataset.i]); }); }
    else if (cel && !Companies.list.length && L.companies.on) Companies.load().then(() => this.current === o && this.after(o));
  },

  /** English-language headlines from outlets in the country (GDELT: one request every few seconds, shared by all clicks). */
  async headlines(o) {
    const slot = () => document.getElementById('cnNews'); if (!slot() || this.current !== o) return;
    const m = await mirrorNews(); if (m && m.countries[o.iso]) return this.showNews(o, m.countries[o.iso], m.t);
    const key = o.iso, hit = news.get(key);
    if (hit && Date.now() - hit.t < 15 * 60e3) return this.showNews(o, hit.items);
    slot().innerHTML = '<h3>Headlines</h3><div class="note">Asking GDELT…</div>';
    const wait = lastNews + 6000 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNews = Date.now();
    try {
      const name = (o.facts.name || '').replace(/[^A-Za-z]/g, '');
      const r = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`sourcecountry:${name} sourcelang:english`)}&mode=artlist&format=json&maxrecords=8&timespan=1d&sort=hybridrel`);
      const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error(t.slice(0, 80)); }
      const items = (d.articles || []).map(a => ({ title: a.title, url: a.url, domain: a.domain, date: a.seendate })).filter(a => /^https?:\/\//.test(a.url));
      news.set(key, { t: Date.now(), items }); this.showNews(o, items);
    } catch (e) { if (slot() && this.current === o) slot().innerHTML = '<h3>Headlines</h3><div class="note">GDELT is busy or unreachable (it allows one request every few seconds). <button class="chipbtn" id="cnNewsBtn">Try again</button></div>', document.getElementById('cnNewsBtn').onclick = () => this.headlines(o); }
  },
  showNews(o, items, at) {
    const slot = document.getElementById('cnNews'); if (!slot || this.current !== o) return;
    slot.innerHTML = `<h3>Headlines · English-language outlets, last 24 h</h3>` + (items.length ? items.map(a => `<a class="cn-news" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(a.title)}</span><i>${esc(a.domain)}</i></a>`).join('') : '<div class="note">No English-language headlines found for this country in the last day.</div>')
      + `<div class="note">Headlines via GDELT${at ? `, collected ${Math.max(1, Math.round((Date.now() - at) / 36e5))} h ago` : ''}; each links to its publisher.</div>`;
  },
};
