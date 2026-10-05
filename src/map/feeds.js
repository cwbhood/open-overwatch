// Point and vector layers: quakes, events, disasters, storms, news, weather, space weather, radar, clouds, terminator, cables, cameras, ships, balloons, fires, OSM scan.
import { num, idArg } from '../core/format.js';
import { COUNTRY, COUNTRY_ALIAS } from './countries.js';
import { $, C, debounce, deg, esc, fmt, haversine, isHttp, late, Log, Net, rad, Relay, safeHost, toast } from './util.js';
import { map, terminatorRing, vecRenderer } from './mapview.js';
import { Dyn, Feeds, Layers, Points, UI, feed, requestDraw, runFeed } from './engine.js';
import { Detail } from './detail.js';

/* ============================================================ POINT + VECTOR LAYERS
   Points go on the shared canvas (Points.set); only polygons and lines stay as Leaflet vectors, non-interactive. */
export function lineLayer(def) { const g = L.layerGroup(); def.group_ = g; const en = def.enable, dis = def.disable; def.enable = () => { g.addTo(map); en && en(); }; def.disable = () => { g.clearLayers(); map.removeLayer(g); dis && dis(); if (def.feed) def.feed.count = 0; }; return g; }
export function rerunFeed(f) { // option changed: refetch now, or as soon as a fetch already in flight (with the old option) finishes
  if (!f.running) return runFeed(f, true); if (f.rerunT) return;
  f.rerunT = setInterval(() => { if (f.running) return; clearInterval(f.rerunT); f.rerunT = null; runFeed(f, true); }, 300);
}
export const World = { quakes: [], events: [], storms: [], gdacs: [], news: [] }; // latest parsed feed data for the Brief

/* ---------- Earthquakes (USGS) */
export const lyQuakes = Layers.add({ id: 'quakes', group: 'Ground', name: 'Earthquakes', desc: 'USGS real-time feed', color: C.qk, shape: 'round', default: true, points: 'quakes',
  sub(el) { const feeds = [{ id: '2.5_day', name: 'M2.5+ 24 h' }, { id: '1.0_day', name: 'M1+ 24 h' }, { id: '4.5_week', name: 'M4.5+ 7 d' }, { id: 'significant_month', name: 'Significant 30 d' }]; const r = () => UI.pills(el, feeds, id => Layers.opt('quake_feed') === id, id => { Layers.setOpt('quake_feed', id); r(); if (lyQuakes.on) rerunFeed(lyQuakes.feed); }); r(); } });
Points.define('quakes', 'quakes');
Detail.renderers.quake = p => `<div class="det">${Detail.head(C.qk, 'Earthquake · USGS', `M${(p.mag ?? 0).toFixed(1)} ${p.place || ''}`, esc(fmt.date(p.time)), [p.tsunami ? { t: 'Tsunami flag', cls: 'emg' } : null, p.alert ? { t: 'PAGER ' + p.alert, cls: p.alert === 'red' ? 'emg' : 'warn' } : null].filter(Boolean))}
${Detail.kv([['Magnitude', `${(p.mag ?? 0).toFixed(1)} ${p.magType || ''}`], ['Depth', `${fmt.n(p.depth, 1)} km`], ['Position', fmt.ll(p.lat, p.lon)], ['Felt reports', p.felt], ['Status', p.status], ['Age', fmt.ago(p.time) + ' ago']])}
<div class="actions"><button class="btn small" onclick="flyTo(${num(p.lat)},${num(p.lon)},7)">Center</button></div><hr class="sep">${Detail.links([{ text: 'USGS event page', url: p.url }])}</div>`;
feed(lyQuakes, { interval: 300, fetch: async () => {
  const d = await Net.json(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${Layers.opt('quake_feed') || '2.5_day'}.geojson`); const items = []; World.quakes = [];
  for (const f of d.features || []) {
    const [lon, lat, depth] = f.geometry.coordinates, p = { ...f.properties, id: f.id, lat, lon, depth }; World.quakes.push(p);
    const age = (Date.now() - p.time) / 3600e3, r = Math.max(2.5, 2 + (p.mag - 1) * 2.4);
    items.push({ lat, lon, r, color: C.qk, alpha: Math.max(.35, 1 - age / 48), fillAlpha: Math.max(.08, .45 - age / 60), kind: 'quake', obj: p, tip: `M${p.mag?.toFixed(1)} · ${p.place || ''} · ${fmt.ago(p.time)} ago`, label: p.mag >= 5.5 ? `M${p.mag.toFixed(1)}` : null, labelZoom: 2 });
    if (p.mag >= 6 && Date.now() - p.time < 3600e3 && !lyQuakes.seen?.has(f.id)) { (lyQuakes.seen ||= new Set()).add(f.id); Log.alert(`M${p.mag.toFixed(1)} earthquake · ${p.place}`, { onclick: () => { flyTo(lat, lon, 6); Detail.show('quake', p, f.id); } }); }
  }
  Points.set('quakes', items); lyQuakes.feed.count = items.length; const big = World.quakes.slice().sort((a, b) => b.mag - a.mag)[0]; if (big) lyQuakes.desc = `Largest: M${big.mag?.toFixed(1)} ${big.place}`;
} });

/* ---------- Natural events (NASA EONET) */
export const lyEvents = Layers.add({ id: 'events', group: 'Ground', name: 'Natural events', desc: 'NASA EONET · wildfires, storms, volcanoes, floods, ice', color: C.evt, default: false, points: 'events' });
export const gEvents = lineLayer(lyEvents); Points.define('events', 'events');
export const EONET_COL = { wildfires: '#ff8c42', severeStorms: '#7fd0ff', volcanoes: '#ff5c5c', seaLakeIce: '#bfe8ff', floods: '#4fa3ff', drought: '#e0c068', dustHaze: '#d9b38c', earthquakes: C.qk, landslides: '#b08968', manmade: '#e3e3e3', snow: '#ffffff', tempExtremes: '#ff7b00', waterColor: '#4fd1c5' };
Detail.renderers.event = e => `<div class="det">${Detail.head(e.color, 'Natural event · NASA EONET', e.title, esc(e.cats.join(' · ')), e.closed ? [{ t: 'Closed ' + e.closed.slice(0, 10) }] : [{ t: 'Open', cls: 'good' }])}
${Detail.kv([['Latest position', fmt.ll(e.lat, e.lon)], ['Latest fix', fmt.date(e.date)], ['First reported', e.first ? fmt.date(e.first) : null], ['Fixes', e.n], ['Magnitude', e.mag]])}
<div class="actions"><button class="btn small" onclick="flyTo(${num(e.lat)},${num(e.lon)},7)">Center</button></div><hr class="sep">${Detail.links([{ text: 'EONET event', url: e.link }, ...e.sources.map(s => ({ text: `Source: ${s.id}`, url: s.url }))])}</div>`;
feed(lyEvents, { interval: 900, fetch: async () => {
  const d = await Net.json('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=20'); gEvents.clearLayers(); const items = []; World.events = [];
  for (const ev of d.events || []) {
    const geos = (ev.geometry || []).filter(g => g.type === 'Point'); if (!geos.length) continue; const g = geos[geos.length - 1]; const [lon, lat] = g.coordinates;
    const cat = ev.categories?.[0]?.id || 'other', color = EONET_COL[cat] || C.evt;
    const e = { id: ev.id, title: ev.title, cat, cats: (ev.categories || []).map(c => c.title), lat, lon, date: g.date, first: geos[0].date, n: geos.length, color, link: ev.link, sources: (ev.sources || []).filter(s => isHttp(s.url)), closed: ev.closed, mag: g.magnitudeValue ? `${g.magnitudeValue} ${g.magnitudeUnit || ''}` : null };
    World.events.push(e); items.push({ lat, lon, r: 4.5, color, fillAlpha: .35, kind: 'event', obj: e, tip: ev.title });
    if (geos.length > 1) L.polyline(geos.slice(-12).map(x => [x.coordinates[1], x.coordinates[0]]), { color, weight: 1, opacity: .5, interactive: false, renderer: vecRenderer }).addTo(gEvents);
  }
  Points.set('events', items); lyEvents.feed.count = items.length;
} });

/* ---------- Disaster alerts (GDACS) */
export const lyGdacs = Layers.add({ id: 'gdacs', group: 'Ground', name: 'Disaster alerts', desc: 'GDACS (EU/UN) · cyclones, floods, volcanoes, drought, fires · last 14 days', color: '#ff9a3c', default: false, points: 'gdacs' });
Points.define('gdacs', 'gdacs');
export const GDACS_LVL = { Red: C.emg, Orange: C.warn, Green: C.accent };
Detail.renderers.gdacs = p => `<div class="det">${Detail.head(GDACS_LVL[p.alertlevel] || C.warn, 'Disaster alert · GDACS', p.name || p.eventname || p.eventtype, esc(p.description || ''), [{ t: `${p.alertlevel || ''} alert`, cls: p.alertlevel === 'Red' ? 'emg' : p.alertlevel === 'Orange' ? 'warn' : 'good' }, { t: p.eventtype }])}
${Detail.kv([['Country', p.country], ['From', p.fromdate ? fmt.date(p.fromdate) : null], ['To', p.todate ? fmt.date(p.todate) : null], ['Severity', p.severitydata?.severitytext], ['Episode', p.episodeid], ['Position', fmt.ll(p.lat, p.lon)]])}
<div class="actions"><button class="btn small" onclick="flyTo(${num(p.lat)},${num(p.lon)},6)">Center</button></div><hr class="sep">${Detail.links([p.url?.report ? { text: 'GDACS report', url: p.url.report } : null, p.url?.details ? { text: 'Details (JSON)', url: p.url.details } : null].filter(Boolean))}</div>`;
feed(lyGdacs, { interval: 900, fetch: async () => {
  const day = t => new Date(t).toISOString().slice(0, 10);
  const features = []; // the API answers 100 events per page, newest-modified first: page through the whole 14 days
  for (let page = 1; page <= 10; page++) {
    const d = await Net.json(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;WF;DR&fromDate=${day(Date.now() - 14 * 86400e3)}&toDate=${day(Date.now())}&alertlevel=Green;Orange;Red&pagenumber=${page}`, { timeout: 60000, throttle: 'gdacs', gap: 1000 });
    const fs = d.features || []; features.push(...fs); if (fs.length < 100) break;
  }
  const items = [], seen = new Set(); World.gdacs = [];
  for (const f of features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue; const [lon, lat] = f.geometry.coordinates; const p = { ...f.properties, lat, lon }; const col = GDACS_LVL[p.alertlevel] || C.warn;
    const key = p.eventtype + p.eventid; if (p.eventid != null && seen.has(key)) continue; seen.add(key); // one marker per event (latest episode)
    for (const k of ['fromdate', 'todate']) if (typeof p[k] === 'string' && !/(Z|[+-]\d\d:?\d\d)$/.test(p[k])) p[k] += 'Z'; // GDACS times are UTC without a zone
    if (p.eventtype === 'EQ' && p.alertlevel === 'Green') continue; // USGS covers minor quakes already
    World.gdacs.push(p); items.push({ lat, lon, r: p.alertlevel === 'Red' ? 8 : p.alertlevel === 'Orange' ? 6 : 4, color: col, fillAlpha: .2, halo: p.alertlevel === 'Red' ? 14 : 0, kind: 'gdacs', obj: p, tip: `${p.eventtype} · ${p.name || ''} (${p.alertlevel})`, label: p.alertlevel !== 'Green' ? (p.eventname || p.eventtype) : null, labelZoom: 3 });
  }
  Points.set('gdacs', items); lyGdacs.feed.count = items.length;
} });

