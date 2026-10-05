// Aircraft: ADS-B sources swept tile by tile, OpenSky, emergencies, photos.
import { num, idArg } from '../core/format.js';
import { $, C, Log, Net, Store, debounce, destination, esc, fmt, haversine, rad, regionOf, toast } from './util.js';
import { map, vecRenderer } from './mapview.js';
import { Dyn, Layers, Sel, UI, feed, requestDraw } from './engine.js';
import { Detail, Tracks } from './detail.js';

/* ============================================================ AIRCRAFT (ADS-B) */
export const AIR_SRC = { 'adsb.lol': 'https://api.adsb.lol', 'adsb.fi': 'https://opendata.adsb.fi/api', 'airplanes.live': 'https://api.airplanes.live' };
export const AIR_PATHS = { // the aggregators share the ADS-B Exchange v2 shape but differ in a few paths
  'adsb.lol': { point: (la, lo, r) => `/v2/point/${la}/${lo}/${r}`, reg: r => `/v2/registration/${r}`, squawk: s => `/v2/squawk/${s}` },
  'adsb.fi': { point: (la, lo, r) => `/v2/lat/${la}/lon/${lo}/dist/${r}`, reg: r => `/v2/registration/${r}`, squawk: s => `/v2/sqk/${s}` },
  'airplanes.live': { point: (la, lo, r) => `/v2/point/${la}/${lo}/${r}`, reg: r => `/v2/reg/${r}`, squawk: s => `/v2/sqk/${s}`, optIn: true }, // answers 403 unless you have written permission from them
};
export const Air = {
  following: null, cooldown: {}, history: [], gap: { 'adsb.lol': 2500, 'adsb.fi': 2500, 'airplanes.live': 2500 }, okStreak: {},
  // adaptive pacing: a 429 slows that source down for a while, a long run of successes speeds it back up
  paced(src) { return this.gap[src] || 2500; },
  onOk(src) { this.okStreak[src] = (this.okStreak[src] || 0) + 1; if (this.okStreak[src] >= 25) { this.okStreak[src] = 0; this.gap[src] = Math.max(2000, Math.round(this.paced(src) * 0.85)); } },
  on429(src) { this.okStreak[src] = 0; this.gap[src] = Math.min(6000, Math.round(this.paced(src) * 1.5)); this.cooldown[src] = Date.now() + 60000; },
  order() { const pref = AIR_SRC[Layers.opt('air_src')] ? Layers.opt('air_src') : 'adsb.lol'; return [pref, ...Object.keys(AIR_SRC).filter(s => s !== pref && !AIR_PATHS[s].optIn)]; },
  path(src, kind, args) { const P = AIR_PATHS[src]; if (kind === 'point') return P.point(...args); if (kind === 'reg') return P.reg(args[0]); if (kind === 'squawk') return P.squawk(args[0]); if (kind === 'mil') return '/v2/mil'; return `/v2/${kind}/${args[0]}`; },
  async getFrom(src, kind, ...args) {
    const now = Date.now(); if ((this.cooldown[src] || 0) > now) throw new Error(`cooling down after rate limit (${Math.ceil((this.cooldown[src] - now) / 1000)} s)`);
    try { const d = await Net.json(AIR_SRC[src] + this.path(src, kind, args), { throttle: src, gap: this.paced(src), timeout: 25000 }); d._src = src; this.onOk(src); return d; }
    catch (e) { if (/HTTP 429/.test(e.message)) { this.on429(src); throw new Error(e.message + ` — pausing this source 60 s, then 1 request per ${(this.paced(src) / 1000).toFixed(1)} s`); } throw e; }
  },
  async get(kind, ...args) { // kind: 'mil' | 'squawk' | 'hex' | 'callsign' | 'reg' | 'point'; tries the sources in order
    const errs = []; const now = Date.now();
    for (const src of this.order()) {
      if ((this.cooldown[src] || 0) > now) { errs.push(`${src}: cooling down after rate limit (${Math.ceil((this.cooldown[src] - now) / 1000)} s)`); continue; }
      const P = AIR_PATHS[src]; let path;
      if (kind === 'point') path = P.point(...args); else if (kind === 'reg') path = P.reg(args[0]); else if (kind === 'squawk') path = P.squawk(args[0]); else if (kind === 'mil') path = '/v2/mil'; else path = `/v2/${kind}/${args[0]}`;
      const lookup = ['hex', 'callsign', 'reg'].includes(kind); // user searches get their own lane so they are not stuck behind a sweep
      try { const d = await Net.json(AIR_SRC[src] + path, { throttle: lookup ? src + ':lookup' : src, gap: this.paced(src), timeout: 20000 }); d._src = src; this.onOk(src); return d; }
      catch (e) {
        let msg = e.message;
        if (/HTTP 429/.test(msg)) { this.on429(src); msg += ' — pausing this source 60 s'; }
        if (/HTTP 403/.test(msg) && src === 'airplanes.live') msg = 'HTTP 403 — airplanes.live now requires written permission for API use (contact@airplanes.live)';
        errs.push(`${src}: ${msg}`); if (/blocked by browser|no helper/.test(msg)) break;
      }
    }
    throw new Error(errs.join(' · '));
  },
  alerted: new Map(), // hex -> time of the last emergency alert (one per aircraft per 30 min)
  raiseEmergency(rec) {
    const t = this.alerted.get(rec.hex); if (t && Date.now() - t < 30 * 60e3) return; this.alerted.set(rec.hex, Date.now());
    const why = ['7500', '7600', '7700'].includes(rec.squawk) ? `Squawk ${rec.squawk}` : `Emergency (${rec.emergency})`;
    const hex = rec.hex;
    Log.alert(`${why}: ${[(rec.flight || rec.r || hex).trim(), rec.t].filter(Boolean).join(' ')} near ${regionOf(rec.lat, rec.lon)}`, { onclick: () => { const r = Dyn.air.get(hex) || rec; flyTo(r.lat, r.lon, 7); if (Dyn.air.has(hex)) Detail.show('air', r, hex); } });
  },
  ingest(data, tag) {
    const list = data.ac || data.aircraft || []; const now = Date.now(); const src = data._src || 'adsb'; let n = 0; this.lastHexes = []; // hexes stored by this call, for lookups
    for (const a of list) {
      const hex = String(a.hex || '').toLowerCase().replace(/[^0-9a-f~]/g, ''); // hex also lands in onclick handlers: keep it to its real charset
      if (a.lat == null || a.lon == null || !hex) continue; n++; this.lastHexes.push(hex);
      let rec = Dyn.air.get(hex);
      if (!rec) { rec = { hex, trail: [], first: now, tags: new Set() }; Dyn.air.set(hex, rec); }
      const wasEmerg = !!rec.emerg;
      const ground = a.alt_baro === 'ground';
      const alt = ground ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : (typeof a.alt_geom === 'number' ? a.alt_geom : rec.alt));
      Object.assign(rec, {
        lat: a.lat, lon: a.lon, alt, altGeom: a.alt_geom, ground, gs: a.gs ?? rec.gs, track: a.track ?? a.true_heading ?? rec.track,
        vr: a.baro_rate ?? a.geom_rate ?? null, squawk: a.squawk, emergency: a.emergency, flight: (a.flight || '').trim(), r: a.r, t: a.t, desc: a.desc,
        ownOp: a.ownOp, year: a.year, category: a.category, nic: a.nic, nacp: a.nac_p, rssi: a.rssi, seen_pos: a.seen_pos, seen: a.seen,
        mlat: !!(a.mlat && a.mlat.length), tisb: !!(a.tisb && a.tisb.length), dbFlags: a.dbFlags || 0, msgs: a.messages, ts: now, src, msgType: a.type,
      });
      rec.mil = !!(rec.dbFlags & 1) || tag === 'mil'; rec.interesting = !!(rec.dbFlags & 2); rec.pia = !!(rec.dbFlags & 4); rec.ladd = !!(rec.dbFlags & 8);
      rec.emerg = (!!rec.emergency && rec.emergency !== 'none') || ['7500', '7600', '7700'].includes(rec.squawk);
      if (rec.emerg && !wasEmerg) this.raiseEmergency(rec);
      rec.lowNic = !ground && rec.nic != null && rec.nic <= 5 && (rec.gs || 0) > 100 && (rec.alt || 0) > 5000;
      if (tag) rec.tags.add(tag);
      const last = rec.trail[rec.trail.length - 1];
      if (!last || haversine(last[0], last[1], a.lat, a.lon) > 150) { rec.trail.push([a.lat, a.lon, now]); const maxTrail = (rec.mil || rec.emerg || Sel.id === hex) ? 150 : 25; while (rec.trail.length > maxTrail) rec.trail.shift(); }
    }
    return n;
  },
  prune() { const now = Date.now(); const civTtl = Math.max(75e3, (AirSweep.passMs || 0) * 3 + 30e3); for (const [k, a] of Dyn.air) { const ttl = a.src === 'opensky' ? 400e3 : a.emerg ? 240e3 : a.mil ? 150e3 : civTtl; if (now - a.ts > ttl) Dyn.air.delete(k); } },
  counts() { let mil = 0, emg = 0; for (const a of Dyn.air.values()) { if (a.mil) mil++; if (a.emerg) emg++; } return { all: Dyn.air.size, mil, emg }; },
  trail(hex) {
    const a = Dyn.air.get(hex); if (!a) return; Tracks.clear();
    if (a.trail.length > 1) L.polyline(a.trail.map(p => [p[0], p[1]]), { color: a.mil ? C.mil : C.civ, weight: 2, opacity: .8, renderer: vecRenderer }).addTo(Tracks.group);
    if (a.gs > 30 && a.track != null && !a.ground) { const ahead = destination(a.lat, a.lon, a.track, a.gs * 0.514444 * 600); L.polyline([[a.lat, a.lon], ahead], { color: C.accent, weight: 1, dashArray: '4 6', opacity: .7, renderer: vecRenderer }).addTo(Tracks.group); }
    toast(`Trail: ${a.trail.length} fixes · dashed line = next 10 min at current track`);
  },
  follow(hex) { this.following = this.following === hex ? null : hex; Detail.render(); toast(this.following ? 'Following — pan the map to stop' : 'Stopped following'); },
  // ICAO type designators → rough role. Heuristic, good enough for a picture of what is up.
  ROLES: [
    ['ISR / recon', /^(R135|P8|P3|U2|Q4|RQ4|MQ9|Q9|MQ4|E8|E6|E11|CL60|SF34|SB20|SW4|AT72|EC35|ISR)$/],
    ['AEW / AWACS', /^(E3TF|E3CF|E767|E737|E2|E3|E7)$/],
    ['tanker', /^(K35R|K35E|K35A|KC46|K46A|DC10|A310|A332|IL78|VC10|TRIS|C135)$/],
    ['bomber', /^(B1|B2|B52|TU95|TU22|TU16|T160|H6)$/],
    ['fighter / attack', /^(F16|F15|F18S|F18H|F18|F35|F22|F14|F4|F5|F2|F1|EUFI|RFAL|GRIP|TORN|A10|MG29|MG31|SU27|SU30|SU34|SU35|SU24|SU25|MIR2|MIRA|HAR|AV8B|AJET|AMX|JH7|J10|J11|J20|EA6|T50|EA18|F117)$/], // FA50 is the Falcon 50 (bizjet), not the KAI FA-50
    ['trainer', /^(HAWK|T38|T45|TEX2|T6|PC21|PC9|PC7|M346|L39|L159|BE40|T7|G120|GROB|T34|TUCA|A29|AT6|T1|T2|T4|C101|MB33|MB39|SF26|DA40|DA42|PA28|C172|C182)$/],
    ['helicopter', /^(H60|H64|H47|V22|H53|S92|A139|EC45|H145|EC35|EC55|AS32|AS50|AS65|EH10|NH90|PUMA|LYNX|UH1|H1|B412|B212|B429|B505|B06|B407|H500|R44|R22|MI8|MI17|MI24|KA52|TIGR|EC25|EC75|A109|A189|S61|S70|S76|S64|H135|H160|H175|BK17|EC30|EC20|AS55|LYNX|A129|CH53|MH60)$/],
    ['airlift / transport', /^(C17|C130|C30J|L100|C5M|C5|A400|C27J|C295|CN35|A124|IL76|AN12|AN26|AN72|AN70|C160|C2|C1|C212|C23|DHC6|DH8[ABCD]|B752|B763|B744|B742|B738|B737|B739|B39M|A319|A320|A321|A343|A359|E135|E145|E190|A20N|Y8|Y9|Y20|KC1|C12|C26|BE20|B350|PC12|PC24|G222)$/],
    ['bizjet / VIP', /^(GLF5|GLF6|GLF4|GL5T|GL7T|GLEX|CL35|CL30|FA7X|FA8X|F900|F2TH|FA50|C25A|C25B|C25C|C500|C510|C525|C550|C560|C56X|C68A|C680|C750|LJ35|LJ40|LJ45|LJ60|LJ75|H25B|H25C|HA4T|E35L|E50P|E55P|E545|E550|PRM1|ASTR|GALX)$/],
  ],
  roleOf(a) { if (a.category === 'A7') return 'helicopter'; const t = (a.t || '').toUpperCase(); for (const [role, re] of this.ROLES) if (re.test(t)) return role; return 'other / unknown'; },
  notable(a) { const r = this.roleOf(a); return a.interesting || r === 'ISR / recon' || r === 'AEW / AWACS' || r === 'tanker' || /^(B52|B1|B2|E4|VC25|F117|U2|RQ4|Q4|E6|TU95|TU22)$/.test((a.t || '').toUpperCase()); },
  where(a) { return regionOf(a.lat, a.lon); },
};
setInterval(() => {
  Air.prune(); const c = Air.counts();
  $('#chipAir b').textContent = fmt.n(c.all); $('#chipMil b').textContent = fmt.n(c.mil);
  const ce = $('#chipEmg'); $('b', ce).textContent = c.emg; ce.classList.toggle('hot', c.emg > 0);
  Air.history.push([Date.now(), c.all, c.mil]); if (Air.history.length > 120) Air.history.shift();
  const hs = $('#hudSweep'); if (hs) hs.textContent = lyAirLocal.on && AirSweep.tiles.length ? `sweep ${AirSweep.tiles.length} tiles${AirSweep.passMs ? ' · ' + (AirSweep.passMs / 1000).toFixed(0) + ' s/pass' : ''}` : '';
  if (Air.following) { // pan to the dead-reckoned spot the icon is drawn at (same formula as Glyphs.draw), not the last raw fix
    const a = Dyn.air.get(Air.following);
    if (a) { const dt = Math.min(150, (Date.now() - a.ts) / 1000 + (a.seen_pos || 0)); const p = (a.gs > 30 && a.track != null && dt > 0 && !a.ground) ? destination(a.lat, a.lon, a.track, a.gs * 0.514444 * dt) : [a.lat, a.lon]; map.panTo(p, { animate: true, duration: .5 }); }
    else Air.following = null;
  }
}, 3000);
map.on('dragstart', () => { Air.following = null; });

