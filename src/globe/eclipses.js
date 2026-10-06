// Solar eclipses on the globe, 2027-2030 (data/eclipses.json: JPL Horizons Sun and Moon every minute, made by
// brand/tools/make_eclipses.py). Pick one and the clock jumps to it: the Moon's umbra races across the Earth along its
// path of totality, the penumbra's edge around it, at 1 minute per second. Positions go ICRF -> Earth-fixed with
// Cesium's IAU 2006 rotation (preloaded for the eclipse's dates), then core/eclipse.js does the geometry.
import { C, $, esc, toast } from './env.js';
import { viewer, camera } from './viewer.js';
import { release } from './follow.js';
import { Time } from './time.js';
import { state, hooks } from './state.js';
import { fetchAsset } from '../core/assets.js';
import { shadowCenter, outline, seenFrom, interp } from '../core/eclipse.js';
import { jdFromMs, msFromJd } from '../core/time.js';

const KIND = { total: 'Total', annular: 'Annular', partial: 'Partial' };
const Ecl = { list: null, active: null, ents: [], here: null };
const toM = p => new C.Cartesian3(p.x * 1000, p.y * 1000, p.z * 1000);
const fmtUtc = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const latlon = p => { const c = C.Cartographic.fromCartesian(toM(p)); const la = C.Math.toDegrees(c.latitude), lo = C.Math.toDegrees(c.longitude); return `${Math.abs(la).toFixed(1)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? 'E' : 'W'}`; };

async function load() { if (!Ecl.list) Ecl.list = (await fetchAsset('data/eclipses.json', 'json')).eclipses; return Ecl.list; }

/** Earth-fixed Sun and Moon (km) for every minute, the central line, greatest eclipse and its duration. */
async function prepare(e) {
  if (e.fixed) return e;
  const t0 = C.JulianDate.fromDate(new Date(msFromJd(e.jd0))), n = e.sun.length;
  await C.Transforms.preloadIcrfFixed(new C.TimeInterval({ start: t0, stop: C.JulianDate.addMinutes(t0, n, new C.JulianDate()) })).catch(() => {});
  const v = new C.Cartesian3(), M = new C.Matrix3();
  const rot = (row, t) => { const m = C.Transforms.computeIcrfToFixedMatrix(t, M) || C.Transforms.computeTemeToPseudoFixedMatrix(t, M); C.Matrix3.multiplyByVector(m, C.Cartesian3.fromArray(row, 0, v), v); return [v.x, v.y, v.z]; };
  e.fixed = { sun: [], moon: [] };
  for (let i = 0; i < n; i++) { const t = C.JulianDate.addMinutes(t0, i, new C.JulianDate()); e.fixed.sun.push(rot(e.sun[i], t)); e.fixed.moon.push(rot(e.moon[i], t)); }
  const at = m => ({ sun: interp(e.fixed.sun, m), moon: interp(e.fixed.moon, m) });
  e.at = at;
  // central line (every 20 s) and greatest eclipse (axis closest to Earth's centre)
  e.line = []; let best = null;
  for (let m = 0; m <= n - 1; m += 1 / 3) {
    const { sun, moon } = at(m), s = shadowCenter(sun, moon);
    if (s.center) e.line.push({ m, p: s.center, umbra: s.umbra });
    if (!best || s.miss < best.miss) best = { m, miss: s.miss, s };
  }
  e.greatest = best;
  if (best.s.center) {   // duration of the central phase at the greatest-eclipse point (1 s steps)
    let dur = 0; const obs = best.s.center;
    for (let m = best.m - 8; m <= best.m + 8; m += 1 / 60) { const { sun, moon } = at(m), w = seenFrom(sun, moon, obs); if (w.kind === 'total' || w.kind === 'annular') dur++; }
    e.duration = dur;
    e.width = 2 * Math.abs(best.s.umbra);
  }
  return e;
}

function clear() { for (const x of Ecl.ents) viewer.entities.remove(x); Ecl.ents = []; }