/* ---------- Tropical cyclones (NASA EONET storm tracks, plus NHC advisories when the helper runs) */
export const lyStorms = Layers.add({ id: 'storms', group: 'Weather & space weather', name: 'Tropical cyclones', desc: 'NASA EONET storm tracks worldwide · NHC advisories when the helper runs', color: '#7fd0ff', shape: 'round', default: true, points: 'storms' });
export const gStorms = lineLayer(lyStorms); Points.define('storms', 'storms');
Detail.renderers.storm = s => `<div class="det">${Detail.head('#7fd0ff', 'Tropical cyclone · ' + s.src, s.title, esc(s.sub || ''), s.kt ? [{ t: `${s.kt} kt`, cls: s.kt >= 64 ? 'emg' : 'warn' }] : [])}
${Detail.kv([['Max winds', s.kt ? `${s.kt} kt · ${fmt.n(s.kt * 1.852)} km/h` : null], ['Pressure', s.pressure ? `${s.pressure} mb` : null], ['Movement', s.movement], ['Position', fmt.ll(s.lat, s.lon)], ['Latest fix', s.date ? fmt.date(s.date) : null], ['Track points', s.n], ['Advisory', s.advisory]])}
<div class="actions"><button class="btn small" onclick="flyTo(${num(s.lat)},${num(s.lon)},6)">Center</button></div><hr class="sep">${Detail.links(s.links)}</div>`;
feed(lyStorms, { interval: 1200, errorInterval: 1800, fetch: async () => {
  const d = await Net.json('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=severeStorms&days=10'); gStorms.clearLayers(); const items = []; World.storms = [];
  for (const ev of d.events || []) {
    const pts = (ev.geometry || []).filter(g => g.type === 'Point'); if (!pts.length) continue; const g = pts[pts.length - 1]; const [lon, lat] = g.coordinates;
    const kt = g.magnitudeUnit === 'kts' ? +g.magnitudeValue : null;
    const s = { id: ev.id, src: 'NASA EONET', title: ev.title, lat, lon, kt, date: g.date, n: pts.length, links: [{ text: 'EONET event', url: ev.link }, ...(ev.sources || []).filter(x => isHttp(x.url)).map(x => ({ text: `Source: ${x.id}`, url: x.url }))] };
    const col = kt >= 64 ? '#ff7b7b' : '#7fd0ff';
    L.polyline(pts.map(p => [p.coordinates[1], p.coordinates[0]]), { color: col, weight: 1.5, opacity: .6, interactive: false, renderer: vecRenderer }).addTo(gStorms);
    World.storms.push(s); items.push({ lat, lon, r: 7, color: col, fillAlpha: .25, lw: 2, halo: 16, kind: 'storm', obj: s, tip: `${ev.title}${kt ? ' · ' + kt + ' kt' : ''}`, label: ev.title.replace(/^(Tropical Storm|Hurricane|Typhoon|Cyclone|Tropical Cyclone)\s+/i, ''), labelZoom: 2 });
  }
  if (Relay.available) { try { // NHC adds official advisories for Atlantic / East & Central Pacific storms
    const nhc = await Net.json('https://www.nhc.noaa.gov/CurrentStorms.json');
    for (const st of nhc.activeStorms || []) { const lat = +st.latitudeNumeric, lon = +st.longitudeNumeric; if (!isFinite(lat)) continue;
      const s = { id: st.id, src: 'NOAA NHC', title: `${st.classification || ''} ${st.name}`.trim(), sub: `Basin ${st.binNumber || ''}`, lat, lon, kt: +st.intensity || null, pressure: st.pressure, movement: st.movementDir != null ? `${st.movementDir}° at ${st.movementSpeed} kt` : null, advisory: st.lastUpdate, links: [st.publicAdvisory?.url ? { text: `Public advisory ${st.publicAdvisory.advNum || ''}`, url: st.publicAdvisory.url } : null, st.forecastAdvisory?.url ? { text: 'Forecast advisory', url: st.forecastAdvisory.url } : null, { text: 'NHC home', url: 'https://www.nhc.noaa.gov/' }].filter(Boolean) };
      const dup = World.storms.find(x => haversine(x.lat, x.lon, lat, lon) < 300000); if (dup) { dup.nhc = s; dup.kt = dup.kt || s.kt; dup.links = [...s.links, ...dup.links]; dup.pressure = s.pressure; dup.movement = s.movement; dup.advisory = s.advisory; dup.src = 'NASA EONET + NOAA NHC';
        const it = items.find(i => i.obj === dup); if (it && dup.kt) { it.tip = `${dup.title} · ${dup.kt} kt`; if (dup.kt >= 64) it.color = '#ff7b7b'; } } // the marker was built from EONET's (maybe missing) wind
      else { World.storms.push(s); items.push({ lat, lon, r: 7, color: '#7fd0ff', fillAlpha: .25, lw: 2, halo: 16, kind: 'storm', obj: s, tip: `NHC: ${s.title} · ${s.kt} kt`, label: st.name, labelZoom: 2 }); } }
  } catch (e) { Log.warn('NHC advisories: ' + e.message); } }
  Points.set('storms', items); lyStorms.feed.count = items.length; lyStorms.desc = items.length ? `Active: ${World.storms.slice(0, 4).map(s => s.title).join(', ')}${World.storms.length > 4 ? ' +' + (World.storms.length - 4) : ''}` : 'No active storms in EONET right now';
} });