Detail.renderers.air = a => {
  const flags = [];
  if (a.mil) flags.push({ t: 'Military · ' + Air.roleOf(a), cls: 'mil' });
  if (a.emerg) flags.push({ t: `Squawk ${a.squawk || ''} ${a.emergency && a.emergency !== 'none' ? a.emergency : ''}`.trim(), cls: 'emg' });
  if (a.interesting) flags.push({ t: 'Interesting', cls: 'warn' });
  if (a.lowNic) flags.push({ t: `Low nav integrity · NIC ${a.nic}`, cls: 'warn' });
  if (a.ladd) flags.push({ t: 'LADD' }); if (a.pia) flags.push({ t: 'PIA' }); if (a.mlat) flags.push({ t: 'MLAT' }); if (a.tisb) flags.push({ t: 'TIS-B' }); if (a.ground) flags.push({ t: 'On ground' });
  const title = a.flight || a.r || a.hex.toUpperCase();
  const sub = [a.desc || a.t, a.ownOp, a.year].filter(Boolean).map(esc).join(' · ');
  const vr = a.vr != null ? (a.vr > 0 ? '▲ ' : a.vr < 0 ? '▼ ' : '') + fmt.n(Math.abs(a.vr)) + ' ft/min' : null;
  const rows = [
    ['ICAO hex', a.hex.toUpperCase()], ['Registration', a.r], ['Type', a.t], ['Callsign', a.flight],
    ['Altitude', a.ground ? 'ground' : a.alt != null ? `${fmt.n(a.alt)} ft · ${fmt.n(a.alt * 0.3048)} m` : null], ['Vertical', vr],
    ['Ground speed', a.gs != null ? `${fmt.n(a.gs)} kt · ${fmt.n(a.gs * 1.852)} km/h` : null], ['Track', a.track != null ? `${fmt.n(a.track)}°` : null],
    ['Squawk', a.squawk], ['Category', a.category], ['Position', fmt.ll(a.lat, a.lon)],
    ['Position age', a.seen_pos != null ? `${Math.round(a.seen_pos + (Date.now() - a.ts) / 1000)} s` : fmt.ago(a.ts)],
    ['NIC / NACp', (a.nic != null || a.nacp != null) ? `${a.nic ?? '—'} / ${a.nacp ?? '—'}` : null], ['Signal', a.rssi != null ? `${a.rssi} dBFS` : null],
    ['Messages', a.msgs != null ? fmt.n(a.msgs) : null], ['Source', a.src], ['Country', a.country],
  ];
  const links = [
    { text: 'Open on globe.adsb.lol', url: `https://globe.adsb.lol/?icao=${a.hex}` },
    { text: 'Open on globe.airplanes.live', url: `https://globe.airplanes.live/?icao=${a.hex}` },
  ];
  if (a.flight) links.push({ text: `FlightAware · ${a.flight}`, url: `https://flightaware.com/live/flight/${encodeURIComponent(a.flight)}` });
  if (a.r) links.push({ text: `Registration ${a.r} on Planespotters`, url: `https://www.planespotters.net/search?q=${encodeURIComponent(a.r)}` });
  return `<div class="det">${Detail.head(a.emerg ? C.emg : a.mil ? C.mil : C.civ, `Aircraft · ADS-B via ${a.src}`, title, sub, flags)}${Photos.html(a.hex)}${Detail.kv(rows)}
  <div class="actions"><button class="btn small" onclick="flyTo(${num(a.lat)},${num(a.lon)},8)">Center</button><button class="btn small" onclick="Air.trail('${idArg(a.hex)}')">Trail</button><button class="btn small" onclick="Air.follow('${idArg(a.hex)}')">${Air.following === a.hex ? 'Unfollow' : 'Follow'}</button></div>
  <hr class="sep">${Detail.links(links)}</div>`;
};

