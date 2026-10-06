// Satellites: CelesTrak groups, SGP4 in a worker, ground tracks, passes.
import { num, idArg } from '../core/format.js';
import { createTleSource } from '../core/tle.js';
import { $, C, deg, fmt, haversine, late, Log, Net, rad, Store } from './util.js';
import { sunElevation, vecRenderer } from './mapview.js';
import { Dyn, Layers, Sel, UI, feed, requestDraw } from './engine.js';
import { Detail, Tracks } from './detail.js';

/* ============================================================ SATELLITES (CelesTrak GP data + SGP4 in a worker) */
export const SAT_WORKER_SRC = `
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');
let recs = [];
onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    recs = []; const ids = [];
    for (const t of m.tles) { try { const sr = satellite.twoline2satrec(t.l1, t.l2); if (sr && !sr.error) { recs.push(sr); ids.push(t.id); } } catch (err) {} }
    postMessage({ type: 'loaded', ids });
  } else if (m.type === 'prop') {
    const now = new Date(m.t), gmst = satellite.gstime(now), out = new Float32Array(recs.length * 4);
    for (let i = 0; i < recs.length; i++) {
      const pv = satellite.propagate(recs[i], now); const p = pv && pv.position;
      if (!p || isNaN(p.x)) { out[i * 4] = NaN; continue; }
      const g = satellite.eciToGeodetic(p, gmst); const v = pv.velocity;
      out[i * 4] = g.latitude * 180 / Math.PI; out[i * 4 + 1] = g.longitude * 180 / Math.PI; out[i * 4 + 2] = g.height; out[i * 4 + 3] = v ? Math.hypot(v.x, v.y, v.z) : 0;
    }
    postMessage({ type: 'pos', t: m.t, pos: out }, [out.buffer]);
  }
};`;
export const Sats = {
  GROUPS: [
    { id: 'stations', name: 'Stations', title: 'ISS, Tiangong, visiting vehicles' }, { id: 'visual', name: 'Brightest' }, { id: 'last-30-days', name: 'Recent launches' },
    { id: 'military', name: 'Military' }, { id: 'radar', name: 'Radar' }, { id: 'gps-ops', name: 'GPS' }, { id: 'glo-ops', name: 'GLONASS' }, { id: 'galileo', name: 'Galileo' }, { id: 'beidou', name: 'BeiDou' },
    { id: 'weather', name: 'Weather', title: 'Weather satellites, NOAA POES/JPSS included (CelesTrak retired its separate NOAA group)' }, { id: 'goes', name: 'GOES' }, { id: 'resource', name: 'Earth obs' }, { id: 'science', name: 'Science' },
    { id: 'iridium-NEXT', name: 'Iridium' }, { id: 'geo', name: 'GEO belt', heavy: true }, { id: 'oneweb', name: 'OneWeb', heavy: true }, { id: 'starlink', name: 'Starlink', heavy: true, title: 'Thousands of objects, drawn dimmed. CelesTrak permits one download per 2 h — cached.' },
    { id: 'cosmos-2251-debris', name: 'Cosmos-2251 debris', heavy: true }, { id: 'iridium-33-debris', name: 'Iridium-33 debris', heavy: true },
  ],
  STARS: ['ISS (ZARYA)', 'CSS (TIANHE)', 'HST'],
  worker: null, ready: false, byId: new Map(), loading: false, propTimer: null, propBusy: false, lastPropMs: 0, adhoc: [],
  groupsOn() { return (Layers.opt('sat_groups') || []).filter(g => this.GROUPS.some(x => x.id === g)); }, // drops retired ids (e.g. 'noaa') still in saved settings
  // where TLEs come from, how long they are kept and what happens when CelesTrak is down: src/core/tle.js
  tles: createTleSource({
    fetchText: (url, { timeout }) => Net.text(url, /celestrak\.org/.test(url) ? { throttle: 'celestrak', gap: 2000, timeout } : { timeout }),
    cache: { get: k => Store.get(k, null), set: (k, v) => Store.set(k, v) || (Log.warn(`Could not cache ${k} (browser storage full). CelesTrak allows one download per group every 2 h, so avoid reloading the page repeatedly with this group on.`), false) },
    onSite: location.hostname === 'destinjones.github.io',
  }),
  async loadGroup(g) {
    const res = await this.tles.load(g);
    if (res.source === 'stale cache') Log.warn(`${g}: CelesTrak and the site copy failed; using TLEs cached ${fmt.ago(Date.now() - res.ageMs)} ago`);
    return res.txt;
  },
  parse(txt, g) {
    const lines = txt.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.length), out = [];
    for (let i = 1; i < lines.length - 1; i++) {
      const l1 = lines[i], l2 = lines[i + 1]; if (!(l1.startsWith('1 ') && l2.startsWith('2 '))) continue;
      const id = parseInt(l1.substr(2, 5), 10), mm = parseFloat(l2.substr(52, 11));
      out.push({ id, name: lines[i - 1].trim(), l1, l2, g, inc: parseFloat(l2.substr(8, 8)), period: mm ? 1440 / mm : null, intl: l1.substr(9, 8).trim(), epoch: l1.substr(18, 14).trim(), ecc: parseFloat('0.' + l2.substr(26, 7)) }); i++;
    }
    return out;
  },
  reload() { // a call made while a load runs is not dropped: it queues one more pass (which sees the new groups/searches), and every caller awaits the end
    if (this.loadP) { this.again = true; return this.loadP; }
    this.loadP = (async () => { do { this.again = false; await this.reloadOnce(); } while (this.again); })().finally(() => { this.loadP = null; });
    return this.loadP;
  },
  async reloadOnce() {
    this.loading = true; const ly = lySats; ly.feed.status = 'loading'; UI.refreshLayer(ly);
    try {
      const objs = new Map(); const groups = this.groupsOn(); const failed = [], quiet = [];
      for (const g of groups) {
        const gd = this.GROUPS.find(x => x.id === g) || {};
        try { const txt = await this.loadGroup(g); for (const t of this.parse(txt, g)) { const ex = objs.get(t.id); if (ex) { ex.groups.push(g); if (!gd.heavy) ex.dim = false; continue; } objs.set(t.id, { ...t, groups: [g], dim: !!gd.heavy, star: this.STARS.includes(t.name), lat: null, lon: null }); } }
        catch (e) { (e.calm ? quiet : failed).push(`${gd.name || g}: ${e.message}`); }
      }
      for (const t of this.adhoc) if (!objs.has(t.id)) objs.set(t.id, { ...t, groups: ['search'], dim: false, star: true, lat: null, lon: null });
      for (const [id, o] of objs) { const old = this.byId.get(id); if (old && old.lat != null) Object.assign(o, { lat: old.lat, lon: old.lon, alt: old.alt, vel: old.vel }); } // no blink while the worker re-propagates
      this.byId = objs; Dyn.sats = [...objs.values()]; this.startWorker(); this.worker.postMessage({ type: 'load', tles: Dyn.sats.map(t => ({ id: t.id, l1: t.l1, l2: t.l2 })) });
      if (Sel.kind === 'sat' && objs.has(Sel.id)) Sel.obj = objs.get(Sel.id); // rebind the open detail panel to the new object, or it freezes
      ly.feed.count = Dyn.sats.length; ly.feed.status = failed.length ? 'error' : 'ok'; ly.feed.err = failed.join(' · '); ly.feed.lastOk = Date.now();
      if (quiet.length) Log.info('Satellites · ' + quiet.join(' · '));
      if (failed.length) Log.error('CelesTrak: ' + failed.join(' · ')); else Log.info(`Satellites: ${Dyn.sats.length} objects from ${groups.length - quiet.length} CelesTrak group${groups.length - quiet.length === 1 ? '' : 's'} (TLEs cached 2 h)`);
    } catch (e) { ly.feed.status = 'error'; ly.feed.err = e.message; Log.error('Satellites: ' + e.message); }
    finally { this.loading = false; UI.refreshLayer(ly); }
  },
  startWorker() {
    if (this.worker) return;
    try {
      const url = URL.createObjectURL(new Blob([SAT_WORKER_SRC], { type: 'text/javascript' })); this.worker = new Worker(url);
      this.worker.onmessage = e => this.onMessage(e.data);
      this.worker.onerror = e => { Log.error('Satellite worker failed (' + (e.message || 'error') + ') — propagating on the main thread'); this.worker.terminate(); this.worker = { postMessage: m => this.mainThread(m), terminate() { } }; this.mainThread({ type: 'load', tles: Dyn.sats.map(t => ({ id: t.id, l1: t.l1, l2: t.l2 })) }); };
    } catch (e) { this.worker = { postMessage: m => this.mainThread(m), terminate() { } }; }
    if (!this.propTimer) this.propTimer = setInterval(() => this.prop(), 1000);
  },
  _recs: null,
  mainThread(m) { // fallback when workers are unavailable
    if (m.type === 'load') { this._recs = []; const ids = []; for (const t of m.tles) { try { const sr = satellite.twoline2satrec(t.l1, t.l2); if (sr && !sr.error) { this._recs.push(sr); ids.push(t.id); } } catch (e) { } } this.onMessage({ type: 'loaded', ids }); }
    else if (m.type === 'prop' && this._recs) { const now = new Date(m.t), gmst = satellite.gstime(now), out = new Float32Array(this._recs.length * 4); for (let i = 0; i < this._recs.length; i++) { const pv = satellite.propagate(this._recs[i], now); const p = pv && pv.position; if (!p || isNaN(p.x)) { out[i * 4] = NaN; continue; } const g = satellite.eciToGeodetic(p, gmst); out[i * 4] = deg(g.latitude); out[i * 4 + 1] = deg(g.longitude); out[i * 4 + 2] = g.height; out[i * 4 + 3] = pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) : 0; } this.onMessage({ type: 'pos', t: m.t, pos: out }); }
  },
  onMessage(m) {
    if (m.type === 'loaded') { this.ids = m.ids; this.ready = true; this.prop(true); }
    else if (m.type === 'pos') {
      const ids = this.ids || []; let n = 0;
      for (let i = 0; i < ids.length; i++) { const o = this.byId.get(ids[i]); if (!o) continue; const la = m.pos[i * 4]; if (isNaN(la)) { o.lat = null; continue; } o.lat = la; o.lon = m.pos[i * 4 + 1]; o.alt = m.pos[i * 4 + 2]; o.vel = m.pos[i * 4 + 3]; n++; }
      this.propBusy = false; this.lastPropMs = Date.now() - m.t; $('#chipSat b').textContent = fmt.n(n); requestDraw();
      if (Sel.kind === 'sat' && Layers.opt('sat_tracks') && Date.now() - (this.trackAt || 0) > 30000) this.drawTrack(Sel.obj);
    }
  },
  prop(force) {
    if (!this.ready || !lySats.on || (document.hidden && !force)) return;
    const big = Dyn.sats.length > 2500; if (!force && big && Date.now() - (this.lastPropAt || 0) < 3000) return;
    if (this.propBusy && !force) return; this.propBusy = true; this.lastPropAt = Date.now(); this.worker.postMessage({ type: 'prop', t: Date.now() });
  },
  drawTrack(o) {
    if (!o || !o.l1) return; this.trackAt = Date.now();
    if (this.trackLayer) Tracks.group.removeLayer(this.trackLayer); const tl = this.trackLayer = L.layerGroup().addTo(Tracks.group); // own sub-group: the 30 s refresh must not wipe the Locate marker or an aircraft trail
    let sr; try { sr = satellite.twoline2satrec(o.l1, o.l2); } catch (e) { return; }
    const period = Math.max(10, Math.min(1500, o.period || 95)), span = Math.min(period * 60 * 1000 * 1.05, 3 * 3600e3), step = Math.max(15000, span / 240);
    const segs = [[]]; let prevLon = null;
    for (let t = Date.now() - span * 0.35; t <= Date.now() + span * 0.65; t += step) {
      const d = new Date(t); const pv = satellite.propagate(sr, d); if (!pv || !pv.position || isNaN(pv.position.x)) continue;
      const g = satellite.eciToGeodetic(pv.position, satellite.gstime(d)); const la = deg(g.latitude), lo = deg(g.longitude);
      if (prevLon != null && Math.abs(lo - prevLon) > 180) segs.push([]); segs[segs.length - 1].push([la, lo]); prevLon = lo;
    }
    for (const s of segs) if (s.length > 1) L.polyline(s, { color: C.sat, weight: 1.2, opacity: .75, dashArray: '2 4', renderer: vecRenderer }).addTo(tl);
    if (o.alt && o.lat != null) { const R = 6371, r = R * Math.acos(R / (R + o.alt)) * 1000; if (isFinite(r) && r > 1000) L.circle([o.lat, o.lon], { radius: r, color: C.sat, weight: 1, opacity: .5, fillOpacity: .05, renderer: vecRenderer }).addTo(tl); }
  },
  async searchByName(q) {
    const txt = await Net.text(`https://celestrak.org/NORAD/elements/gp.php?NAME=${encodeURIComponent(q)}&FORMAT=TLE`, { throttle: 'celestrak', gap: 2000, timeout: 30000 });
    const found = this.parse(txt, 'search'); if (!found.length) return null;
    for (const t of found.slice(0, 25)) if (!this.adhoc.find(x => x.id === t.id)) this.adhoc.push(t);
    if (!lySats.on) Layers.set('sats', true); await this.reload(); return found[0];
  },
  iss() { return this.byId.get(25544) || Dyn.sats.find(s => /^ISS \(ZARYA\)/.test(s.name)) || null; },
  // elevation of a satellite above an observer's horizon, from sub-point + altitude (good to a degree or so)
  elevation(obsLat, obsLon, s) { if (s.lat == null || !s.alt) return -90; const R = 6371; const g = haversine(obsLat, obsLon, s.lat, s.lon) / 1000 / R; const el = Math.atan2(Math.cos(g) - R / (R + s.alt), Math.sin(g)); return deg(el); },
  above(obsLat, obsLon, minEl = 25) { return Dyn.sats.filter(s => s.lat != null).map(s => ({ s, el: this.elevation(obsLat, obsLon, s) })).filter(x => x.el >= minEl).sort((a, b) => b.el - a.el); },
  // next pass of a satellite over an observer: first time in the next 24 h it climbs above minEl (returns {start, max, end} ms)
  nextPass(o, obsLat, obsLon, minEl = 10) {
    if (!o || !o.l1) return null; let sr; try { sr = satellite.twoline2satrec(o.l1, o.l2); } catch (e) { return null; }
    const obs = { latitude: rad(obsLat), longitude: rad(obsLon), height: 0.1 }; const step = 30000; let start = null, max = -90, maxT = 0;
    for (let t = Date.now(); t < Date.now() + 24 * 3600e3; t += step) {
      const d = new Date(t); const pv = satellite.propagate(sr, d); if (!pv || !pv.position || isNaN(pv.position.x)) return null;
      const gmst = satellite.gstime(d); const look = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst)); const el = deg(look.elevation);
      if (el >= minEl) { if (start == null) { start = t; if (t === Date.now()) start = t; } if (el > max) { max = el; maxT = t; } }
      else if (start != null) return { start, max, maxT, end: t, now: start <= Date.now() + step };
    }
    return start != null ? { start, max, maxT, end: null, now: true } : null;
  },
};
Detail.renderers.sat = o => {
  const flags = o.groups.map(g => ({ t: (Sats.GROUPS.find(x => x.id === g) || { name: g }).name }));
  const rows = [
    ['NORAD ID', o.id], ['Intl. designator', o.intl], ['Altitude', o.alt != null ? `${fmt.n(o.alt)} km` : null], ['Speed', o.vel ? `${o.vel.toFixed(2)} km/s` : null],
    ['Inclination', isFinite(o.inc) ? `${o.inc.toFixed(2)}°` : null], ['Period', o.period ? `${o.period.toFixed(1)} min` : null], ['Eccentricity', isFinite(o.ecc) ? o.ecc.toFixed(4) : null],
    ['Sub-point', o.lat != null ? fmt.ll(o.lat, o.lon) : 'propagating…'], ['Footprint', o.alt ? `${fmt.n(2 * 6371 * Math.acos(6371 / (6371 + o.alt)))} km wide` : null],
    ['TLE epoch', o.epoch ? `20${o.epoch.slice(0, 2)} day ${(+o.epoch.slice(2)).toFixed(2)}` : null], ['Sunlit sub-point', o.lat != null ? (sunElevation(o.lat, o.lon, Date.now()) > 0 ? 'day side' : 'night side') : null],
  ];
  const links = [
    { text: 'CelesTrak SATCAT entry', url: `https://celestrak.org/satcat/table-satcat.php?CATNR=${o.id}` },
    { text: 'N2YO live tracking & passes', url: `https://www.n2yo.com/satellite/?s=${o.id}` },
    { text: 'Heavens-Above', url: `https://www.heavens-above.com/satinfo.aspx?satid=${o.id}` },
  ];
  return `<div class="det">${Detail.head(C.sat, 'Satellite · CelesTrak GP data', o.name, '', flags)}${Detail.kv(rows)}
  <div class="actions"><button class="btn small" onclick="flyTo(${num(o.lat)},${num(o.lon)},3)">Center</button><button class="btn small" onclick="Sats.drawTrack(Sats.byId.get(${num(o.id)}))">Ground track</button><button class="btn small" onclick="Tracks.clear()">Clear track</button></div>
  <hr class="sep">${Detail.links(links)}</div>`;
};
export const lySats = Layers.add({
  id: 'sats', group: 'Space', name: 'Satellites', desc: 'CelesTrak orbital elements, propagated live with SGP4', color: C.sat, default: true,
  sub(el) {
    UI.pills(el, Sats.GROUPS, id => Sats.groupsOn().includes(id), (id, on) => { const g = Sats.groupsOn().filter(x => x !== id); if (on) g.push(id); Layers.setOpt('sat_groups', g); if (lySats.on) Sats.reload(); });
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pill' + (Layers.opt('sat_tracks') ? ' on' : ''); b.textContent = 'auto ground track'; b.title = 'Draw the ground track and footprint of the selected satellite';
    b.addEventListener('click', () => { Layers.setOpt('sat_tracks', !Layers.opt('sat_tracks')); b.classList.toggle('on'); }); el.appendChild(b);
  },
  disable() { Dyn.sats = []; Sats.byId = new Map(); Sats.ready = false; if (Sats.worker) { Sats.worker.terminate(); Sats.worker = null; } $('#chipSat b').textContent = '—'; Tracks.clear(); },
});
feed(lySats, { interval: 7200, errorInterval: 1200, fetch: async () => {
  if (!Sats.ready || Dyn.sats.length === 0) await Sats.reload(); else { const stale = Sats.groupsOn().some(g => { const c = Store.get('tle.' + g, null); return !c || Date.now() - c.t > 2 * 3600e3; }); if (stale) await Sats.reload(); }
  if (lySats.feed.status === 'error') throw new Error(lySats.feed.err || 'CelesTrak download failed'); // runFeed then shows the error and retries in 20 min
} });

Object.assign(late, { Sats });