/* ---------- World news by source country (GDELT DOC 2.0; the GEO API was retired) */
export const lyNews = Layers.add({ id: 'news', group: 'Ground', name: 'World news', desc: 'GDELT · last 24 h of coverage matching your query, placed by the reporting country', color: C.news, default: false, points: 'news',
  sub(el) { const w = document.createElement('div'); w.style.cssText = 'display:flex;gap:4px;width:100%'; w.innerHTML = `<input class="mono" id="newsQ" style="flex:1;min-width:0;background:var(--panel-2);border:1px solid var(--line-strong);border-radius:3px;padding:4px 7px;font-size:11px" placeholder="query, e.g. missile OR drone" value="${esc(Layers.opt('news_q'))}"><button type="button" class="btn small">Run</button>`;
    const go = () => { Layers.setOpt('news_q', $('#newsQ', w).value.trim() || 'military'); if (lyNews.on) rerunFeed(lyNews.feed); }; $('button', w).addEventListener('click', go); $('input', w).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }); el.appendChild(w); } });
Points.define('news', 'news');
export function countryIso(name) {
  if (!name) return null; let s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z, ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.includes(',')) { const parts = s.split(',').map(x => x.trim()); s = (parts.slice(1).join(' ') + ' ' + parts[0]).trim(); }
  s = s.replace(/^the /, '').replace(/\s+/g, ' ');
  if (COUNTRY_ALIAS[s]) return COUNTRY_ALIAS[s];
  for (const [iso, v] of Object.entries(COUNTRY)) if (v[2].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim() === s) return iso;
  return null;
}
export function gdeltQuery(q) { q = q.trim(); if (/\bOR\b/i.test(q) && !/^\(.*\)$/.test(q)) q = '(' + q + ')'; return q; }
Detail.renderers.news = p => `<div class="det">${Detail.head(C.news, 'World news · GDELT', p.name, `${fmt.n(p.count)} article${p.count === 1 ? '' : 's'} from ${esc(p.name)} outlets in the last 24 h matching <span class="mono">${esc(p.q || Layers.opt('news_q'))}</span>`)}
${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
<div class="actions"><button class="btn small" onclick="flyTo(${num(p.lat)},${num(p.lon)},5)">Center</button></div><hr class="sep">${Detail.links(p.articles)}</div>`;
feed(lyNews, { interval: 900, errorInterval: 900, fetch: async () => {
  const q = gdeltQuery(Layers.opt('news_q') || 'military');
  let txt; // GDELT sends CORS itself now (no helper needed), but its rate-limit replies don't, so they surface as a CORS error
  try { txt = await Net.text(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=250&timespan=24h`, { timeout: 40000, throttle: 'gdelt', gap: 6000 }); }
  catch (e) { throw /CORS|HTTP 429/.test(e.message) ? new Error('GDELT refused the request (usually its limit of one query per 5 s, or offline): retrying later') : e; }
  let d; try { d = txt.trim() ? JSON.parse(txt) : {}; } catch (e) { throw new Error('GDELT: ' + txt.trim().replace(/\s+/g, ' ').slice(0, 160)); } // bad queries come back as plain text with HTTP 200
  const by = new Map(); let unknown = 0;
  for (const a of d.articles || []) {
    const iso = countryIso(a.sourcecountry); if (!iso || !COUNTRY[iso]) { unknown++; continue; }
    const g = by.get(iso) || { iso, name: COUNTRY[iso][2], lat: COUNTRY[iso][0], lon: COUNTRY[iso][1], count: 0, articles: [], image: null, q }; by.set(iso, g);
    g.count++; if (g.articles.length < 15 && isHttp(a.url)) g.articles.push({ text: (a.title || a.url).slice(0, 140), url: a.url, sub: `${a.domain || safeHost(a.url)} · ${a.language || ''} · ${(a.seendate || '').replace(/T(\d\d)(\d\d)\d\dZ/, ' $1:$2Z')}` });
    if (!g.image && isHttp(a.socialimage)) g.image = a.socialimage;
  }
  World.news = [...by.values()].sort((a, b) => b.count - a.count);
  Points.set('news', World.news.map(p => ({ lat: p.lat, lon: p.lon, r: Math.min(16, 4 + Math.log2(p.count + 1) * 2), color: C.news, fillAlpha: .3, kind: 'news', obj: p, tip: `${p.name} · ${p.count} article${p.count === 1 ? '' : 's'}` })));
  lyNews.feed.count = (d.articles || []).length; Log.info(`GDELT: ${(d.articles || []).length} articles from ${by.size} countries for "${q}"${unknown ? ` (${unknown} with no country)` : ''}`);
} });

/* ---------- NWS severe alerts (US) — polygons stay as Leaflet vectors, clickable */
export const lyNws = Layers.add({ id: 'nws', group: 'Weather & space weather', name: 'Severe weather alerts (US)', desc: 'NWS · Extreme and Severe warnings with polygons', color: C.alert, default: true });
export const gNws = lineLayer(lyNws);
Detail.renderers.nws = p => `<div class="det">${Detail.head(C.alert, 'NWS alert', p.event, esc(p.headline || ''), [{ t: p.severity, cls: p.severity === 'Extreme' ? 'emg' : 'warn' }, { t: p.urgency }, { t: p.certainty }])}
${Detail.kv([['Areas', p.areaDesc], ['Sender', p.senderName], ['Onset', p.onset ? fmt.date(p.onset) : null], ['Expires', p.expires ? fmt.date(p.expires) : null]])}
<p style="font-size:12.5px;line-height:1.45;white-space:pre-wrap;color:var(--ink-dim);max-height:40vh;overflow:auto">${esc((p.description || '').slice(0, 2500))}</p>
<hr class="sep">${Detail.links([{ text: 'Alert on weather.gov', url: p['@id'] || 'https://www.weather.gov/alerts' }])}</div>`;
feed(lyNws, { interval: 300, fetch: async () => {
  const d = await Net.json('https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&severity=Extreme,Severe', { timeout: 60000 }); gNws.clearLayers(); let n = 0, drawn = 0; World.nws = [];
  for (const f of d.features || []) {
    const p = f.properties || {}; n++; World.nws.push(p); if (!f.geometry) continue; const isTor = /tornado|hurricane|extreme wind/i.test(p.event || ''); const col = isTor ? C.emg : /flash flood|storm/i.test(p.event || '') ? C.warn : '#ff9a6b';
    const g = L.geoJSON(f.geometry, { bubblingMouseEvents: false, style: { color: col, weight: isTor ? 2 : 1.2, fillColor: col, fillOpacity: isTor ? .25 : .12, renderer: vecRenderer } }); g.on('click', () => Detail.show('nws', p, p.id)); gNws.addLayer(g); drawn++;
    if (isTor && !lyNws.seen?.has(p.id)) { (lyNws.seen ||= new Set()).add(p.id); if (/tornado warning/i.test(p.event) && Date.now() - (Date.parse(p.sent) || 0) < 900e3) Log.alert(`${p.event}: ${p.areaDesc}`, { onclick: () => { const c = g.getBounds().getCenter(); flyTo(c.lat, c.lng, 8); Detail.show('nws', p, p.id); } }); }
  }
  lyNws.feed.count = drawn; lyNws.desc = `${n} active Extreme/Severe alerts · ${drawn} with polygons`;
} });

/* ---------- Aurora (NOAA SWPC OVATION) + Kp */
export const lyAurora = Layers.add({ id: 'aurora', group: 'Weather & space weather', name: 'Aurora forecast', desc: 'NOAA SWPC OVATION · 30–90 min forecast of visible-aurora probability', color: '#5cff9a', default: false });
export let auroraOverlay = null; export const Aurora = { grid: null, at(lat, lon) { if (!this.grid) return null; const li = Math.round(lat) + 90, lo = ((Math.round(lon) % 360) + 360) % 360; return this.grid[li * 360 + lo] || 0; } };
lyAurora.enable = () => { if (auroraOverlay) auroraOverlay.addTo(map); }; lyAurora.disable = () => { if (auroraOverlay) map.removeLayer(auroraOverlay); lyAurora.feed.count = 0; };
feed(lyAurora, { interval: 900, fetch: async () => {
  const d = await Net.json('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', { timeout: 60000 });
  const grid = new Float32Array(360 * 181); for (const [lon, lat, v] of d.coordinates || []) grid[(lat + 90) * 360 + (lon % 360)] = v; Aurora.grid = grid;
  const W = 1440, H = 720, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d'); const img = ctx.createImageData(W, H); const px = img.data;
  const maxLat = 85.0511; const yToLat = y => { const t = 1 - 2 * (y + .5) / H; return deg(Math.atan(Math.sinh(t * Math.PI))); }; // Mercator rows
  for (let y = 0; y < H; y++) { const lat = yToLat(y); const li = Math.round(lat) + 90; for (let x = 0; x < W; x++) { const lon = Math.round(x / W * 360 - 180 + 360) % 360; const v = grid[li * 360 + lon] || 0; if (v < 2) continue; const i = (y * W + x) * 4; const a = Math.min(.85, v / 60); px[i] = v > 50 ? 255 : 92 + v * 2; px[i + 1] = 255 - (v > 50 ? (v - 50) * 3 : 0); px[i + 2] = 154 - v; px[i + 3] = Math.round(a * 255); } }
  ctx.putImageData(img, 0, 0); const url = cv.toDataURL();
  if (auroraOverlay) map.removeLayer(auroraOverlay); auroraOverlay = L.imageOverlay(url, [[-maxLat, -180], [maxLat, 180]], { opacity: .8, interactive: false, className: 'aurora-ov' }); if (lyAurora.on) auroraOverlay.addTo(map);
  lyAurora.feed.count = (d.coordinates || []).filter(c => c[2] >= 20).length; lyAurora.desc = `Forecast for ${d['Forecast Time'] || ''} · ${lyAurora.feed.count} cells ≥ 20 %`;
} });
export const Space = { kp: null, kpTime: null };
export async function fetchKp() {
  try {
    const d = await Net.json('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    // NOAA has shipped this as rows [time_tag, Kp, ...] with a header row, and as objects {time_tag, Kp}
    const rows = (Array.isArray(d) ? d : []).map(r => Array.isArray(r) ? { t: r[0], kp: parseFloat(r[1]) } : { t: r.time_tag, kp: parseFloat(r.Kp ?? r.kp ?? r.kp_index) }).filter(r => isFinite(r.kp));
    const last = rows[rows.length - 1]; if (!last) throw new Error('no Kp rows');
    const kp = last.kp; Space.kp = kp; Space.kpTime = last.t; $('#chipKp b').textContent = kp.toFixed(1); $('#chipKp').classList.toggle('hot', kp >= 5);
    $('#chipKp').title = `Planetary K-index ${kp} at ${last.t} UTC (NOAA SWPC)` + (kp >= 5 ? ' · geomagnetic storm' : '');
    if (kp >= 6 && !window._kpWarned) { window._kpWarned = true; Log.warn(`Geomagnetic storm: Kp ${kp}`); } else if (kp < 5) window._kpWarned = false; // re-arm for the next storm
  } catch (e) { $('#chipKp b').textContent = '—'; $('#chipKp').title = 'Kp unavailable: ' + e.message; }
}
fetchKp(); setInterval(() => { if (!Feeds.paused) fetchKp(); }, 600000);

/* ---------- Precipitation radar (RainViewer) + IR satellite (NASA GIBS geostationary band 13; RainViewer dropped its IR product) */
export const lyRadar = Layers.add({ id: 'radar', group: 'Weather & space weather', name: 'Precipitation radar', desc: 'RainViewer · latest composite radar', color: '#4fa3ff', default: false });
export const lyIr = Layers.add({ id: 'irsat', group: 'Weather & space weather', name: 'Cloud cover (IR satellite)', desc: 'NASA GIBS · GOES-East, GOES-West and Himawari clean-IR (band 13), newest 10-min scans · no Europe/Africa disk', color: '#c9d6df', default: false });
export let radarTiles = null, irTiles = null;
lyRadar.enable = () => { if (radarTiles) radarTiles.addTo(map); }; lyRadar.disable = () => { if (radarTiles) map.removeLayer(radarTiles); };
lyIr.enable = () => { if (irTiles) irTiles.addTo(map); }; lyIr.disable = () => { if (irTiles) map.removeLayer(irTiles); };
export async function rainviewer(kind) {
  const d = await Net.json('https://api.rainviewer.com/public/weather-maps.json'); const host = d.host || 'https://tilecache.rainviewer.com';
  if (kind === 'radar') { const fr = (d.radar?.past || []).slice(-1)[0]; if (!fr) throw new Error('no radar frames'); const url = `${host}${fr.path}/256/{z}/{x}/{y}/2/1_1.png`; if (radarTiles) map.removeLayer(radarTiles); radarTiles = L.tileLayer(url, { opacity: .7, maxNativeZoom: 7, zIndex: 400, attribution: 'RainViewer' }); /* the free tiles stop at zoom 7 (8+ is a "Zoom Level Not Supported" image): Leaflet upscales past it */ if (lyRadar.on) radarTiles.addTo(map); lyRadar.desc = `Frame ${fmt.hms(fr.time * 1000)}Z`; lyRadar.feed.count = 1; }
}
// GIBS serves each disk's newest scan as time "default" (CORS *, no-cache), so a refresh is a cache-busting redraw.
// The three layers share one pane inside the tile pane, so the opacity applies once and overlapping disks show no seams.
export const GIBS_IR = ['GOES-West_ABI_Band13_Clean_Infrared', 'Himawari_AHI_Band13_Clean_Infrared', 'GOES-East_ABI_Band13_Clean_Infrared'];
export const irPane = map.createPane('irsat', map.getPane('tilePane')); irPane.style.zIndex = 390; irPane.style.opacity = .55; irPane.style.pointerEvents = 'none';
export async function gibsIr() {
  const b = Math.floor(Date.now() / 600e3);
  if (!irTiles) irTiles = L.layerGroup(GIBS_IR.map(id => L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${id}/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png?b={b}`, { b, pane: 'irsat', maxNativeZoom: 6, attribution: 'NASA GIBS · GOES / Himawari' })));
  else irTiles.eachLayer(t => { if (t.options.b !== b) { t.options.b = b; t.redraw(); } });
  if (lyIr.on && !map.hasLayer(irTiles)) irTiles.addTo(map); lyIr.feed.count = GIBS_IR.length;
}
feed(lyRadar, { interval: 600, fetch: () => rainviewer('radar') }); feed(lyIr, { interval: 600, fetch: gibsIr });

/* ---------- Day/night terminator */
export const lyTerm = Layers.add({ id: 'terminator', group: 'Weather & space weather', name: 'Day / night', desc: 'Solar terminator, computed locally', color: '#2b3c49', default: true });
export let termPoly = null, termTimer = null;
export function drawTerminator() { const ring = terminatorRing(Date.now()); if (termPoly) termPoly.setLatLngs([ring]); else termPoly = L.polygon([ring], { color: '#000', weight: 0, fillColor: '#000', fillOpacity: .32, interactive: false, renderer: vecRenderer }); if (lyTerm.on && !map.hasLayer(termPoly)) termPoly.addTo(map); }
lyTerm.enable = () => { drawTerminator(); termTimer = setInterval(drawTerminator, 60000); }; lyTerm.disable = () => { clearInterval(termTimer); if (termPoly) map.removeLayer(termPoly); };

/* ---------- Submarine cables + landing points (TeleGeography data); cables are non-interactive lines with a manual click test */
export const lyCables = Layers.add({ id: 'cables', group: 'Infrastructure', name: 'Submarine cables', desc: 'TeleGeography submarine cable map data · live with the helper, an older GitHub copy without it', color: C.cable, default: false });
export const gCables = lineLayer(lyCables); export let cableData = null;
export const lyLanding = Layers.add({ id: 'landing', group: 'Infrastructure', name: 'Cable landing stations', desc: 'Where the cables come ashore', color: '#8fc6e6', shape: 'round', default: false, points: 'landing' });
Points.define('landing', 'landing', { minZoom: 4 });
Detail.renderers.cable = p => `<div class="det">${Detail.head(/^#[0-9a-f]{3,8}$/i.test(p.color || '') ? p.color : C.cable, 'Submarine cable · TeleGeography', p.name, '')}${Detail.links([{ text: 'Cable page on submarinecablemap.com', url: `https://www.submarinecablemap.com/submarine-cable/${encodeURIComponent(p.id)}` }])}</div>`;
Detail.renderers.landing = p => `<div class="det">${Detail.head('#8fc6e6', 'Cable landing station', p.name, '')}${Detail.links([{ text: 'Landing point on submarinecablemap.com', url: `https://www.submarinecablemap.com/landing-point/${encodeURIComponent(p.id)}` }])}</div>`;
// live TeleGeography first (no CORS header: relayed by the helper; without it Net fails fast), then a GitHub copy that is months behind
export const CABLE_URLS = ['https://www.submarinecablemap.com/api/v3/cable/cable-geo.json', 'https://raw.githubusercontent.com/lintaojlu/submarine_cable_information/master/web/public/api/v3/cable/cable-geo.json'];
export const LANDING_URLS = ['https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json', 'https://raw.githubusercontent.com/lintaojlu/submarine_cable_information/master/web/public/api/v3/landing-point/landing-point-geo.json'];
export async function firstOk(urls, o) { let err; for (const u of urls) { try { return await Net.json(u, o); } catch (e) { err = e; } } throw err; }
export function cableHit(latlng) { // nearest cable segment within ~10 px (local flat frame in metres around the click)
  if (!cableData || !lyCables.on) return null; const tol = 10 * 40075016 * Math.cos(rad(latlng.lat)) / (256 * Math.pow(2, map.getZoom())); let best = null, bd = tol;
  const la0 = latlng.lat, lo0 = latlng.lng, kx = 111320 * Math.cos(rad(la0)), ky = 110540, P = c => [(((c[0] - lo0) % 360 + 540) % 360 - 180) * kx, (c[1] - la0) * ky];
  for (const f of cableData.features) { const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of lines) { let a = null; for (const c of line) { const b = P(c);
      if (a && Math.abs(b[0] - a[0]) < 180 * kx && Math.min(Math.abs(a[1]), Math.abs(b[1])) < tol + Math.abs(b[1] - a[1])) { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2)) : 0; const d = Math.hypot(a[0] + t * dx, a[1] + t * dy); if (d < bd) { bd = d; best = f; } }
      a = b; } } }
  return best;
}
feed(lyCables, { interval: 86400, fetch: async () => { const d = cableData && Date.now() - cableData._t < 86400e3 ? cableData : await firstOk(CABLE_URLS, { timeout: 60000 }); d._t = d._t || Date.now(); cableData = d; gCables.clearLayers(); // toggling the layer reuses the multi-MB file
  gCables.addLayer(L.geoJSON(d, { interactive: false, style: f => ({ color: f.properties?.color || C.cable, weight: 1.2, opacity: .55, renderer: vecRenderer }) })); lyCables.feed.count = (d.features || []).length; } });