/* ---- "All aircraft in view": the public APIs answer at most 250 nm per query, so the visible area is swept
   with a hexagonal grid of 250 nm circles (up to MAX_TILES per pass, nearest the center first), the tiles split
   across the two aggregators in parallel, and everything is dead-reckoned between passes. */
export const AirSweep = {
  R_KM: 463, MAX_TILES: 30, tiles: [], partial: false, key: '', passMs: 0, cover: L.layerGroup(), showCover: Store.get('sweep_cover', false),
  plan() {
    const b = map.getBounds(); const c = map.getCenter();
    const south = Math.max(-80, b.getSouth()), north = Math.min(80, b.getNorth()); let west = b.getWest(), east = b.getEast(); if (east - west > 360) { west = -180; east = 180; }
    const R = this.R_KM, rowKm = 1.5 * R, dLat = rowKm / 111, cand = [];
    const row0 = Math.floor((south - dLat) / dLat), row1 = Math.ceil((north + dLat) / dLat);
    for (let r = row0; r <= row1; r++) {
      const lat = r * dLat; if (lat < -80 || lat > 80) continue;
      const dLon = (Math.sqrt(3) * R) / (111 * Math.max(.2, Math.cos(rad(lat)))); const off = (r % 2) ? dLon / 2 : 0;
      const c0 = Math.floor((west - dLon) / dLon), c1 = Math.ceil((east + dLon) / dLon);
      for (let k = c0; k <= c1; k++) { const lon = k * dLon + off; if (lon < west - dLon * .6 || lon > east + dLon * .6) continue; if (lat < south - dLat * .6 || lat > north + dLat * .6) continue; cand.push({ lat: +lat.toFixed(3), lon: +(((lon + 540) % 360) - 180).toFixed(3), d: haversine(c.lat, c.lng, lat, lon) }); }
    }
    cand.sort((a, b) => a.d - b.d); this.partial = cand.length > this.MAX_TILES; this.tiles = cand.slice(0, this.MAX_TILES);
    this.key = this.tiles.map(t => `${t.lat},${t.lon}`).sort().join('|'); this.drawCover(); return this.tiles; // sorted: a pan that only reorders the same tiles keeps the pass going
  },
  drawCover() {
    this.cover.clearLayers(); if (!this.showCover || !lyAirLocal.on) return;
    for (const t of this.tiles) L.circle([t.lat, t.lon], { radius: this.R_KM * 1000, color: C.civ, weight: 1, opacity: .25, fill: false, dashArray: '3 6', interactive: false, renderer: vecRenderer }).addTo(this.cover);
    if (!map.hasLayer(this.cover)) this.cover.addTo(map);
  },
  async pass() {
    const tiles = this.plan(); const key = this.key; const t0 = Date.now(); let n = 0, done = 0, errs = [];
    const srcs = Air.order(); if (!srcs.length) throw new Error('no aircraft source available');
    const queue = tiles.slice(); // shared: each source pulls the next tile, so if one source fails the others cover everything
    const worker = async (src) => {
      while (queue.length) {
        if (this.key !== key) return; // the map moved: stop this pass, the next one starts fresh
        const t = queue.shift();
        try { const d = await Air.getFrom(src, 'point', t.lat, t.lon, 250); n += Air.ingest(d, 'local'); done++; }
        catch (e) {
          errs.push(`${src}: ${e.message}`);
          if (/blocked by browser|no helper|cooling down|pausing|HTTP 40[13]/.test(e.message)) { queue.unshift(t); return; } // this source is out for the pass: hand the tile back
          if (!t.retried) { t.retried = true; queue.push(t); } // a one-off failure (timeout, 5xx): one more try at the end, by whichever source gets there
        }
        requestDraw(); lyAirLocal.feed.count = Dyn.air.size; UI.refreshLayer(lyAirLocal);
      }
    };
    await Promise.all(srcs.map(worker));
    if (!done && errs.length) throw new Error(errs[0]);
    if (this.key !== key) { setTimeout(() => { lyAirLocal.feed.nextAt = 0; }, 0); return n; } // moved mid-pass: sweep again right away (after runFeed has set its own nextAt)
    this.passMs = Date.now() - t0; // only whole passes feed the civil-aircraft TTL in prune()
    const cooling = Object.entries(Air.cooldown).filter(([, v]) => v > Date.now()).map(([k]) => k);
    const refused = srcs.filter(s => errs.some(e => e.startsWith(s + ': HTTP 403')));
    lyAirLocal.desc = `${done}/${tiles.length} tiles · pass ${(this.passMs / 1000).toFixed(0)} s${this.partial ? ' · zoom in to cover the whole view' : ''}${cooling.length ? ' · ' + cooling.join(', ') + ' rate-limited, using the other source' : ''}${refused.length ? ' · ' + refused.join(', ') + ' refused (HTTP 403, needs their permission), using the others' : ''}`;
    return n;
  },
};
export const lyAirLocal = Layers.add({
  id: 'air_local', group: 'Air', name: 'All aircraft in view', desc: 'ADS-B · sweeps the visible area in 250 nm tiles, up to 30 per pass (the whole continental US when it fills the screen) · needs the helper', color: C.civ, default: true,
  sub(el) {
    const srcs = [{ id: 'adsb.lol', name: 'adsb.lol' }, { id: 'adsb.fi', name: 'adsb.fi' }, { id: 'airplanes.live', name: 'airplanes.live', title: 'Only if airplanes.live has given you API permission — otherwise it answers 403' }];
    const render = () => {
      UI.pills(el, srcs, id => Layers.opt('air_src') === id, id => { Layers.setOpt('air_src', id); render(); });
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pill' + (Layers.opt('air_labels') ? ' on' : ''); b.textContent = 'labels';
      b.addEventListener('click', () => { Layers.setOpt('air_labels', !Layers.opt('air_labels')); b.classList.toggle('on'); requestDraw(); }); el.appendChild(b);
      const c = document.createElement('button'); c.type = 'button'; c.className = 'pill' + (AirSweep.showCover ? ' on' : ''); c.textContent = 'show sweep'; c.title = 'Outline the 250 nm tiles being queried';
      c.addEventListener('click', () => { AirSweep.showCover = !AirSweep.showCover; Store.set('sweep_cover', AirSweep.showCover); c.classList.toggle('on'); AirSweep.drawCover(); }); el.appendChild(c);
    };
    render();
  },
  enable() { AirSweep.drawCover(); },
  disable() { AirSweep.cover.clearLayers(); for (const [k, a] of Dyn.air) if (!a.mil && !a.emerg && a.src !== 'opensky') Dyn.air.delete(k); },
});
feed(lyAirLocal, { interval: 8, viewDependent: true, minZoom: 3, startDelay: 3, fetch: async () => { await AirSweep.pass(); lyAirLocal.feed.count = Dyn.air.size; } });
map.on('moveend', debounce(() => { if (lyAirLocal.on && map.getZoom() >= 3) { AirSweep.plan(); } }, 300));

