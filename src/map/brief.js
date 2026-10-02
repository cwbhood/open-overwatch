// The live situation brief and the first-run welcome.
import { $, $$, C, deg, esc, fmt, FONT_MONO, haversine, hexA, late, pick, rad, regionOf, Relay, safeHost, Store } from './util.js';
import { map, sunElevation } from './mapview.js';
import { Dyn, Layers } from './engine.js';
import { Detail } from './detail.js';
import { Air, AirSweep, lyAirEmg, lyAirMil } from './aircraft.js';
import { Sats } from './satellites.js';
import { Aurora, Space, World, lyQuakes, lyStorms } from './feeds.js';
import { Fun, Locate, PRESETS, Presets, legendHtml } from './presets.js';

/* ============================================================ BRIEF: the live situation summary */
export const Brief = {
  el: null, issPass: { t: 0, v: null, key: '' },
  sec(label, body, when) { return `<section class="bsec"><div class="bhead"><span class="label">${esc(label)}</span>${when ? `<span class="when">${esc(when)}</span>` : ''}</div>${body}</section>`; },
  item(cls, id, what, where, act) { return `<button class="item" data-act="${esc(act)}"><span class="id ${cls}">${esc(id)}</span><span class="what">${esc(what)}</span><span class="where">${esc(where || '')}</span></button>`; },
  kpText(kp) { if (kp == null) return null; const g = kp >= 9 ? 'G5 extreme storm' : kp >= 8 ? 'G4 severe storm' : kp >= 7 ? 'G3 strong storm' : kp >= 6 ? 'G2 moderate storm' : kp >= 5 ? 'G1 minor storm' : kp >= 4 ? 'active' : kp >= 3 ? 'unsettled' : 'quiet'; const lat = 66.5 - kp * 2.05; return { g, lat }; },
  // centred-dipole geomagnetic latitude (north geomagnetic pole ≈ 80.8°N 72.6°W); the oval edge above is in these terms
  magLat(lat, lon) { const p = rad(80.8); return deg(Math.asin(Math.sin(rad(lat)) * Math.sin(p) + Math.cos(rad(lat)) * Math.cos(p) * Math.cos(rad(lon + 72.6)))); },
  render() {
    if (!this.el || !$('#tab-brief').classList.contains('on')) return;
    // a rebuild mid-press swallows the click and wipes a text selection: skip this tick (the next one catches up)
    const sel = getSelection(); if (this.el.matches(':active') || (sel && !sel.isCollapsed && this.el.contains(sel.anchorNode))) return;
    const air = [...Dyn.air.values()], now = Date.now(); const pos = Locate.pos; const parts = [];
    // ---- emergencies
    const emg = air.filter(a => a.emerg);
    parts.push(this.sec('Emergency squawks', emg.length ? `<div class="items">${emg.slice(0, 6).map(a => this.item('emg', a.flight || a.r || a.hex.toUpperCase(), `${a.squawk} ${a.emergency && a.emergency !== 'none' ? a.emergency : ''} · ${a.desc || a.t || ''}`.trim(), Air.where(a), 'air:' + a.hex)).join('')}</div>` : `<p class="bline">${Layers.on('air_emg') ? (lyAirEmg.feed.lastOk ? `None worldwide right now. 7700 checked ${fmt.ago(lyAirEmg.feed.lastOk)} ago.` : (lyAirEmg.feed.err ? esc(lyAirEmg.feed.err) : 'Checking…')) : 'Layer off.'}</p>`, emg.length ? 'live' : ''));
    // ---- military air picture
    const mil = air.filter(a => a.mil && !a.ground);
    if (Layers.on('air_mil') || mil.length) {
      const roles = {}, types = {}; for (const a of mil) { const r = Air.roleOf(a); roles[r] = (roles[r] || 0) + 1; const t = (a.t || '?').toUpperCase(); types[t] = (types[t] || 0) + 1; }
      const rolesSorted = Object.entries(roles).sort((x, y) => y[1] - x[1]); const maxR = rolesSorted[0]?.[1] || 1;
      const typesSorted = Object.entries(types).filter(([t]) => t !== '?').sort((x, y) => y[1] - x[1]).slice(0, 10);
      const notable = mil.filter(a => Air.notable(a)).sort((a, b) => (b.interesting - a.interesting) || ((b.alt || 0) - (a.alt || 0))).slice(0, 8);
      const body = mil.length ? `<div class="bigrow"><div><span class="big">${fmt.n(mil.length)}<small>airborne</small></span></div><div><span class="big">${fmt.n(notable.length)}<small>notable</small></span></div><div><span class="big">${fmt.n(air.filter(a => a.mil && a.ground).length)}<small>on ground</small></span></div></div>
        <div class="bars">${rolesSorted.slice(0, 7).map(([r, n]) => `<div class="bar"><span>${esc(r)}</span><i style="--w:${Math.round(n / maxR * 100)}%"></i><b>${n}</b></div>`).join('')}</div>
        <div class="chips">${typesSorted.map(([t, n]) => `<button class="tchip" data-act="type:${esc(t)}" title="Fly to one of them"><b>${esc(t)}</b> ×${n}</button>`).join('')}</div>
        ${notable.length ? `<div class="items">${notable.map(a => this.item('mil', a.flight || a.r || a.hex.toUpperCase(), `${a.desc || a.t || ''} · ${Air.roleOf(a)}${a.alt ? ' · FL' + String(Math.round(a.alt / 100)).padStart(3, '0') : ''}`, 'near ' + Air.where(a), 'air:' + a.hex)).join('')}</div>` : ''}
        <div class="brow"><button class="btn small" data-act="surprise">Surprise me</button></div>` : `<p class="bline">${lyAirMil.feed.err ? esc(lyAirMil.feed.err) : 'Loading the worldwide military feed…'}</p>`;
      parts.push(this.sec('Military air picture', body, lyAirMil.feed.lastOk ? fmt.ago(lyAirMil.feed.lastOk) + ' ago' : ''));
    }
    // ---- degraded GPS
    const low = air.filter(a => a.lowNic); if (low.length >= 3) {
      const cells = {}; for (const a of low) { const k = `${Math.round(a.lat / 4) * 4},${Math.round(a.lon / 4) * 4}`; (cells[k] ||= []).push(a); }
      const top = Object.values(cells).sort((x, y) => y.length - x.length).slice(0, 3);
      parts.push(this.sec('Degraded GPS reports', `<p class="bline"><b>${low.length}</b> airborne aircraft are reporting low position integrity (NIC ≤ 5), the usual sign of GNSS interference.</p><div class="items">${top.map(c => { const la = c.reduce((s, a) => s + a.lat, 0) / c.length, lo = c.reduce((s, a) => s + a.lon, 0) / c.length; return this.item('', `${c.length} aircraft`, 'clustered', 'near ' + regionOf(la, lo), `fly:${la.toFixed(2)},${lo.toFixed(2)},6`); }).join('')}</div>`));
    }
    // ---- ISS + above you
    const iss = Sats.iss();
    if (Layers.on('sats')) {
      let body = '';
      if (iss && iss.lat != null) {
        body += `<p class="bline"><b>ISS</b> is over <b>${esc(regionOf(iss.lat, iss.lon))}</b>, ${fmt.n(iss.alt)} km up at ${fmt.n(iss.vel * 3600)} km/h, on the ${sunElevation(iss.lat, iss.lon, now) > 0 ? 'day' : 'night'} side.</p>`;
        if (pos) {
          const key = `${iss.id}|${pos.lat.toFixed(1)},${pos.lon.toFixed(1)}`, old = this.issPass.v; if (this.issPass.key !== key || now - this.issPass.t > 300e3 || (old && (old.end || old.start) < now)) { this.issPass = { t: now, key, v: Sats.nextPass(iss, pos.lat, pos.lon, 10) }; }
          // the ISS stays sunlit until the sun is acos(R/(R+alt)) (~20°) below the horizon under it, not just 0°
          const p = this.issPass.v; const el = Sats.elevation(pos.lat, pos.lon, iss), shadow = -deg(Math.acos(6371 / (6371 + (iss.alt || 420))));
          if (el > 0) body += `<p class="bline hot" style="color:var(--accent)"><b>It is above your horizon right now</b> — ${el.toFixed(0)}° elevation${sunElevation(pos.lat, pos.lon, now) < -6 && sunElevation(iss.lat, iss.lon, now) > shadow ? ', sunlit in a dark sky: go look' : ''}.</p>`;
          else if (p) body += `<p class="bline">Next pass over you in <b>${fmt.mins((p.start - now) / 60000)}</b> (${fmt.hm(p.start)}), peaking at ${p.max.toFixed(0)}° elevation${p.end ? `, ${fmt.mins((p.end - p.start) / 60000)} long` : ''}.</p>`;
        } else body += `<p class="bline">Use <b>Center on me</b> to get your next ISS pass and what is above you.</p>`;
      } else body += `<p class="bline">${Sats.loading ? 'Loading orbital elements…' : (Sats.groupsOn().includes('stations') ? 'ISS not propagated yet.' : 'Turn on the Stations group to track the ISS.')}</p>`;
      if (pos && Dyn.sats.length) { const ab = Sats.above(pos.lat, pos.lon, 30); if (ab.length) { const named = ab.filter(x => !x.s.dim).slice(0, 6); body += `<p class="bline"><b>${ab.length}</b> of the ${Dyn.sats.length} loaded satellites are above 30° over you${named.length ? ': ' + named.map(x => `<b>${esc(x.s.name)}</b> ${x.el.toFixed(0)}°`).join(', ') : ''}.</p>`; } }
      body += `<div class="brow"><button class="btn small" data-act="iss">Follow ISS</button>${pos ? '' : '<button class="btn small" data-act="locate">Center on me</button>'}</div>`;
      parts.push(this.sec('Space', body, Dyn.sats.length ? `${fmt.n(Dyn.sats.length)} tracked` : ''));
    }
    // ---- hazards (World.* keep their last data when a layer is switched off, so gate each on its layer)
    {
      let body = '';
      const q = (Layers.on('quakes') ? World.quakes : []).slice().sort((a, b) => b.mag - a.mag); if (q.length) { const big = q[0]; const m45 = q.filter(x => x.mag >= 4.5).length; body += `<div class="items">${this.item('qk', `M${big.mag.toFixed(1)}`, `${big.place || ''} · ${fmt.ago(big.time)} ago`, `${m45} at M4.5+`, 'quake:' + big.id)}</div>`; }
      else if (Layers.on('quakes')) body += `<p class="bline">${lyQuakes.feed.err ? esc(lyQuakes.feed.err) : 'Loading earthquakes…'}</p>`;
      if (Layers.on('storms') && World.storms.length) body += `<div class="items">${World.storms.slice(0, 5).map(s => this.item('', s.title.replace(/^Tropical Cyclone\s+/i, ''), `${s.kt ? s.kt + ' kt · ' : ''}${s.src}`, 'near ' + regionOf(s.lat, s.lon), 'storm:' + s.id)).join('')}</div>`;
      else if (Layers.on('storms') && lyStorms.feed.lastOk) body += `<p class="bline">No named tropical cyclones active.</p>`;
      const red = (Layers.on('gdacs') ? World.gdacs : []).filter(p => p.alertlevel === 'Red' || p.alertlevel === 'Orange'); if (red.length) body += `<div class="items">${red.slice(0, 4).map(p => this.item('', p.alertlevel, p.name || p.eventtype, p.country || '', `fly:${p.lat.toFixed(2)},${p.lon.toFixed(2)},6`)).join('')}</div>`;
      const tor = (Layers.on('nws') && World.nws || []).filter(p => /tornado warning/i.test(p.event || '')); if (tor.length) body += `<p class="bline hot"><b>${tor.length} tornado warning${tor.length > 1 ? 's' : ''}</b> active in the US: ${esc(tor.slice(0, 3).map(p => p.areaDesc).join(' · '))}</p>`;
      else if (Layers.on('nws') && World.nws) body += `<p class="bline">${World.nws.length} severe/extreme NWS alerts active, no tornado warnings.</p>`;
      if (body) parts.push(this.sec('Hazards', body));
    }
    // ---- space weather
    if (Space.kp != null) { const k = this.kpText(Space.kp); const auroraHere = pos && Layers.on('aurora') && Aurora.grid ? Aurora.at(pos.lat, pos.lon) : null; const mlat = pos ? Math.abs(this.magLat(pos.lat, pos.lon)) : 0; parts.push(this.sec('Space weather', `<div class="bigrow"><div><span class="big">Kp ${Space.kp.toFixed(1)}<small>${esc(k.g)}</small></span></div></div><p class="bline">Aurora oval reaches about <b>${k.lat.toFixed(0)}°</b> geomagnetic latitude${pos ? (mlat >= k.lat - 5 ? ` — <b>possible on your horizon ${sunElevation(pos.lat, pos.lon, now) < -6 ? 'now' : 'after dark'}</b>` : ` — you are at ${mlat.toFixed(0)}° geomagnetic, too far from the poles right now`) : ''}.${auroraHere != null ? ` OVATION gives <b>${auroraHere}%</b> at your location.` : ''}</p>`, Space.kpTime ? String(Space.kpTime).replace('T', ' ').slice(5, 16) + 'Z' : '')); }
    // ---- records
    const flying = air.filter(a => !a.ground && a.alt > 0);
    if (flying.length > 5) {
      const hi = flying.reduce((m, a) => a.alt > (m?.alt || 0) ? a : m, null), fast = flying.reduce((m, a) => (a.gs || 0) > (m?.gs || 0) ? a : m, null), old = flying.filter(a => a.year > 1930).reduce((m, a) => +a.year < +(m?.year || 9999) ? a : m, null);
      const nearest = pos ? flying.reduce((m, a) => { const d = haversine(pos.lat, pos.lon, a.lat, a.lon); return d < (m?.d ?? Infinity) ? { a, d } : m; }, null) : null;
      parts.push(this.sec('Right now, of everything tracked', `<canvas class="spark" id="spark" width="340" height="36"></canvas>${Layers.on('air_local') && AirSweep.tiles.length ? `<p class="bline">Sweeping <b>${AirSweep.tiles.length}</b> tiles of 250 nm${AirSweep.partial ? ' (view larger than one pass — zoom in for full coverage)' : ''}${AirSweep.passMs ? `, last pass ${(AirSweep.passMs / 1000).toFixed(0)} s` : ''}.</p>` : ''}<div class="items">
        ${hi ? this.item('', 'highest', `${hi.flight || hi.r || hi.hex} · ${hi.desc || hi.t || ''} at ${fmt.n(hi.alt)} ft`, 'near ' + Air.where(hi), 'air:' + hi.hex) : ''}
        ${fast ? this.item('', 'fastest', `${fast.flight || fast.r || fast.hex} · ${fast.desc || fast.t || ''} at ${fmt.n(fast.gs)} kt`, 'near ' + Air.where(fast), 'air:' + fast.hex) : ''}
        ${old ? this.item('', 'oldest', `${old.flight || old.r || old.hex} · ${old.desc || old.t || ''}, built ${old.year}`, 'near ' + Air.where(old), 'air:' + old.hex) : ''}
        ${nearest ? this.item('', 'nearest you', `${nearest.a.flight || nearest.a.r || nearest.a.hex} · ${nearest.a.desc || nearest.a.t || ''}`, fmt.dist(nearest.d) + ' away', 'air:' + nearest.a.hex) : ''}</div>`, `${fmt.n(flying.length)} aircraft`));
    } else if (Layers.on('air_local') && map.getZoom() < 3) parts.push(this.sec('All aircraft in view', `<p class="bline">Zoom in one step and the visible area is swept in 250 nm tiles (up to 30 per pass — the whole continental US when it fills the screen). At world scale only military and emergency traffic is loaded.</p>`));
    // ---- news
    if (Layers.on('news') && World.news.length) parts.push(this.sec('World news', `<p class="bline">Most coverage of <span class="mono">${esc(Layers.opt('news_q'))}</span> in the last 24 h comes from ${World.news.slice(0, 5).map(n => `<b>${esc(n.name)}</b> (${n.count})`).join(', ')}.</p><div class="items">${World.news.slice(0, 3).flatMap(n => n.articles.slice(0, 1).map(a => this.item('', n.name, a.text, safeHost(a.url), 'news:' + n.iso))).join('')}</div>`));
    if (!parts.length) parts.push(`<div class="empty">Turn on some layers, or pick a view on the left.</div>`);
    const html = parts.join(''), fa = this.el.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    if (html !== this.html) { this.html = html; this.el.innerHTML = html; if (fa) { const b = [...this.el.querySelectorAll('[data-act]')].find(x => x.dataset.act === fa); if (b) b.focus(); } } // keep keyboard focus on the same item
    this.spark();
  },
  spark() {
    const cv = $('#spark'); if (!cv || Air.history.length < 3) return; const ctx = cv.getContext('2d'); const W = cv.width = cv.clientWidth || 340, H = cv.height; const h = Air.history; const max = Math.max(...h.map(x => x[1]), 10);
    ctx.clearRect(0, 0, W, H); const pts = h.map((x, i) => [i / (h.length - 1) * W, H - 2 - (x[1] / max) * (H - 6)]);
    ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fillStyle = hexA(C.civ, .12); ctx.fill();
    ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.strokeStyle = C.civ; ctx.lineWidth = 1.5; ctx.stroke();
    const [lx, ly] = pts[pts.length - 1]; ctx.beginPath(); ctx.arc(lx - 1, ly, 2.5, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill();
    ctx.font = `10px ${FONT_MONO}`; ctx.fillStyle = C.ink_faint; ctx.textAlign = 'left'; ctx.fillText(`tracked, last ${fmt.mins((h[h.length - 1][0] - h[0][0]) / 60000)}`, 2, 10); ctx.textAlign = 'right'; ctx.fillStyle = C.ink_dim; ctx.fillText(fmt.n(max) + ' peak', W - 2, 10);
  },
  act(a) {
    const [kind, v] = a.split(/:(.*)/s);
    if (kind === 'air') { const x = Dyn.air.get(v); if (x) { map.flyTo([x.lat, x.lon], Math.max(map.getZoom(), 7), { duration: 1 }); Detail.show('air', x, x.hex); } }
    else if (kind === 'type') { const pool = [...Dyn.air.values()].filter(x => x.mil && !x.ground && (x.t || '').toUpperCase() === v); const x = pick(pool); if (x) { map.flyTo([x.lat, x.lon], 7, { duration: 1 }); Detail.show('air', x, x.hex); } }
    else if (kind === 'fly') { const [la, lo, z] = v.split(',').map(Number); map.flyTo([la, lo], z || 6, { duration: 1 }); }
    else if (kind === 'quake') { const q = World.quakes.find(x => x.id === v); if (q) { map.flyTo([q.lat, q.lon], 6, { duration: 1 }); Detail.show('quake', q, q.id); } }
    else if (kind === 'storm') { const s = World.storms.find(x => x.id === v); if (s) { map.flyTo([s.lat, s.lon], 6, { duration: 1 }); Detail.show('storm', s, s.id); } }
    else if (kind === 'news') { const n = World.news.find(x => x.iso === v); if (n) { map.flyTo([n.lat, n.lon], 5, { duration: 1 }); Detail.show('news', n, n.iso); } }
    else if (kind === 'surprise') Fun.surprise(); else if (kind === 'iss') Fun.followIss(); else if (kind === 'locate') Locate.go();
  },
};
setInterval(() => { if (!document.hidden) Brief.render(); }, 5000);

/* ============================================================ WELCOME (first run) */
export const Welcome = {
  show() {
    const el = $('#welcome'); el.hidden = false;
    el.innerHTML = `<div class="wcard" role="dialog" aria-labelledby="wt"><h2 id="wt">Open Overwatch</h2><p class="sub">A live picture of what is moving right now — aircraft, satellites, ships, storms and quakes — pulled straight from open feeds, no accounts. Pick where to start:</p>
      ${!Relay.available ? `<div class="wnote">Aircraft feeds need the bundled helper. ${Relay.local ? 'It is not answering on this port.' : 'Run <span class="mono">Start Open Overwatch.bat</span> (or serve.py / serve.js) and open the page it gives you.'} Everything else works from here.</div>` : ''}
      <div class="wgrid">${PRESETS.map(p => `<button class="view" data-preset="${p.id}"><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></button>`).join('')}</div>
      <div class="legend">${legendHtml()}</div>
      <div class="foot"><span>Shown once · reopen from Setup → Welcome</span><a id="wSkip" href="#" role="button">Just show the map</a></div></div>`;
    $$('.view', el).forEach(b => b.addEventListener('click', () => { this.hide(); Presets.apply(b.dataset.preset); }));
    $('#wSkip').addEventListener('click', e => { e.preventDefault(); this.hide(); });
  },
  hide() { const el = $('#welcome'); if (el.hidden) return; Store.set('welcomed', true); el.hidden = true; }, // any way out counts as "shown once"
};

Object.assign(late, { Brief });