feed(lyLanding, { interval: 86400, fetch: async () => { const d = await firstOk(LANDING_URLS, { timeout: 60000 });
  Points.set('landing', (d.features || []).map(f => { const [lon, lat] = f.geometry.coordinates; return { lat, lon, r: 2.5, color: '#8fc6e6', fillAlpha: .6, kind: 'landing', obj: f.properties, tip: f.properties?.name || '' }; })); lyLanding.feed.count = (d.features || []).length; } });

/* ---------- Traffic & public cameras (each source loads only while its region is on screen; drawn from zoom 8) */
export const CAM_SRCS = [
  { id: 'tfl', name: 'London', title: 'TfL JamCams · stills + short clips', bbox: [51.2, -0.6, 51.8, 0.4] },
  { id: 'nyc', name: 'New York', title: 'NYC DOT · needs the helper', bbox: [40.4, -74.4, 41.0, -73.6] },
  { id: 'caltrans', name: 'California', title: 'Caltrans CCTV, all 12 districts', bbox: [32.4, -124.6, 42.1, -114.0], dynamic: true },
  { id: 'singapore', name: 'Singapore', title: 'LTA traffic cameras via data.gov.sg', bbox: [1.15, 103.55, 1.5, 104.1] },
  { id: 'finland', name: 'Finland', title: 'Fintraffic road weather cameras (~700)', bbox: [59.6, 19.0, 70.2, 31.7] },
];
export const lyCams = Layers.add({ id: 'cams', group: 'Ground', name: 'Public cameras', desc: 'Official traffic-camera feeds · appear from zoom 8 over London, New York, California, Singapore, Finland · Windy key adds webcams worldwide', color: C.cam, default: true, points: 'cams',
  sub(el) { const r = () => UI.pills(el, CAM_SRCS, id => (Layers.opt('cam_src') || []).includes(id), (id, on) => { const s = (Layers.opt('cam_src') || []).filter(x => x !== id); if (on) s.push(id); Layers.setOpt('cam_src', s); r(); if (lyCams.on) rerunFeed(lyCams.feed); }); r();
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pill'; b.textContent = 'show regions'; b.title = 'Fly to the covered regions one by one'; let i = 0; b.addEventListener('click', () => { const s = CAM_SRCS[i++ % CAM_SRCS.length]; map.flyToBounds([[s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]], { duration: 1 }); toast('Cameras: ' + s.name); }); el.appendChild(b); } });
Points.define('cams', 'cams', { minZoom: 8 });
export function viewIntersects(bbox) { const b = map.getBounds(); return !(b.getNorth() < bbox[0] || b.getSouth() > bbox[2] || b.getEast() < bbox[1] || b.getWest() > bbox[3]); }
Detail.renderers.cam = c => {
  const bust = (u) => u ? (u + (u.includes('?') ? '&' : '?') + 'ow=' + Date.now()) : null;
  const media = c.video ? `<video src="${esc(bust(c.video))}" controls autoplay muted loop playsinline></video><div class="cap">Video clip · ${esc(c.src)}</div>` : c.image ? `<img src="${esc(bust(c.image))}" alt="${esc(c.name)}" referrerpolicy="no-referrer"><div class="cap">Still image · ${esc(c.src)} · <a href="#" onclick="Detail.render();return false">refresh</a></div>` : '';
  return `<div class="det">${Detail.head(C.cam, 'Camera · ' + c.src, c.name, esc(c.sub || ''), c.online === false ? [{ t: 'Offline', cls: 'warn' }] : [])}${media}
  ${Detail.kv([['Position', fmt.ll(c.lat, c.lon)], ['Direction', c.dir], ['Route', c.route]])}
  <div class="actions"><button class="btn small" onclick="flyTo(${num(c.lat)},${num(c.lon)},13)">Center</button></div><hr class="sep">${Detail.links([c.stream ? { text: 'Live stream (HLS)', url: c.stream } : null, c.link ? { text: 'Open at source', url: c.link } : null, c.image ? { text: 'Image URL', url: c.image } : null].filter(Boolean))}</div>`;
};
export const CALTRANS_DISTRICTS = { '01': [39.5, -124.5, 42.0, -122.9], '02': [39.4, -123.3, 42.0, -119.99], '03': [38.0, -122.4, 40.5, -119.9], '04': [36.9, -123.1, 38.9, -121.2], '05': [34.3, -122.2, 37.0, -119.4], '06': [34.8, -121.0, 37.7, -118.0], '07': [33.6, -119.5, 34.9, -117.6], '08': [33.4, -117.8, 35.8, -114.1], '09': [35.7, -119.0, 38.4, -116.9], '10': [36.9, -121.6, 38.6, -118.9], '11': [32.5, -117.4, 33.5, -114.4], '12': [33.35, -118.2, 33.95, -117.4] };
export const ctCache = {};
export const CAM_LOADERS = {
  async tfl(out) { const d = await Net.json('https://api.tfl.gov.uk/Place/Type/JamCam', { timeout: 40000 }); for (const p of d || []) { const ap = {}; for (const a of p.additionalProperties || []) ap[a.key] = a.value; if (p.lat == null) continue; out.push({ id: p.id, src: 'TfL JamCams', name: p.commonName, sub: ap.view, lat: p.lat, lon: p.lon, image: ap.imageUrl, video: ap.videoUrl, online: ap.available !== 'false', link: 'https://tfl.gov.uk/traffic/status/' }); } return out.length; },
  async nyc(out) { const d = await Net.json('https://webcams.nyctmc.org/api/cameras', { timeout: 40000 }); for (const c of d || []) { if (c.latitude == null) continue; out.push({ id: c.id, src: 'NYC DOT', name: c.name, sub: c.area, lat: c.latitude, lon: c.longitude, image: c.imageUrl, online: String(c.isOnline) !== 'false', link: 'https://webcams.nyctmc.org/' }); } return out.length; },
  async caltrans(out) { // one JSON per district (1–3 MB each): load only districts on screen, cache 30 min
    const errs = [];
    for (const [dist, bbox] of Object.entries(CALTRANS_DISTRICTS)) {
      if (!viewIntersects(bbox)) continue;
      let c = ctCache[dist];
      if (!c || Date.now() - c.t > 1800e3) {
        try { const d = await Net.json(`https://cwwp2.dot.ca.gov/data/d${+dist}/cctv/cctvStatusD${dist}.json`, { timeout: 60000 }); const cams = [];
          for (const row of d.data || []) { const x = row.cctv || row; const loc = x.location || {}; const lat = +loc.latitude, lon = +loc.longitude; if (!isFinite(lat) || !lat) continue; cams.push({ id: 'ct' + dist + (x.index || loc.locationName), src: 'Caltrans D' + (+dist), name: loc.locationName || 'Caltrans camera', sub: [loc.nearbyPlace, loc.county].filter(Boolean).join(', '), lat, lon, image: x.imageData?.static?.currentImageURL, stream: x.imageData?.streamingVideoURL, online: String(x.inService) !== 'false', dir: loc.direction, route: loc.route, link: 'https://cwwp2.dot.ca.gov/vm/iframemap.htm' }); }
          c = ctCache[dist] = { t: Date.now(), cams }; }
        catch (e) { errs.push('D' + (+dist) + ' ' + e.message); continue; }
      }
      out.push(...c.cams);
    }
    if (!out.length && errs.length) throw new Error(errs[0]); if (errs.length) Log.warn('Caltrans: ' + errs.join(' · ')); return out.length; },
  async singapore(out) { const d = await Net.json('https://api.data.gov.sg/v1/transport/traffic-images', { timeout: 40000 }); for (const c of d.items?.[0]?.cameras || []) { if (!c.location) continue; out.push({ id: 'sg' + c.camera_id, src: 'LTA Singapore', name: 'Camera ' + c.camera_id, sub: 'Expressway camera · ' + (c.timestamp || '').replace('T', ' ').slice(0, 16), lat: c.location.latitude, lon: c.location.longitude, image: c.image, online: true, link: 'https://data.gov.sg/' }); } return out.length; },
  async finland(out) { const d = await Net.json('https://tie.digitraffic.fi/api/weathercam/v1/stations', { timeout: 60000 }); for (const f of d.features || []) { const [lon, lat] = f.geometry?.coordinates || []; if (lat == null) continue; const p = f.properties || {}; const presets = (p.presets || []).filter(x => x.inCollection !== false); const pid = presets[0]?.id || (p.id + '01'); out.push({ id: 'fi' + p.id, src: 'Fintraffic weathercam', name: (p.name || p.id || '').replace(/_/g, ' '), sub: presets.length > 1 ? `${presets.length} views · first shown` : '', lat, lon, image: `https://weathercam.digitraffic.fi/${pid}.jpg`, online: p.collectionStatus !== 'REMOVED_PERMANENTLY', link: `https://www.digitraffic.fi/en/road-traffic/` }); } return out.length; },
  async windy(out) { const key = late.Keys.get('windy'); if (!key) return 0; const c = map.getCenter(); const d = await Net.json(`https://api.windy.com/webcams/api/v3/webcams?nearby=${c.lat.toFixed(3)},${(((c.lng + 540) % 360) - 180).toFixed(3)},250&include=images,location,player,urls&limit=50`, { headers: { 'x-windy-api-key': key } }); for (const w of d.webcams || []) { const loc = w.location || {}; if (loc.latitude == null) continue; out.push({ id: 'windy' + w.webcamId, src: 'Windy webcams', name: w.title, sub: [loc.city, loc.country].filter(Boolean).join(', '), lat: loc.latitude, lon: loc.longitude, image: w.images?.current?.preview, online: w.status === 'active', link: w.urls?.detail || `https://www.windy.com/webcams/${w.webcamId}` }); } return out.length; },
};
export const camCache = {}; // per source: { t, cams[] } so panning back does not refetch multi-MB lists
export const camItem = c => ({ lat: c.lat, lon: c.lon, r: z => z >= 13 ? 4.5 : z >= 11 ? 3 : 2, color: C.cam, fillAlpha: c.online === false ? .2 : .7, alpha: .9, kind: 'cam', obj: c, tip: c.name });
feed(lyCams, { interval: 120, viewDependent: true, minZoom: 8, fetch: async () => {
  let items = []; const errs = [], loaded = [], skipped = [];
  const wanted = CAM_SRCS.filter(s => (Layers.opt('cam_src') || []).includes(s.id));
  for (const s of wanted) {
    if (!viewIntersects(s.bbox)) { skipped.push(s.name); continue; }
    let c = camCache[s.id];
    if (!c || s.dynamic || Date.now() - c.t > 1800e3) { const out = []; try { await CAM_LOADERS[s.id](out); c = camCache[s.id] = { t: Date.now(), cams: out }; } catch (e) { errs.push(`${s.name}: ${e.message}`); continue; } }
    items = items.concat(c.cams.map(camItem)); loaded.push(`${s.name} ${c.cams.length}`);
  }
  if (late.Keys.get('windy')) { const out = []; try { await CAM_LOADERS.windy(out); items = items.concat(out.map(camItem)); loaded.push('Windy ' + out.length); } catch (e) { errs.push('Windy: ' + e.message); } }
  Points.set('cams', items); lyCams.feed.count = items.length; lyCams.desc = (loaded.length ? 'Loaded: ' + loaded.join(', ') : 'No covered region on screen') + (skipped.length ? ' · off-screen: ' + skipped.join(', ') : '');
  if (errs.length) { if (!items.length) throw new Error(errs.join(' · ')); Log.warn('Cameras: ' + errs.join(' · ')); }
} });

/* ---------- Ships: Baltic AIS (Digitraffic) + global AIS (aisstream.io key) */
Detail.renderers.ship = s => `<div class="det">${Detail.head(C.ship, 'Vessel · AIS via ' + s.src, s.name || `MMSI ${s.id}`, [s.typeName, s.callsign ? 'call ' + s.callsign : null, s.dest ? '→ ' + s.dest : null].filter(Boolean).map(esc).join(' · '))}
${Detail.kv([['MMSI', s.id], ['IMO', s.imo], ['Speed', s.sog != null ? `${s.sog} kt` : null], ['Course', s.cog != null ? `${s.cog}°` : null], ['Heading', (s.heading != null && s.heading < 360) ? `${s.heading}°` : null], ['Nav status', s.navText || s.navStat], ['Draught', s.draught ? `${s.draught} m` : null], ['Size', s.length ? `${s.length} × ${s.width} m` : null], ['Position', fmt.ll(s.lat, s.lon)], ['Fix age', fmt.ago(s.ts)]])}
<div class="actions"><button class="btn small" onclick="flyTo(${num(s.lat)},${num(s.lon)},11)">Center</button></div><hr class="sep">${Detail.links([{ text: 'VesselFinder', url: `https://www.vesselfinder.com/vessels/details/${s.id}` }, { text: 'MarineTraffic search', url: `https://www.marinetraffic.com/en/ais/index/search/all?keyword=${s.id}` }])}</div>`;
export const NAV = { 0: 'Under way (engine)', 1: 'At anchor', 2: 'Not under command', 3: 'Restricted manoeuvrability', 4: 'Constrained by draught', 5: 'Moored', 6: 'Aground', 7: 'Fishing', 8: 'Under way (sailing)', 15: 'Not defined' };
export const lyShipsFi = Layers.add({ id: 'ships_fi', group: 'Sea & sky', name: 'Ships · Baltic AIS', desc: 'Fintraffic Digitraffic · open AIS around Finland · zoom in past level 5 to see individual ships', color: C.ship, default: false,
  sub(el) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pill'; b.textContent = 'go to Baltic'; b.addEventListener('click', () => map.flyTo([60.0, 24.5], 7)); el.appendChild(b); },
  disable() { for (const [k, s] of Dyn.ships) if (s.src === 'Digitraffic') Dyn.ships.delete(k); } });
export let vesselMeta = { t: 0, m: new Map() };
feed(lyShipsFi, { interval: 60, fetch: async () => {
  if (Date.now() - vesselMeta.t > 1800e3) { try { const v = await Net.json('https://meri.digitraffic.fi/api/ais/v1/vessels', { timeout: 60000 }); const m = new Map(); for (const x of v || []) m.set(x.mmsi, x); vesselMeta = { t: Date.now(), m }; } catch (e) { Log.warn('Digitraffic vessel names: ' + e.message); } }
  const d = await Net.json('https://meri.digitraffic.fi/api/ais/v1/locations', { timeout: 60000 }); const now = Date.now(); let n = 0;
  if (!lyShipsFi.on) return; // switched off while loading: don't put the ships back
  for (const [k, s] of Dyn.ships) if (k.startsWith('fi') && now - s.ts > 3600e3) Dyn.ships.delete(k); // ships that stopped reporting
  for (const f of d.features || []) { const p = f.properties || {}; const mmsi = f.mmsi ?? p.mmsi; const [lon, lat] = f.geometry?.coordinates || []; if (lat == null || !mmsi) continue; const meta = vesselMeta.m.get(mmsi) || {}; const ts = p.timestampExternal || now;
    if (now - ts > 3600e3) continue; Dyn.ships.set('fi' + mmsi, { id: mmsi, lat, lon, sog: p.sog, cog: p.cog, heading: p.heading, navStat: p.navStat, navText: NAV[p.navStat], name: meta.name, callsign: meta.callSign, imo: meta.imo, dest: meta.destination, typeName: meta.shipType != null ? 'AIS type ' + meta.shipType : null, draught: meta.draught != null ? meta.draught / 10 : null, ts, src: 'Digitraffic' }); n++; }
  lyShipsFi.feed.count = n; requestDraw();
} });
export const lyShipsWs = Layers.add({ id: 'ships_ws', group: 'Sea & sky', name: 'Ships · global AIS stream', desc: 'aisstream.io WebSocket · needs a free key (Setup tab)', color: '#3fb8a2', default: false });
export const AisWs = { ws: null, timer: null,
  connect() { const key = late.Keys.get('aisstream'); if (!key) { this.close(); lyShipsWs.feed.status = 'error'; lyShipsWs.feed.err = 'no aisstream.io key'; UI.refreshLayer(lyShipsWs); return; }
    this.close(); lyShipsWs.feed.status = 'loading'; UI.refreshLayer(lyShipsWs);
    try { this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream'); } catch (e) { lyShipsWs.feed.status = 'error'; lyShipsWs.feed.err = e.message; UI.refreshLayer(lyShipsWs); return; }
    this.ws.onopen = () => { this.subscribe(); lyShipsWs.feed.status = 'ok'; lyShipsWs.feed.lastOk = Date.now(); UI.refreshLayer(lyShipsWs); Log.info('aisstream.io connected'); };
    this.ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.error) { lyShipsWs.feed.status = 'error'; lyShipsWs.feed.err = m.error; UI.refreshLayer(lyShipsWs); return; } if (m.MessageType !== 'PositionReport') return; const md = m.MetaData || {}, pr = m.Message?.PositionReport || {}; if (md.latitude == null) return;
      if (!Dyn.ships.has('ws' + md.MMSI)) lyShipsWs.feed.count++; if (!this.drawT) this.drawT = setTimeout(() => { this.drawT = null; requestDraw(); }, 1000); // O(1) per message; redraw at most once a second
      Dyn.ships.set('ws' + md.MMSI, { id: md.MMSI, lat: md.latitude, lon: md.longitude, sog: pr.Sog, cog: pr.Cog, heading: pr.TrueHeading, navStat: pr.NavigationalStatus, navText: NAV[pr.NavigationalStatus], name: (md.ShipName || '').trim(), ts: Date.now(), src: 'aisstream.io' }); };
    this.ws.onclose = () => { if (lyShipsWs.on) { lyShipsWs.feed.status = 'error'; lyShipsWs.feed.err = 'disconnected — retrying'; UI.refreshLayer(lyShipsWs); this.timer = setTimeout(() => this.connect(), 15000); } };
    this.ws.onerror = () => { };
  },
  subscribe() { if (!this.ws || this.ws.readyState !== 1) return; const b = map.getBounds(); const s = Math.max(-90, b.getSouth()), n = Math.min(90, b.getNorth()); let w = b.getWest(), e = b.getEast(); if (e - w >= 360) { w = -180; e = 180; } else { w = ((w + 540) % 360) - 180; e = ((e + 540) % 360) - 180; if (e < w) { w = -180; e = 180; } }
    this.ws.send(JSON.stringify({ APIKey: late.Keys.get('aisstream'), BoundingBoxes: [[[s, w], [n, e]]], FilterMessageTypes: ['PositionReport'] })); },
  close() { clearTimeout(this.timer); if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) { } this.ws = null; } },
};
lyShipsWs.enable = () => AisWs.connect(); lyShipsWs.disable = () => { AisWs.close(); for (const k of [...Dyn.ships.keys()]) if (k.startsWith('ws')) Dyn.ships.delete(k); lyShipsWs.feed.count = 0; };
feed(lyShipsWs, { interval: 30, fetch: async () => { if (!AisWs.ws || AisWs.ws.readyState > 1) AisWs.connect(); const now = Date.now(); for (const [k, s] of Dyn.ships) if (k.startsWith('ws') && now - s.ts > 900e3) Dyn.ships.delete(k); lyShipsWs.feed.count = [...Dyn.ships.keys()].filter(k => k.startsWith('ws')).length; if (!late.Keys.get('aisstream')) throw new Error('no aisstream.io key (Setup tab)'); } });
map.on('moveend', debounce(() => AisWs.subscribe(), 1200));