export const lyAirMil = Layers.add({ id: 'air_mil', group: 'Air', name: 'Military aircraft, worldwide', desc: 'Everything the aggregator flags as military · needs the helper', color: C.mil, default: true, disable() { for (const [k, a] of Dyn.air) if (a.mil && !a.tags.has('local')) Dyn.air.delete(k); } });
feed(lyAirMil, { interval: 15, fetch: async () => { const d = await Air.get('mil'); lyAirMil.feed.count = Air.ingest(d, 'mil'); } });

export const lyAirEmg = Layers.add({ id: 'air_emg', group: 'Air', name: 'Emergency squawks, worldwide', desc: '7700 emergency · 7600 radio failure · 7500 unlawful interference', color: C.emg, default: true });
export let emgCycle = 0;
feed(lyAirEmg, {
  interval: 45, errorInterval: 90, startDelay: 12, fetch: async () => {
    let n = 0; // alerts come from Air.ingest when an aircraft turns emergency, whichever feed sees it first
    const squawks = ['7700', (emgCycle++ % 2) ? '7600' : '7500']; // 7700 every cycle, the rarer two alternate: 2 requests instead of 3
    for (const sq of squawks) {
      const d = await Air.get('squawk', sq); n += Air.ingest(d, 'sqk');
    }
    lyAirEmg.feed.count = n;
  }
});