async function openList(date = '') {
  const card = $('#card'); hooks.clearSelection?.();
  card.innerHTML = '<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ffd27a">Solar eclipses · 2027–2030</div><h2>Eclipses</h2><p class="note" data-wait="ecl">Loading…</p>';
  card.classList.add('show'); card.querySelector('.x').onclick = close;
  let list; try { list = await load(); } catch (e) { const n = card.querySelector('[data-wait="ecl"]'); if (n) n.textContent = 'The eclipse data could not be loaded.'; return; }
  if (!card.querySelector('[data-wait="ecl"]') || !card.classList.contains('show')) return;   // another card opened, or Esc, while this loaded
  if (date) { const e = list.find(x => x.date === date); if (e) return watch(e); }
  const now = Date.now(), rows = list.filter(e => msFromJd(e.jd0 + e.sun.length / 1440) > now);
  card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ffd27a">Solar eclipses · 2027–2030</div><h2>Eclipses</h2>
    <p class="note">Sun and Moon from NASA JPL, every minute. Pick one to watch the Moon's shadow cross the Earth.</p>
    <div class="cjl">${rows.map((e, i) => `<button class="cj" data-i="${i}"><b style="color:#ffd27a">${esc(KIND[e.type])}</b><span>${esc(new Date(e.date + 'T12:00:00Z').toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }))}</span><small id="eh${i}">${Ecl.here ? '' : '&nbsp;'}</small></button>`).join('')}</div>
    <div class="acts"><button class="chipbtn" id="eclHere">From my location</button></div>`;
  card.querySelector('.x').onclick = close;
  card.querySelectorAll('.cj').forEach(b => { b.onclick = () => watch(rows[+b.dataset.i]); });
  $('#eclHere').onclick = () => fromHere(rows);
  if (Ecl.here) fromHere(rows);
}

/** For each eclipse: how much of the Sun is covered at the user's place (location stays on the device). */
async function fromHere(rows) {
  if (!Ecl.here) {
    const pos = await new Promise(res => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => res(p.coords), () => res(null), { timeout: 9000, maximumAge: 3600e3 }) : res(null));
    if (!pos) { toast('Location not available'); return; }
    const c = C.Cartesian3.fromDegrees(pos.longitude, pos.latitude, 0); Ecl.here = { x: c.x / 1000, y: c.y / 1000, z: c.z / 1000 };
  }
  for (const [i, e] of rows.entries()) {
    const el = $('#eh' + i); if (!el) continue; el.textContent = 'working…';
    const best = await bestFrom(e, Ecl.here);
    el.textContent = best.covered > 0.005 ? `From you: ${best.kind === 'total' ? 'TOTAL' : best.kind === 'annular' ? 'ring of fire' : Math.round(best.covered * 100) + '% covered'} · ${new Date(msFromJd(e.jd0 + best.m / 1440)).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}` : 'From you: not visible';
  }
}

/** The most of the Sun covered at an Earth-fixed point (km), with the minute it happens: { covered, kind, m, at (ms) }. */
async function bestFrom(e, here) {
  await prepare(e);
  let best = { covered: 0 };
  for (let m = 0; m < e.sun.length - 1; m += 1) { const { sun, moon } = e.at(m), w = seenFrom(sun, moon, here); if (w.sunUp && w.covered > best.covered) best = { ...w, m }; }
  best.at = best.m != null ? msFromJd(e.jd0 + best.m / 1440) : null;
  return best;
}
/** The next eclipse (2027-2030) that can be seen from lat/lon: { e, covered, kind, at } or null. */
async function nextFrom(lat, lon) {
  const c = C.Cartesian3.fromDegrees(lon, lat, 0), here = { x: c.x / 1000, y: c.y / 1000, z: c.z / 1000 }, now = Date.now();
  for (const e of (await load()).filter(e => msFromJd(e.jd0 + e.sun.length / 1440) > now)) {
    const b = await bestFrom(e, here); if (b.covered > 0.005) return { e, ...b };
  }
  return null;
}

async function watch(e) {
  clear(); release(); toast('Preparing the shadow…', 1500); hooks.clearSelection?.();
  const tok = ++Ecl.tok; await prepare(e); if (tok !== Ecl.tok) return;   // a second eclipse picked while this one prepared
  clear(); Ecl.active = e;
  const g = e.greatest, start = e.line.length ? e.line[0].m - 12 : g.m - 60;
  Time.setJd(e.jd0 + Math.max(0, start) / 1440, 60);   // a minute per second
  if (e.line.length > 1) {   // the path: a band as wide as the shadow at greatest eclipse
    Ecl.ents.push(viewer.entities.add({ corridor: { positions: e.line.map(x => toM(x.p)), width: Math.max(e.width || 100, 20) * 1000, material: C.Color.fromCssColorString(e.type === 'total' ? '#ffd27a' : '#ff9a5c').withAlpha(0.22), height: 2000 } }));
    Ecl.ents.push(viewer.entities.add({ polyline: { positions: e.line.map(x => toM(x.p)), width: 1.5, material: C.Color.fromCssColorString('#ffd27a').withAlpha(0.8), clampToGround: false } }));
  }
  const nowMin = () => (jdFromMs(Time.nowMs()) - e.jd0) * 1440, inWin = m => m >= 0 && m <= e.sun.length - 1;
  const ring = which => { const m = nowMin(); if (!inWin(m)) return []; const { sun, moon } = e.at(m); return outline(sun, moon, which, which === 'umbra' ? 48 : 160).map(toM); };
  Ecl.ents.push(viewer.entities.add({ polygon: { hierarchy: new C.CallbackProperty(() => new C.PolygonHierarchy(ring('umbra')), false), material: C.Color.BLACK.withAlpha(0.72), height: 3000 } }));
  Ecl.ents.push(viewer.entities.add({ polyline: { positions: new C.CallbackProperty(() => ring('penumbra'), false), width: 1.5, material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#ffd27a').withAlpha(0.7) }) } }));
  if (g.s.center) {
    const c = C.Cartographic.fromCartesian(toM(g.s.center));
    camera.flyTo({ destination: C.Cartesian3.fromRadians(c.longitude, c.latitude, 1.1e7), duration: 2.5 });
    Ecl.ents.push(viewer.entities.add({ position: toM(g.s.center), point: { pixelSize: 7, color: C.Color.fromCssColorString('#ffd27a') },
      label: { text: `Greatest eclipse · ${Math.floor(e.duration / 60)} min ${e.duration % 60} s`, font: '600 13px system-ui', fillColor: C.Color.fromCssColorString('#ffd27a'), pixelOffset: new C.Cartesian2(10, -10), showBackground: true, backgroundColor: C.Color.fromCssColorString('#05080caa'), horizontalOrigin: C.HorizontalOrigin.LEFT } }));
  }
  hud(true); clearInterval(Ecl.timer); Ecl.timer = setInterval(() => hud(false), 500);
}

function hud(first) {
  const e = Ecl.active; if (!e) return;
  const m = (jdFromMs(Time.nowMs()) - e.jd0) * 1440, inWin = m >= 0 && m <= e.sun.length - 1;
  let where = 'The Moon\'s shadow is off the Earth right now';
  if (inWin) { const { sun, moon } = e.at(m), s = shadowCenter(sun, moon); if (s.center) where = `Shadow centre over ${latlon(s.center)} · ${Math.round(2 * Math.abs(s.umbra))} km wide`; else where = 'Partial eclipse only (the shadow axis misses the Earth)'; }
  const g = e.greatest, card = $('#card');
  if (!first && !card.classList.contains('show')) { stop(true); return; }   // Esc closed the card: back to live time, no hidden card redrawn twice a second
  if (!first && !card.querySelector('[data-ecl]')) return;   // another card took over: the shadow keeps running, the card is theirs
  card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" data-ecl style="--c:#ffd27a">${esc(KIND[e.type])} solar eclipse</div><h2>${esc(new Date(e.date + 'T12:00:00Z').toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}</h2><dl>
    <dt>Now</dt><dd>${esc(fmtUtc(Time.nowMs()))}</dd><dt>Shadow</dt><dd>${esc(where)}</dd>
    ${g.s.center ? `<dt>Greatest</dt><dd>${esc(latlon(g.s.center))} · ${esc(fmtUtc(msFromJd(e.jd0 + g.m / 1440)))}</dd><dt>${e.type === 'annular' ? 'Ring of fire' : 'Totality'}</dt><dd>${Math.floor(e.duration / 60)} min ${e.duration % 60} s at greatest · shadow ~${Math.round(e.width)} km across</dd>` : ''}</dl>
    <p class="note">Sun and Moon from NASA JPL Horizons, minute by minute; the shadow is computed live. Black: where the Sun is fully covered; dashed: the edge of the partial eclipse.</p>
    <div class="acts"><button class="chipbtn" id="eclBack">All eclipses</button><button class="chipbtn" id="eclLive">Back to live</button></div>`;
  if (first) card.classList.add('show');
  card.querySelector('.x').onclick = close; $('#eclBack').onclick = () => { stop(false); openList(); }; $('#eclLive').onclick = close;
}

function stop(live = true) { clearInterval(Ecl.timer); clear(); Ecl.active = null; if (live) Time.goLive(); }
function close() { stop(true); $('#card').classList.remove('show'); }

export const Eclipses = { openList, watch, prepare, load, close, nextFrom, state: Ecl };