/* ---------- Weather balloons / radiosondes (SondeHub) */
export const lyBalloons = Layers.add({ id: 'balloons', group: 'Sea & sky', name: 'Weather balloons', desc: 'SondeHub · community-uploaded, unverified: asks first', color: C.bal, shape: 'round', default: false, disable() { Dyn.balloons.clear(); },
  guard: { title: 'Weather balloons: read this first', accept: 'I understand, show balloons', body: [{"h": "Where balloon data comes from", "p": "A weather balloon carries a small radio transmitter, a radiosonde, that sends out its position every second or so. Hobbyists with cheap radio receivers pick those signals up and upload them to SondeHub, a free, open database. Open Overwatch asks SondeHub for the balloons near the middle of your map and draws whatever comes back."}, {"h": "Why anyone can add to it", "p": "SondeHub is open on purpose: that is how a worldwide network of volunteers works. Its uploads are open to volunteers and are not individually checked, so the list is part genuine balloons and part whatever people chose to submit. Nobody has to own a balloon, or even a radio, to add an entry that looks like one."}, {"h": "Why that could be a threat", "p": "A made-up balloon can put false information on the map, in the wrong place or with an official-sounding name. Its text fields (name, type, notes) could also hold web code instead of words: if a site displayed that carelessly, the code would run in your browser and could change the page or try to take your information (a script, or “injection”, attack). A balloon's details could carry a tempting link or instructions. And a reported landing spot could lure someone to a place that is private or unsafe."}, {"h": "What Open Overwatch does about it", "p": "Every balloon field is shown as plain text and never run as code; numbers are checked to be numbers before they go anywhere near a button; and the only link offered goes to SondeHub itself. This is covered by automated tests. It lowers the risk; it does not make the data true."}, {"h": "What you should do", "p": "Treat every balloon as unverified. Don't click links or follow instructions that you find in balloon details anywhere else. Never go looking for a landed balloon because of this map, and don't use it for safety, navigation or recovery. Switch the layer off when you're done."}, {"h": "What gets sent", "p": "Turning this on sends the centre of your map view to SondeHub (api.v2.sondehub.org) to ask which balloons are nearby."}] } });