export const lyOpenSky = Layers.add({ id: 'air_opensky', group: 'Air', name: 'Global civil snapshot (OpenSky)', desc: 'Anonymous · every 15 min (400 credits/day cap) · needs the helper', color: '#9ad9ff', default: false, disable() { for (const [k, a] of Dyn.air) if (a.src === 'opensky') Dyn.air.delete(k); } });
feed(lyOpenSky, {
  interval: 900, errorInterval: 900, fetch: async () => {
    const d = await Net.json('https://opensky-network.org/api/states/all', { timeout: 45000 }); const now = Date.now(); let n = 0;
    for (const s of (d.states || [])) {
      const [icao, cs, country, tpos, , lon, lat, balt, onground, vel, trk, vr, , , squawk] = s; if (lat == null || lon == null) continue;
      const hex = String(icao || '').toLowerCase().replace(/[^0-9a-f~]/g, ''); if (!hex) continue; const ex = Dyn.air.get(hex); if (ex && ex.src !== 'opensky') continue;
      const rec = ex || { hex, trail: [], first: now, tags: new Set(['opensky']) }; Dyn.air.set(hex, rec); const wasEmerg = !!rec.emerg;
      Object.assign(rec, { lat, lon, alt: onground ? 0 : (balt != null ? balt / 0.3048 : null), ground: !!onground, gs: vel != null ? vel / 0.514444 : null, track: trk, vr: vr != null ? vr / 0.3048 * 60 : null, squawk, flight: (cs || '').trim(), country, ts: now, seen_pos: tpos ? Math.max(0, now / 1000 - tpos) : 0, src: 'opensky', mil: false, emerg: ['7500', '7600', '7700'].includes(squawk), lowNic: false, dbFlags: 0 });
      if (rec.emerg && !wasEmerg) Air.raiseEmergency(rec);
      n++;
    }
    lyOpenSky.feed.count = n;
  }
});