Detail.renderers.balloon = b => `<div class="det">${Detail.head(C.bal, 'Radiosonde · SondeHub', b.id, [b.type, b.subtype].filter(Boolean).map(esc).join(' · '))}
${Detail.kv([['Altitude', `${fmt.n(b.alt)} m`], ['Climb', b.vel_v != null ? `${b.vel_v > 0 ? '▲' : '▼'} ${Math.abs(b.vel_v).toFixed(1)} m/s` : null], ['Ground speed', b.vel_h != null ? `${fmt.n(b.vel_h * 3.6)} km/h` : null], ['Heading', b.heading != null ? `${fmt.n(b.heading)}°` : null], ['Temp', b.temp != null ? `${b.temp} °C` : null], ['Humidity', b.humidity != null ? `${b.humidity} %` : null], ['Pressure', b.pressure != null ? `${b.pressure} hPa` : null], ['Frequency', b.frequency ? `${b.frequency} MHz` : null], ['Heard by', b.uploader], ['Last frame', b.datetime ? fmt.date(b.datetime) : null], ['Position', fmt.ll(b.lat, b.lon)]])}
<div class="actions"><button class="btn small" onclick="flyTo(${num(b.lat)},${num(b.lon)},9)">Center</button></div><hr class="sep">${Detail.links([{ text: 'Track on SondeHub', url: `https://sondehub.org/${encodeURIComponent(b.id)}` }])}</div>`;
feed(lyBalloons, { interval: 120, viewDependent: true, fetch: async () => {
  const c = map.getCenter(); const d = await Net.json(`https://api.v2.sondehub.org/sondes?lat=${c.lat.toFixed(2)}&lon=${(((c.lng + 540) % 360) - 180).toFixed(2)}&distance=3000000&last=10800`, { timeout: 40000 }); if (!lyBalloons.on) return; Dyn.balloons.clear(); let n = 0; // off while loading: stay off
  for (const [serial, t] of Object.entries(d || {})) { if (!t || t.lat == null) continue; Dyn.balloons.set(serial, { id: serial, lat: t.lat, lon: t.lon, alt: t.alt, vel_h: t.vel_h, vel_v: t.vel_v, heading: t.heading, temp: t.temp, humidity: t.humidity, pressure: t.pressure, frequency: t.frequency, type: t.type, subtype: t.subtype, uploader: t.uploader_callsign, datetime: t.datetime, ts: Date.parse(t.datetime) || Date.now() }); n++; }
  lyBalloons.feed.count = n; requestDraw();
} });

/* ---------- Active fires (NASA FIRMS, key) */
export const lyFires = Layers.add({ id: 'fires', group: 'Ground', name: 'Active fires (satellite)', desc: 'NASA FIRMS VIIRS · needs a free MAP_KEY (Setup tab) · zoom in', color: '#ff6a2a', shape: 'round', default: false, points: 'fires' });
Points.define('fires', 'fires');
Detail.renderers.fire = f => `<div class="det">${Detail.head('#ff6a2a', 'Thermal anomaly · NASA FIRMS', `${f.satellite || 'VIIRS'} detection`, esc(`${f.acq_date} ${String(f.acq_time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}Z`), [{ t: `${f.confidence} confidence`, cls: f.confidence === 'h' || f.confidence === 'high' ? 'warn' : '' }, { t: f.daynight === 'D' ? 'Day' : 'Night' }])}
${Detail.kv([['Radiative power', f.frp ? `${f.frp} MW` : null], ['Brightness (I4)', f.bright_ti4 ? `${f.bright_ti4} K` : null], ['Position', fmt.ll(+f.latitude, +f.longitude)]])}<hr class="sep">${Detail.links([{ text: 'FIRMS fire map', url: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${f.longitude},${f.latitude},9z` }])}</div>`;
feed(lyFires, { interval: 900, viewDependent: true, minZoom: 5, fetch: async () => {
  const key = late.Keys.get('firms'); if (!key) throw new Error('no FIRMS MAP_KEY (Setup tab)'); const b = map.getBounds(); const w = Math.max(-180, b.getWest()), e = Math.min(180, b.getEast());
  const txt = await Net.text(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/VIIRS_SNPP_NRT/${w.toFixed(2)},${b.getSouth().toFixed(2)},${e.toFixed(2)},${b.getNorth().toFixed(2)}/1`, { timeout: 60000 });
  if (/invalid|error/i.test(txt.slice(0, 200)) && !txt.includes('latitude')) throw new Error(txt.slice(0, 80)); const lines = txt.trim().split('\n'); const head = lines.shift().split(','); const items = [];
  for (const line of lines) { const cols = line.split(','); const f = {}; head.forEach((h, i) => f[h] = cols[i]); const lat = +f.latitude, lon = +f.longitude; if (!isFinite(lat)) continue; items.push({ lat, lon, r: Math.min(9, 2.5 + Math.sqrt(+f.frp || 1)), color: '#ff6a2a', fillAlpha: .6, kind: 'fire', obj: f, tip: `${f.frp || '?'} MW · ${f.acq_date}` }); }
  Points.set('fires', items); lyFires.feed.count = items.length;
} });