/* ---- airframe photos: Planespotters.net public API (no key, CORS enabled, credit required) */
export const Photos = {
  cache: new Map(), pending: new Set(),
  html(hex) {
    const c = this.cache.get(hex);
    if (c === undefined || (c && c.failAt && Date.now() - c.failAt > 120e3)) { this.fetch(hex); if (c === undefined) return `<div class="photo"><div class="cap">Looking for a photo of this airframe…</div></div>`; }
    if (!c || c.failAt) return ''; // null = no photo exists; failAt = lookup failed, retried after 2 min
    return `<div class="photo"><a href="${esc(c.link)}" target="_blank" rel="noopener"><img src="${esc(c.src)}" alt="Photo of this aircraft" referrerpolicy="no-referrer"></a><div class="cap">© ${esc(c.by)} · <a href="${esc(c.link)}" target="_blank" rel="noopener">Planespotters.net</a></div></div>`;
  },
  async fetch(hex) {
    if (this.pending.has(hex)) return; this.pending.add(hex);
    try { const d = await Net.json(`https://api.planespotters.net/pub/photos/hex/${hex}`, { throttle: 'planespotters', gap: 700, timeout: 15000 }); const p = (d.photos || [])[0];
      this.cache.set(hex, p ? { src: (p.thumbnail_large || p.thumbnail).src, link: p.link, by: p.photographer } : null); }
    catch (e) { this.cache.set(hex, { failAt: Date.now() }); }
    finally { this.pending.delete(hex); if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value); if (Sel.kind === 'air' && Sel.id === hex) Detail.render(); }
  },
};