/* ---------- OSM area scan results (from the probe) */
export const lyScan = Layers.add({ id: 'osm_scan', group: 'Infrastructure', name: 'Area scan results', desc: 'Military areas, airfields, nuclear sites, harbours from OpenStreetMap · run from a map probe', color: C.infra, default: true, points: 'scan' });
Points.define('scan', 'osm_scan'); lyScan.enable = () => { if (lyScan.last) Points.set('scan', lyScan.last); }; // turning the layer off clears the points; bring the last scan back
Detail.renderers.osm = o => `<div class="det">${Detail.head(C.infra, 'OpenStreetMap · ' + o.kind, o.name, esc(o.sub || ''))}${Detail.kv(Object.entries(o.tags).filter(([k]) => !/^(name|source|created_by)/.test(k)).slice(0, 24).map(([k, v]) => [k, v]))}
<div class="actions"><button class="btn small" onclick="flyTo(${num(o.lat)},${num(o.lon)},13)">Center</button></div><hr class="sep">${Detail.links([{ text: `OSM ${o.type} ${o.id}`, url: `https://www.openstreetmap.org/${o.type}/${o.id}` }])}</div>`;
export async function scanArea(lat, lon, radius = 30000) {
  const around = `(around:${radius},${lat},${lon})`;
  const q = `[out:json][timeout:30];(nwr["landuse"="military"]${around};nwr["military"]${around};nwr["aeroway"="aerodrome"]${around};nwr["generator:source"="nuclear"]${around};nwr["plant:source"="nuclear"]${around};nwr["harbour"="yes"]${around};nwr["seamark:type"="harbour"]${around};nwr["man_made"="radar_station"]${around};nwr["telecom"="data_center"]${around};);out center tags 300;`;
  toast('Scanning OpenStreetMap…'); const d = await Net.json('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q), { timeout: 60000 }); const items = []; const seen = new Set();
  for (const el of d.elements || []) { const t = el.tags || {}; const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon; if (la == null) continue; const key = `${la.toFixed(4)},${lo.toFixed(4)}`; if (seen.has(key)) continue; seen.add(key);
    const kind = t.aeroway ? (t['aerodrome:type'] === 'military' || t.military ? 'Military airfield' : 'Airfield') : (t.landuse === 'military' || t.military) ? 'Military · ' + (t.military || 'area') : (t['generator:source'] === 'nuclear' || t['plant:source'] === 'nuclear') ? 'Nuclear plant' : t.man_made === 'radar_station' ? 'Radar station' : t.telecom ? 'Data centre' : 'Harbour';
    const o = { id: el.id, type: el.type, kind, name: t.name || t['name:en'] || t.icao || t.iata || kind, sub: [t.operator, t.icao, t.iata].filter(Boolean).join(' · '), lat: la, lon: lo, tags: t };
    const col = /Military/.test(kind) ? C.mil : /Nuclear|Radar/.test(kind) ? C.emg : C.infra;
    items.push({ lat: la, lon: lo, r: 5, color: col, shape: /Military/.test(kind) ? 'tri' : 'circle', fillAlpha: .3, kind: 'osm', obj: o, tip: `${o.kind}: ${o.name}`, label: o.name, labelZoom: 10 }); }
  lyScan.last = items; if (!lyScan.on) Layers.set('osm_scan', true); Points.set('scan', items); lyScan.feed = lyScan.feed || { status: 'ok', count: 0, lastOk: 0, err: '', nextAt: 1e15, running: false, interval: 1e9, errorInterval: 1e9, layer: lyScan, fetch: async () => { } }; lyScan.feed.count = items.length; lyScan.feed.status = 'ok'; lyScan.feed.lastOk = Date.now(); UI.refreshLayer(lyScan);
  Log.info(`OSM scan: ${items.length} features within ${radius / 1000} km of ${fmt.ll(lat, lon)}`); toast(`${items.length} features found`); return items.length;
}

Object.assign(late, { cableHit });
