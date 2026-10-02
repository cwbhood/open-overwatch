// capture.mjs — record smooth vertical (1080x1920, 30 fps) PNG sequences of the live Open Overwatch map,
// and render transparent caption/end-card PNGs. Node 22+, no packages; drives headless Edge through cdp.mjs.
//
//   node capture.mjs                       record every shot in SHOT_ORDER into <WORK>/footage/<id>/frame_#####.png
//   node capture.mjs --shots=mil,space     record a subset (the manifest keeps the other shots' entries)
//   node capture.mjs --card-test           render a test caption card and check that the PNG has alpha
//   node capture.mjs --probe               load the app, wait for feeds, print a data snapshot, record nothing
//   options: --iss-wait=MIN (space: max wait for a view clear of the antimeridian, default 40), --radar-off (hazards)
//   env OW_WORK overrides the working folder (temp Edge profiles, footage/, cache/, cards/). Needs serve.js on :8787.
//   Each shot writes frame_#####.png (1080x1920, 30 fps) + frames.json (per-frame view and timing); manifest.json
//   holds the live counts per shot for captions, feed states, timing stats, privacy checks and per-run network hosts.
//
// How it stays smooth: the camera is moved by FRAME STEPPING, not by recording real time. For every output frame
// the page clock (Date) is set to t0 + i/30 s, the map is placed with setView(center, fractionalZoom), the tool waits
// until every visible tile has loaded, redraws the glyph canvas, and only then takes the screenshot. Dead-reckoned
// aircraft, satellites and CSS animations therefore move at true real-time speed in the footage, however long a
// frame takes to produce. Feeds are paused while a shot records, so no data refresh lands mid-shot.
//
// Privacy (hard rules): never the 'me' preset, the '1' key, Center-on-me, Locate.* or anything that reaches
// navigator.geolocation or ipapi.co (geolocation is stubbed to fail and counted, ipapi.co + planespotters are
// blocked at the network layer, the Browser permission is denied). The Setup tab is never opened, no aircraft
// is ever selected (so no Planespotters photo), cameras stay off, news stays off.
//
// Rate limits: one app instance per run (one page load), shots are recorded back to back in that page.

import { launch, sleep, WORK } from './cdp.mjs';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

export const APP_ORIGIN = 'http://localhost:8787';
export const APP_URL = APP_ORIGIN + '/open-overwatch.html';
export const FOOTAGE = path.join(WORK, 'footage');
const CACHE = path.join(WORK, 'cache');
export const FPS = 30, CSS_W = 540, CSS_H = 960, DSF = 2;

const LAYER_IDS = ['air_local', 'air_mil', 'air_emg', 'air_opensky', 'sats', 'quakes', 'events', 'gdacs', 'storms', 'news', 'nws', 'aurora', 'radar', 'irsat', 'terminator', 'cables', 'landing', 'cams', 'ships_fi', 'ships_ws', 'balloons', 'fires', 'osm_scan'];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ PNG inspection (alpha check) */
export function pngInfo(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    off += 12 + len;
  }
  const hasAlphaChannel = colorType === 6 || colorType === 4;
  const info = { width, height, bitDepth, colorType, hasAlphaChannel };
  if (!hasAlphaChannel || bitDepth !== 8 || interlace) return info;
  const ch = colorType === 6 ? 4 : 2, bpp = ch, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++], row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[prev + x] : 0, c = (x >= bpp && y) ? out[prev + x - bpp] : 0; let v = raw[p++];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : pb <= pc ? b : c; }
      out[row + x] = v & 255;
    }
  }
  let transparent = 0, opaque = 0; const n = width * height;
  for (let i = ch - 1; i < out.length; i += ch) { if (out[i] === 0) transparent++; else if (out[i] === 255) opaque++; }
  return { ...info, transparentPct: +(100 * transparent / n).toFixed(2), opaquePct: +(100 * opaque / n).toFixed(2), partialPct: +(100 * (n - transparent - opaque) / n).toFixed(2) };
}

/* ------------------------------------------------------------------ transparent caption / end cards */
/**
 * Render a local HTML file to a PNG with a transparent background (the HTML must not paint a body background).
 * Waits for document.fonts.ready. Output is width x height pixels (opts.scale = device pixel ratio, default 1).
 * Pass opts.browser to reuse an already-launched browser; otherwise one is launched and closed.
 */
export async function snapCard(htmlPath, outPng, width, height, opts = {}) {
  const { browser = null, scale = 1, settleMs = 150, timeoutMs = 45000 } = opts;
  const own = !browser; const b = browser || await launch({ windowSize: [Math.round(width / scale), Math.round(height / scale)] });
  try {
    const page = await b.newPage();
    await page.send('Page.enable'); await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: Math.round(width / scale), height: Math.round(height / scale), deviceScaleFactor: scale, mobile: false });
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const loaded = page.waitFor('Page.loadEventFired', { timeoutMs });
    await page.send('Page.navigate', { url: pathToFileURL(path.resolve(htmlPath)).href });
    await loaded;
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const fonts = await page.eval(`document.fonts.ready.then(() => [...document.fonts].map(f => ({ family: f.family.replace(/"/g, ''), weight: f.weight, status: f.status })).filter(f => f.status !== 'unloaded'))`, { timeoutMs });
    await page.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    if (settleMs) await sleep(settleMs);
    const png = await page.screenshotPng({ optimizeForSpeed: false });
    await mkdir(path.dirname(path.resolve(outPng)), { recursive: true });
    await writeFile(outPng, png);
    await page.close();
    return { outPng: path.resolve(outPng), fonts, ...pngInfo(png) };
  } finally { if (own) await b.close(); }
}

async function cardTest() {
  const dir = path.join(WORK, 'cards'); await mkdir(dir, { recursive: true });
  const html = path.join(dir, 'card-test.html'), png = path.join(dir, 'card-test.png');
  await writeFile(html, `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&display=block">
<style>html,body{margin:0;background:transparent;width:1080px;height:1920px;overflow:hidden}
.cap{position:absolute;left:72px;right:72px;top:1180px;font:900 168px/0.9 "Big Shoulders Display",sans-serif;letter-spacing:.01em;text-transform:uppercase;color:#e6edf3;text-shadow:0 6px 30px rgba(0,0,0,.55)}
.cap b{color:#5fd3ff;font-weight:900} .sub{display:block;margin-top:22px;font-size:64px;letter-spacing:.06em;color:#7dffa6}</style></head>
<body><div class="cap"><b>9,812</b> aircraft<span class="sub">live, right now</span></div></body></html>`);
  const r = await snapCard(html, png, 1080, 1920);
  const bigShoulders = r.fonts.find(f => /Big Shoulders Display/i.test(f.family) && String(f.weight) === '900' && f.status === 'loaded');
  const ok = r.width === 1080 && r.height === 1920 && r.hasAlphaChannel && r.transparentPct > 50 && r.opaquePct > 0.5 && !!bigShoulders;
  log(`card test: ${ok ? 'PASS' : 'FAIL'} ${png} · ${r.width}x${r.height} colorType ${r.colorType} · transparent ${r.transparentPct}% opaque ${r.opaquePct}% partial ${r.partialPct}% · Big Shoulders 900 ${bigShoulders ? 'loaded' : 'NOT loaded'}`);
  return { ...r, ok, html };
}

/* ------------------------------------------------------------------ in-page code */
function initScript(seed) {
  return `(() => {
  if (location.origin !== ${JSON.stringify(APP_ORIGIN)}) return;
  const seed = ${JSON.stringify(seed)};
  try { for (const k of Object.keys(seed)) localStorage.setItem(k, seed[k]); } catch (e) {}
  // privacy guard: geolocation always fails (and is counted); the capture never asks for it in the first place
  window.__capGeo = 0;
  try { const g = navigator.geolocation; if (g) { const deny = (ok, err) => { window.__capGeo++; if (typeof err === 'function') setTimeout(() => { try { err({ code: 1, PERMISSION_DENIED: 1, message: 'blocked by the capture tool' }); } catch (e) {} }, 0); return 0; };
    Object.defineProperty(g, 'getCurrentPosition', { value: deny, configurable: true }); Object.defineProperty(g, 'watchPosition', { value: deny, configurable: true }); } } catch (e) {}
  // virtual clock: null = real time; during a shot the tool sets it per frame (t0 + i/fps)
  const RealDate = Date; let vt = null;
  function CapDate(...a) { if (!new.target) return RealDate(); return a.length ? new RealDate(...a) : new RealDate(vt == null ? RealDate.now() : vt); }
  CapDate.prototype = RealDate.prototype; CapDate.now = () => (vt == null ? RealDate.now() : vt); CapDate.parse = RealDate.parse; CapDate.UTC = RealDate.UTC;
  window.Date = CapDate;
  window.__capClock = { set(t) { vt = t; }, clear() { vt = null; }, get() { return vt; }, real() { return RealDate.now(); } };
})();`;
}

// Injected after the app has booted (stringified; never runs in Node).
function pageHelper() {
  if (window.__cap) return true;
  const OW = window.OW, map = OW.map;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const raf = () => new Promise(r => requestAnimationFrame(() => r()));
  const st = { tileErrors: 0, errSamples: [], seen: new WeakSet(), viewSetAt: 0, anims: null, animT0: 0 };
  const grid = () => { const out = []; map.eachLayer(l => { if (l instanceof L.GridLayer) out.push(l); }); return out; };
  const instrument = () => { for (const l of grid()) if (!st.seen.has(l)) { st.seen.add(l); l.on('tileerror', e => { st.tileErrors++; if (st.errSamples.length < 12) st.errSamples.push(String((e.tile && e.tile.src) || '').slice(0, 200)); }); } };
  const busy = () => grid().some(l => l._map && l.isLoading && l.isLoading());
  const inB = (b, lat, lon) => lat != null && (b.contains([lat, lon]) || b.contains([lat, lon + 360]) || b.contains([lat, lon - 360]));
  const missing = () => { let n = 0; const vp = map.getContainer().getBoundingClientRect(); for (const img of map.getContainer().querySelectorAll('img.leaflet-tile')) { if (img.classList.contains('leaflet-tile-loaded')) continue; const r = img.getBoundingClientRect(); if (r.right <= vp.left + 1 || r.left >= vp.right - 1 || r.bottom <= vp.top + 1 || r.top >= vp.bottom - 1) continue; n++; } return n; };

  // capture-only presentation tweaks (the app file is never edited)
  const css = document.createElement('style'); css.id = 'cap-css';
  css.textContent = `
    #splash, #welcome, #toast, #hovertip, #audioPop { display: none !important; }
    html.cap-full #top, html.cap-full #mobilebar, html.cap-full .leaflet-control-zoom, html.cap-full #rail, html.cap-full #panel { display: none !important; }
    html.cap-full #hud, html.cap-full .leaflet-control-scale { display: none !important; } /* they overlap each other bottom-left on the phone layout */
    .leaflet-control-attribution { display: block !important; visibility: visible !important; }`;
  document.head.appendChild(css);
  // no 200 ms tile fade (it runs on Date and would freeze under the virtual clock), sub-pixel tile transforms
  map._fadeAnimated = false; map.options.zoomSnap = 0; map.options.zoomDelta = 0.25;
  L.GridLayer.prototype._setZoomTransform = function (level, center, zoom) {
    const scale = this._map.getZoomScale(zoom, level.zoom), translate = level.origin.multiplyBy(scale).subtract(this._map._getNewPixelOrigin(center, zoom));
    if (L.Browser.any3d) L.DomUtil.setTransform(level.el, translate, scale); else L.DomUtil.setPosition(level.el, translate);
  };

  const feedsOf = () => { const f = {}; for (const d of OW.Layers.defs) if (d.feed) f[d.id] = { on: !!d.on, status: d.on ? d.feed.status : 'off', count: d.feed.count || 0, err: d.feed.err || '', lastOk: d.feed.lastOk || 0, running: !!d.feed.running }; return f; };
  const cap = {
    mode(m) {
      document.documentElement.classList.toggle('cap-full', m === 'full'); document.documentElement.classList.toggle('cap-ui', m === 'ui');
      OW.openSheet('none'); cap.liftAttribution(); map.invalidateSize({ pan: false }); const s = map.getSize(); return [s.x, s.y];
    },
    layers(ids) { OW.Layers.apply(ids); return cap.on(); },
    preset(id) { if (id === 'me') throw new Error('the "me" preset is never used by the capture tool'); OW.Presets.apply(id, { fly: false }); return cap.on(); },
    set(id, on) { OW.Layers.set(id, on); return cap.on(); },
    on() { return OW.Layers.defs.filter(d => d.on).map(d => d.id); },
    view(lat, lon, z) { map.setView([lat, lon], z, { animate: false }); st.viewSetAt = Date.now(); return st.viewSetAt; },
    pause(p) { OW.Feeds.paused = !!p; return OW.Feeds.list.filter(f => f.running).map(f => f.id); },
    running() { return OW.Feeds.list.filter(f => f.running).map(f => f.id); },
    snapshot() {
      const b = map.getBounds(); const a = { total: 0, airborne: 0, mil: 0, milAirborne: 0, emg: 0, opensky: 0, adsb: 0, inView: 0, inViewAirborne: 0, inViewMil: 0, inViewOpensky: 0 };
      for (const x of OW.Dyn.air.values()) {
        if (x.lat == null) continue; a.total++; if (!x.ground) a.airborne++; if (x.mil) { a.mil++; if (!x.ground) a.milAirborne++; } if (x.emerg) a.emg++; if (x.src === 'opensky') a.opensky++; else a.adsb++;
        if (inB(b, x.lat, x.lon)) { a.inView++; if (!x.ground) a.inViewAirborne++; if (x.mil) a.inViewMil++; if (x.src === 'opensky') a.inViewOpensky++; }
      }
      const sats = OW.Dyn.sats.filter(s => s.lat != null), iss = OW.Sats.iss(), W = OW.World;
      const chip = id => { const el = document.querySelector('#' + id + ' b'); return el ? el.textContent : null; };
      const c = map.getCenter(), sz = map.getSize();
      return {
        t: Date.now(), viewSetAt: st.viewSetAt, view: { lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), z: +map.getZoom().toFixed(3), size: [sz.x, sz.y] },
        feeds: feedsOf(), air: a,
        sats: { loaded: OW.Dyn.sats.length, propagated: sats.length, inView: sats.filter(s => inB(b, s.lat, s.lon)).length, ready: !!OW.Sats.ready, iss: iss && iss.lat != null ? { name: iss.name, lat: +iss.lat.toFixed(2), lon: +iss.lon.toFixed(2), alt_km: Math.round(iss.alt || 0), speed_kmh: Math.round((iss.vel || 0) * 3600) } : null },
        world: {
          quakes: W.quakes.length, quakesM45: W.quakes.filter(q => q.mag >= 4.5).length, maxQuake: W.quakes.length ? W.quakes.reduce((m, q) => (q.mag > m.mag ? q : m)) : null,
          quakesInView: W.quakes.filter(q => inB(b, q.lat, q.lon)).length,
          storms: W.storms.map(s => ({ title: s.title, kt: s.kt || null, lat: +s.lat.toFixed(1), lon: +s.lon.toFixed(1), inView: inB(b, s.lat, s.lon) })),
          gdacs: W.gdacs.length, gdacsOrangeRed: W.gdacs.filter(g => g.alertlevel === 'Orange' || g.alertlevel === 'Red').length, gdacsInView: W.gdacs.filter(g => inB(b, g.lat, g.lon)).length,
          nws: (W.nws || []).length, events: W.events.length, eventsInView: W.events.filter(e => inB(b, e.lat, e.lon)).length,
        },
        chips: { air: chip('chipAir'), mil: chip('chipMil'), sat: chip('chipSat'), kp: chip('chipKp'), sqk: chip('chipEmg') },
        splashDone: !!OW.Splash.done, splashVisible: getComputedStyle(document.querySelector('#splash')).display !== 'none', welcomeVisible: getComputedStyle(document.querySelector('#welcome')).display !== 'none',
        relay: !!OW.Relay.available, paused: !!OW.Feeds.paused, on: cap.on(),
        logErrors: [...document.querySelectorAll('#log .row.error .m, #log .row.alert .m')].slice(0, 8).map(e => e.textContent.slice(0, 160)),
      };
    },
    beginClock(t0) {
      st.animT0 = t0;
      st.anims = document.getAnimations().filter(a => typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation).map(a => { const base = a.currentTime || 0; a.pause(); return { a, base }; });
      return st.anims.length;
    },
    endClock() { window.__capClock.clear(); if (st.anims) for (const { a } of st.anims) { try { a.play(); } catch (e) { } } st.anims = null; return true; },
    async frame(lat, lon, z, vt, o = {}) {
      const T = performance.now(), tileTimeout = o.tileTimeoutMs || 4000;
      window.__capClock.set(vt);
      if (st.anims) for (const x of st.anims) { try { x.a.currentTime = x.base + (vt - st.animT0); } catch (e) { } }
      map.setView([lat, lon], z, { animate: false });
      // Leaflet rounds the pixel origin and pans in whole CSS px; shift the map pane by the sub-pixel remainder so slow pans glide
      const want = map.project([lat, lon], z), have = map._getCenterLayerPoint().add(map.getPixelOrigin()), d = want.subtract(have);
      if (Math.abs(d.x) > 1e-4 || Math.abs(d.y) > 1e-4) map._rawPanBy(d);
      instrument(); await raf();
      const t1 = performance.now(); let timedOut = false;
      while (busy()) { if (performance.now() - t1 > tileTimeout) { timedOut = true; break; } await sleep(15); }
      const tileMs = performance.now() - t1;
      if (OW.Layers.on('sats') && OW.Sats.ready) { OW.Sats.prop(true); const s0 = performance.now(); while (OW.Sats.propBusy && performance.now() - s0 < 1500) await sleep(4); }
      OW.glyphs._reset(); // reposition + redraw the glyph canvas at this exact view and virtual time
      await raf(); await raf();
      return { tileMs: Math.round(tileMs), timedOut, missing: missing(), pageMs: Math.round(performance.now() - T) };
    },
    async settleTiles(timeoutMs = 15000) { instrument(); const t0 = performance.now(); await raf(); while (busy() && performance.now() - t0 < timeoutMs) await sleep(50); return { busy: busy(), missing: missing(), ms: Math.round(performance.now() - t0) }; },
    densest(points, z, o = {}) {
      const size = map.getSize(), W = (o.W || size.x) * 0.9, H = (o.H || size.y) * 0.9, step = o.step || 2, worldPx = 256 * Math.pow(2, z);
      const pp = points.map(([la, lo, w]) => { const p = map.project([la, lo], z); return [p.x, p.y, w]; });
      const lat0 = o.within ? o.within.s : (o.latMin ?? -55), lat1 = o.within ? o.within.n : (o.latMax ?? 70), lon0 = o.within ? o.within.w : -180, lon1 = o.within ? o.within.e : 180;
      let best = null;
      for (let la = lat0; la <= lat1 + 1e-9; la += step) for (let lo = lon0; lo <= lon1 + 1e-9; lo += step) {
        const c = map.project([la, lo], z); let s = 0, n = 0;
        for (const [x, y, w] of pp) { let dx = x - c.x; if (dx > worldPx / 2) dx -= worldPx; else if (dx < -worldPx / 2) dx += worldPx; const ax = Math.abs(dx) / (W / 2), ay = Math.abs(y - c.y) / (H / 2); if (ax < 1 && ay < 1) { s += w * (1 - 0.35 * Math.max(ax, ay)); n++; } }
        if (!best || s > best.score) best = { lat: +la.toFixed(3), lon: +lo.toFixed(3), score: +s.toFixed(2), n };
      }
      return best;
    },
    milPoints() { const out = []; for (const a of OW.Dyn.air.values()) if (a.mil && !a.ground && a.lat != null) out.push([a.lat, a.lon, 1]); return out; },
    hazardPoints() {
      const W = OW.World, out = [];
      for (const q of W.quakes) out.push([q.lat, q.lon, q.mag >= 4.5 ? 2 : 0.6]);
      for (const s of W.storms) out.push([s.lat, s.lon, 8]);
      for (const g of W.gdacs) out.push([g.lat, g.lon, g.alertlevel === 'Red' ? 6 : g.alertlevel === 'Orange' ? 3 : 0.7]);
      for (const e of W.events) out.push([e.lat, e.lon, 0.5]);
      map.eachLayer(l => { if (l instanceof L.Polygon && l.options && l.options.fillColor && l.options.fillColor !== '#000') { try { const c = l.getBounds().getCenter(); out.push([c.lat, c.lng, 0.8]); } catch (e) { } } });
      return out;
    },
    issTrack(secs) { // sub-points of the ISS at now + each offset (seconds)
      const iss = OW.Sats.iss(); if (!iss || !iss.l1) return null; const sr = satellite.twoline2satrec(iss.l1, iss.l2), now = Date.now();
      return { id: iss.id, name: iss.name, pts: secs.map(dt => { const d = new Date(now + dt * 1000), pv = satellite.propagate(sr, d), g = satellite.eciToGeodetic(pv.position, satellite.gstime(d)); return [g.latitude * 180 / Math.PI, g.longitude * 180 / Math.PI]; }) };
    },
    selectSat(id) { // select without Detail.show (which would open the Intel sheet over the map)
      const s = OW.Sats.byId.get(id) || OW.Sats.iss(); if (!s) return null; OW.Sel.kind = 'sat'; OW.Sel.obj = s; OW.Sel.id = s.id;
      OW.Layers.setOpt('sat_tracks', true); OW.Sats.drawTrack(s); OW.glyphs.draw(); return s.name;
    },
    clearSel() { OW.Sel.kind = null; OW.Sel.obj = null; OW.Sel.id = null; OW.Tracks.clear(); OW.glyphs.draw(); return true; },
    openBrief() { OW.openSheet('panel'); OW.showTab('brief'); cap.liftAttribution(); return true; },
    closeSheets() { OW.openSheet('none'); cap.liftAttribution(); return true; },
    liftAttribution() { // keep the map attribution visible above the Intel sheet (license requirement)
      const el = map.getContainer().querySelector('.leaflet-bottom.leaflet-right'), p = document.querySelector('#panel'); if (!el) return 0;
      const open = p && !p.classList.contains('hidden') && getComputedStyle(p).display !== 'none'; const h = open ? Math.round(p.getBoundingClientRect().height) : 0;
      el.style.bottom = h ? h + 'px' : ''; return h;
    },
    attribution() { const el = map.getContainer().querySelector('.leaflet-control-attribution'); if (!el) return null; const r = el.getBoundingClientRect(); return { text: el.textContent.trim(), visible: r.width > 0 && r.height > 0 && r.bottom <= innerHeight && r.right <= innerWidth && getComputedStyle(el).visibility !== 'hidden' }; },
    tileStats() { return { errors: st.tileErrors, samples: st.errSamples.slice() }; },
    resetTileStats() { st.tileErrors = 0; st.errSamples = []; return true; },
    privacy() {
      return { geoAttempts: window.__capGeo || 0, locatePos: !!OW.Locate.pos, setupTabOpen: !!document.querySelector('#tab-setup.on'), selectedKind: OW.Sel.kind,
        photoLookups: OW.Photos.cache.size + OW.Photos.pending.size, detailImages: document.querySelectorAll('#detail img, .leaflet-popup img').length, camsOn: OW.Layers.on('cams'), newsOn: OW.Layers.on('news') };
    },
    tleCache() { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('ow.tle.')) o[k] = localStorage.getItem(k); } return o; },
  };
  window.__cap = cap; return true;
}

/* ------------------------------------------------------------------ camera paths */
const EASE = {
  linear: t => t,
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  inOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outSine: t => Math.sin(t * Math.PI / 2),
};
const proj = (lat, lon) => { const s = Math.sin(lat * Math.PI / 180); return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]; };
const unproj = (x, y) => [Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI, x * 360 - 180];
/** Zoom is linear in eased time; the destination point glides to screen centre at a steady eased rate while the zoom changes. */
export function pathAt(from, to, e) {
  const z = from.z + (to.z - from.z) * e;
  const P = proj(to.lat, to.lon), C0 = proj(from.lat, from.lon), k = Math.pow(2, from.z - z) * (1 - e);
  const [lat, lon] = unproj(P[0] - (P[0] - C0[0]) * k, P[1] - (P[1] - C0[1]) * k);
  return { lat, lon, z };
}
const unwrapTo = (from, to) => { let lon = to.lon; while (lon - from.lon > 180) lon -= 360; while (lon - from.lon < -180) lon += 360; return { ...to, lon }; };

/* ------------------------------------------------------------------ shots */
const ok = (f) => f && f.status === 'ok';
const settled = (f) => f && (f.status === 'ok' || f.status === 'error');
export const SHOT_ORDER = ['air_world', 'air_dense', 'mil', 'space', 'hazards', 'ui'];
export const SHOTS = {
  air_world: {
    title: 'Every aircraft on Earth', seconds: 4.5, mode: 'full', ease: 'inOutSine',
    setup: { layers: ['air_opensky', 'air_mil', 'air_emg', 'air_local', 'terminator'] },
    // two completed sweep passes: during the first pass the app prunes civil records after 75 s (AirSweep.passMs is still 0),
    // so when a pass is slow (one aggregator rate-limited) the first tiles near the centre would be missing
    warm: { lat: 50, lon: 4, z: 4.5 }, maxWaitS: 240, minWaitS: 5,
    ready: (s, c) => ({ ok: ok(s.feeds.air_opensky) && s.feeds.air_opensky.count > 2000 && ok(s.feeds.air_mil) && ok(s.feeds.air_local) && c.passes('air_local') >= 2,
      why: `opensky ${s.feeds.air_opensky.status} ${s.feeds.air_opensky.count} ${s.feeds.air_opensky.err} · sweep ${s.feeds.air_local.status} ${c.passes('air_local')}/2 passes · mil ${s.feeds.air_mil.status} ${s.feeds.air_mil.count}`,
      retry: s.feeds.air_opensky.status === 'error' ? 'air_opensky' : null }),
    path: async () => ({ from: { lat: 38, lon: -24, z: 2.3 }, to: { lat: 50, lon: 4, z: 4.5 } }),
    facts: (a, b) => ({ aircraft_tracked: a.air.total, aircraft_airborne: a.air.airborne, opensky_snapshot: a.feeds.air_opensky.count, military: a.air.mil, in_view_first_frame: a.air.inView, in_view_last_frame: b.air.inView }),
  },
  air_dense: {
    title: 'Dense airspace close-up', seconds: 4, mode: 'full', ease: 'inOutSine',
    setup: { layers: ['air_local', 'air_mil', 'air_emg', 'terminator'] },
    warm: { lat: 51.55, lon: 0.55, z: 7.0 }, maxWaitS: 75, minWaitS: 3,
    ready: s => ({ ok: ok(s.feeds.air_local) && s.feeds.air_local.lastOk > s.viewSetAt && s.air.inView >= 60, why: `sweep ${s.feeds.air_local.status} ${s.feeds.air_local.lastOk > s.viewSetAt ? 'pass done' : 'pass pending'} · ${s.air.inView} in view` }),
    path: async () => ({ from: { lat: 51.42, lon: 0.0, z: 7.0 }, to: { lat: 51.62, lon: 0.95, z: 7.4 } }),
    facts: (a, b) => ({ aircraft_in_view_first_frame: a.air.inView, airborne_in_view_first_frame: a.air.inViewAirborne, aircraft_in_view_last_frame: b.air.inView, aircraft_tracked: a.air.total }),
  },
  mil: {
    title: 'Military air picture', seconds: 4, mode: 'full', ease: 'inOutSine',
    setup: { preset: 'mil', off: ['air_local'] },
    warm: { lat: 40, lon: 20, z: 3 }, maxWaitS: 60, minWaitS: 3,
    ready: s => ({ ok: ok(s.feeds.air_mil) && s.air.milAirborne >= 40, why: `mil ${s.feeds.air_mil.status} ${s.feeds.air_mil.count} · ${s.air.milAirborne} airborne` }),
    path: async (page) => {
      const a = await page.eval(`__cap.densest(__cap.milPoints(), 3.3, { step: 2 })`);
      const b = await page.eval(`__cap.densest(__cap.milPoints(), 3.9, { step: 0.5, within: { s: ${a.lat - 6}, n: ${a.lat + 6}, w: ${a.lon - 8}, e: ${a.lon + 8} } })`);
      return { from: { lat: a.lat, lon: a.lon, z: 3.3 }, to: { lat: b.lat, lon: b.lon, z: 3.9 }, auto: { start: a, end: b } };
    },
    facts: (a, b) => ({ military_airborne_worldwide: a.air.milAirborne, military_tracked_worldwide: a.air.mil, military_in_view_first_frame: a.air.inViewMil, military_in_view_last_frame: b.air.inViewMil, emergency_squawks: a.air.emg }),
  },
  space: {
    title: 'Space: ISS ground track', seconds: 4.5, mode: 'full', ease: 'inOutSine',
    setup: { preset: 'space' },
    warm: { lat: 20, lon: 0, z: 2.6 }, maxWaitS: 90, minWaitS: 3,
    ready: s => ({ ok: ok(s.feeds.sats) && s.sats.propagated >= 100 && !!s.sats.iss && settled(s.feeds.aurora), why: `sats ${s.feeds.sats.status} ${s.sats.propagated}/${s.sats.loaded} · iss ${s.sats.iss ? 'ok' : 'pending'} · aurora ${s.feeds.aurora.status}` }),
    path: async (page, s, opts = {}) => {
      // The app's Sats.drawTrack splits the ground track at ±180° and never redraws it on the visible world copy, so a
      // window that contains the antimeridian shows the track stopping mid-ocean. Wait (up to --iss-wait minutes) for the
      // moment the camera window is clear of ±180° instead of altering how the app draws.
      const z0 = 2.6, z1 = 2.85, halfW = (CSS_W / (256 * Math.pow(2, z0))) * 180 + 6, step = 30, maxS = Math.round((opts.issWaitMin ?? 40) * 60);
      const clear = (a, b) => { const lo = Math.min(a, b) - halfW, hi = Math.max(a, b) + halfW; return lo > -180 && hi < 180; };
      const offs = []; for (let t = -60; t <= maxS + 150; t += step) offs.push(t);
      const scan = await page.eval(`__cap.issTrack(${JSON.stringify(offs)})`); if (!scan) throw new Error('ISS not available');
      const lonAt = t => scan.pts[offs.indexOf(t)][1];
      let waitS = null; for (let dt = 0; dt <= maxS; dt += step) { const a = lonAt(dt - 60), b = unwrapTo({ lon: a }, { lon: lonAt(dt + 150) }).lon; if (clear(a, b)) { waitS = dt; break; } }
      if (waitS == null) log(`  [space] the antimeridian stays in view for the next ${maxS / 60} min; recording anyway (track will be cut at ±180°)`);
      else if (waitS > 0) { log(`  [space] ISS window crosses ±180° now; waiting ${(waitS / 60).toFixed(1)} min for a clean ground track`); await sleep(waitS * 1000); }
      const tr = await page.eval(`__cap.issTrack([-60, 150])`);
      await page.eval(`__cap.selectSat(${tr.id})`);
      const from = { lat: tr.pts[0][0], lon: tr.pts[0][1], z: z0 }, to = unwrapTo(from, { lat: tr.pts[1][0], lon: tr.pts[1][1], z: z1 });
      return { from, to, auto: { selected: tr.name, waited_for_clean_track_s: waitS ?? 0, antimeridian_in_view: waitS == null } };
    },
    cleanup: page => page.eval('__cap.clearSel()'),
    facts: (a, b) => ({ satellites_propagated: a.sats.propagated, satellites_loaded: a.sats.loaded, satellites_in_view_first_frame: a.sats.inView, iss: a.sats.iss, aurora_cells_20pct: a.feeds.aurora.count }),
  },
  hazards: {
    title: 'Storms & quakes', seconds: 4, mode: 'full', ease: 'inOutSine',
    setup: { preset: 'hazards' },
    warm: { lat: 20, lon: -40, z: 3 }, maxWaitS: 90, minWaitS: 5,
    ready: s => { const ids = ['quakes', 'storms', 'nws', 'gdacs', 'events', 'radar']; return { ok: ids.every(i => settled(s.feeds[i])) && ok(s.feeds.quakes), why: ids.map(i => `${i} ${s.feeds[i].status}${s.feeds[i].status === 'error' ? ' (' + s.feeds[i].err + ')' : ''}`).join(' · ') }; },
    path: async (page) => {
      const a = await page.eval(`__cap.densest(__cap.hazardPoints(), 3.2, { step: 2 })`);
      const b = await page.eval(`__cap.densest(__cap.hazardPoints(), 3.8, { step: 0.5, within: { s: ${a.lat - 6}, n: ${a.lat + 6}, w: ${a.lon - 8}, e: ${a.lon + 8} } })`);
      return { from: { lat: a.lat, lon: a.lon, z: 3.2 }, to: { lat: b.lat, lon: b.lon, z: 3.8 }, auto: { start: a, end: b } };
    },
    facts: (a, b) => ({ quakes_24h_m25: a.world.quakes, quakes_24h_m45: a.world.quakesM45, largest_quake: a.world.maxQuake ? { mag: a.world.maxQuake.mag, place: a.world.maxQuake.place, time: a.world.maxQuake.time } : null,
      storms: a.world.storms, gdacs_alerts: a.world.gdacs, gdacs_orange_red: a.world.gdacsOrangeRed, nws_severe_extreme: a.world.nws, quakes_in_view_first_frame: a.world.quakesInView, gdacs_in_view_first_frame: a.world.gdacsInView }),
  },
  ui: {
    title: 'The real phone UI', seconds: 4, mode: 'ui', ease: 'inOutSine',
    setup: { layers: ['air_local', 'air_mil', 'air_emg', 'sats', 'quakes', 'storms', 'terminator'] },
    warm: { lat: 50.7, lon: 4.6, z: 5.4 }, maxWaitS: 80, minWaitS: 3,
    ready: s => ({ ok: ok(s.feeds.air_local) && s.feeds.air_local.lastOk > s.viewSetAt && s.air.inView >= 150 && ok(s.feeds.air_mil) && ok(s.feeds.sats) && s.sats.propagated > 50, why: `sweep ${s.feeds.air_local.status} ${s.feeds.air_local.lastOk > s.viewSetAt ? 'pass done' : 'pass pending'} · ${s.air.inView} in view · mil ${s.feeds.air_mil.status} · sats ${s.feeds.sats.status}` }),
    path: async () => ({ from: { lat: 50.7, lon: 4.25, z: 5.4 }, to: { lat: 50.75, lon: 4.95, z: 5.45 } }),
    events: [{ at: 0.5, js: '__cap.openBrief()', label: 'open Intel sheet, Brief tab' }],
    cleanup: page => page.eval('__cap.closeSheets()'),
    facts: (a, b) => ({ header_chips: b.chips, aircraft_in_view_first_frame: a.air.inView, aircraft_tracked: a.air.total }),
  },
};

/* ------------------------------------------------------------------ app session */
async function readJson(file, dflt) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { return dflt; } }

export async function openApp(browser, { firstShot }) {
  const page = await browser.newPage();
  const net = { hosts: {}, blocked: {}, privacyHits: [] };
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => page.send('Network.enable'));
  await page.send('Network.setBlockedURLs', { urls: ['*ipapi.co*', '*api.planespotters.net*', '*planespotters.net/photo*'] });
  page.on('Network.requestWillBeSent', p => {
    let host = '?'; try { const u = new URL(p.request.url); host = u.host; if (u.pathname === '/proxy' && u.searchParams.get('url')) host = 'relay>' + new URL(u.searchParams.get('url')).host; } catch (e) { }
    net.hosts[host] = (net.hosts[host] || 0) + 1; if (/ipapi\.co|planespotters/.test(host)) net.privacyHits.push(host);
  });
  page.on('Network.loadingFailed', p => { if (p.blockedReason) net.blocked[p.blockedReason] = (net.blocked[p.blockedReason] || 0) + 1; });
  await browser.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: APP_ORIGIN }).catch(e => log('setPermission failed (non-fatal):', e.message));
  await page.send('Emulation.setDeviceMetricsOverride', { width: CSS_W, height: CSS_H, deviceScaleFactor: DSF, mobile: true, screenWidth: CSS_W, screenHeight: CSS_H });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { });
  await page.send('Page.bringToFront').catch(() => { });

  // localStorage seed: no welcome dialog, no music, the first shot's layers + view, cached TLEs (CelesTrak allows one download per 2 h)
  const seed = { 'ow.welcomed': 'true', 'ow.music_auto': 'false', 'ow.sound': 'false', 'ow.basemap': '"esridark"' };
  const state = {}; for (const id of LAYER_IDS) state[id] = (firstShot.setup.layers || []).includes(id); seed['ow.layers'] = JSON.stringify(state);
  seed['ow.view'] = JSON.stringify({ lat: firstShot.warm.lat, lon: firstShot.warm.lon, z: firstShot.warm.z });
  const tle = await readJson(path.join(CACHE, 'tle-cache.json'), {}); let tleSeeded = 0;
  for (const [k, v] of Object.entries(tle)) { try { const o = JSON.parse(v); if (o && Date.now() - o.t < 1.9 * 3600e3) { seed[k] = v; tleSeeded++; } } catch (e) { } }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript(seed) });
  log(`loading ${APP_URL} (${tleSeeded} cached TLE groups seeded)`);
  const loaded = page.waitFor('Page.loadEventFired', { timeoutMs: 60000 });
  await page.send('Page.navigate', { url: APP_URL });
  await loaded;
  if (!await page.poll('!!(window.OW && window.OW.map && window.L)', { timeoutMs: 20000 })) throw new Error('app did not boot (window.OW missing)');
  await page.eval(`(${pageHelper.toString()})()`);
  const done = await page.poll('OW.Splash.done', { timeoutMs: 20000 });
  await page.eval('OW.Splash.close(false), true');
  await page.eval('document.fonts.ready.then(() => true)');
  const hidden = await page.eval('document.hidden'); if (hidden) log('warning: document.hidden is true in headless mode');
  log(`app booted · splash ${done ? 'done' : 'not done (closed anyway)'} · relay ${await page.eval('OW.Relay.available')}`);
  return { page, net, browser };
}

async function waitReady(page, shot) {
  const t0 = Date.now(); let s, r, retried = false, lastWhy = '';
  const seen = {}; // distinct lastOk stamps per feed since the warm view was set = completed passes
  const ctx = { passes: id => (seen[id] ? seen[id].size : 0) };
  while (true) {
    s = await page.eval('__cap.snapshot()');
    for (const [id, f] of Object.entries(s.feeds)) if (f.on && f.lastOk > s.viewSetAt) (seen[id] ||= new Set()).add(f.lastOk);
    r = shot.ready(s, ctx);
    const el = (Date.now() - t0) / 1000;
    if (r.why !== lastWhy || el % 10 < 1) { log(`  [${shot.id}] ${el.toFixed(0)}s · ${r.why}`); lastWhy = r.why; }
    if (r.ok && el >= (shot.minWaitS || 0)) return { s, ok: true, waitedS: el };
    if (r.retry && !retried && el > 15) { retried = true; log(`  [${shot.id}] retrying feed ${r.retry} once`); await page.eval(`OW.runFeed(OW.Layers.byId[${JSON.stringify(r.retry)}].feed, true), true`); }
    if (el > shot.maxWaitS) return { s, ok: false, waitedS: el, why: r.why };
    await sleep(1000);
  }
}

const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))]; };
const stats = arr => ({ mean: Math.round(arr.reduce((s, x) => s + x, 0) / (arr.length || 1)), p50: pct(arr, 0.5), p95: pct(arr, 0.95), max: arr.length ? Math.max(...arr) : 0 });

async function recordFrames(app, shot, path_, outDir) {
  const { page } = app; const n = Math.round(shot.seconds * FPS), ease = EASE[shot.ease] || EASE.inOutSine;
  await rm(outDir, { recursive: true, force: true }); await mkdir(outDir, { recursive: true });
  await page.eval('__cap.resetTileStats()');
  // pre-position at the first frame so the first tile load is not timed against the frame budget
  await page.eval(`__cap.view(${path_.from.lat}, ${path_.from.lon}, ${path_.from.z})`); await page.eval('__cap.settleTiles(15000)');
  const t0 = await page.eval('__capClock.real()'); await page.eval(`__cap.beginClock(${t0})`);
  const events = (shot.events || []).map(e => ({ ...e, frame: Math.round(e.at * (n - 1)) }));
  const per = []; const writes = []; let first = null, last = null, prevHash = '', dupes = 0; const wall0 = Date.now();
  try {
    for (let i = 0; i < n; i++) {
      const f0 = Date.now();
      for (const e of events) if (e.frame === i) { await page.eval(e.js); await sleep(120); }
      const t = n > 1 ? i / (n - 1) : 0, v = pathAt(path_.from, path_.to, ease(t)), vt = t0 + Math.round(i * 1000 / FPS);
      const fr = await page.eval(`__cap.frame(${v.lat}, ${v.lon}, ${v.z}, ${vt}, { tileTimeoutMs: 4000 })`);
      const s0 = Date.now(); const png = await page.screenshotPng(); const shotMs = Date.now() - s0;
      const hash = createHash('md5').update(png).digest('hex'); if (hash === prevHash) dupes++; prevHash = hash;
      const file = path.join(outDir, `frame_${String(i + 1).padStart(5, '0')}.png`); writes.push(writeFile(file, png));
      if (i === 0) first = await page.eval('__cap.snapshot()');
      if (i === n - 1) last = await page.eval('__cap.snapshot()');
      per.push({ i: i + 1, lat: +v.lat.toFixed(5), lon: +v.lon.toFixed(5), z: +v.z.toFixed(4), tileMs: fr.tileMs, timedOut: fr.timedOut, missing: fr.missing, pageMs: fr.pageMs, screenshotMs: shotMs, totalMs: Date.now() - f0, bytes: png.length });
      if ((i + 1) % 30 === 0 || i === n - 1) log(`  [${shot.id}] frame ${i + 1}/${n} · last ${per[i].totalMs} ms (tiles ${fr.tileMs} ms, shot ${shotMs} ms)`);
    }
  } finally { await page.eval('__cap.endClock()'); }
  await Promise.all(writes);
  const tiles = await page.eval('__cap.tileStats()'); const attribution = await page.eval('__cap.attribution()');
  await writeFile(path.join(outDir, 'frames.json'), JSON.stringify(per, null, 0));
  return { n, per, first, last, tiles, attribution, dupes, wallS: (Date.now() - wall0) / 1000, t0 };
}

export async function recordShot(app, id, opts = {}) {
  const shot = { id, ...SHOTS[id] }; if (!SHOTS[id]) throw new Error('unknown shot ' + id);
  const { page } = app; const problems = []; const outDir = path.join(FOOTAGE, id);
  log(`== ${id}: ${shot.title}`);
  const size = await page.eval(`__cap.mode(${JSON.stringify(shot.mode)})`);
  await page.eval('__cap.pause(false)');
  if (shot.setup.layers) await page.eval(`__cap.layers(${JSON.stringify(shot.setup.layers)})`);
  if (shot.setup.preset) await page.eval(`__cap.preset(${JSON.stringify(shot.setup.preset)})`);
  for (const l of shot.setup.off || []) await page.eval(`__cap.set(${JSON.stringify(l)}, false)`);
  for (const l of opts.off || []) await page.eval(`__cap.set(${JSON.stringify(l)}, false)`);
  await page.eval(`__cap.view(${shot.warm.lat}, ${shot.warm.lon}, ${shot.warm.z})`);
  const w = await waitReady(page, shot);
  if (!w.ok) problems.push(`warm-up incomplete after ${w.waitedS.toFixed(0)} s: ${w.why}`);
  // freeze data for the shot: no new fetches; let in-flight ones finish so nothing lands mid-shot
  await page.eval('__cap.pause(true)');
  for (let i = 0; i < 45; i++) { const r = await page.eval('__cap.running()'); if (!r.length) break; if (i === 0) log(`  [${id}] waiting for in-flight feeds: ${r.join(', ')}`); await sleep(1000); }
  const path_ = await shot.path(page, w.s, opts);
  path_.to = unwrapTo(path_.from, path_.to);
  log(`  [${id}] path ${JSON.stringify(path_.from)} -> ${JSON.stringify(path_.to)}${path_.auto ? ' auto ' + JSON.stringify(path_.auto) : ''}`);
  let rec, attempt = 0;
  while (true) {
    attempt++;
    rec = await recordFrames(app, shot, path_, outDir);
    const bad = rec.per.filter(p => p.timedOut || p.missing > 0);
    if ((bad.length > 2 || rec.tiles.errors > 0) && attempt < 2) { log(`  [${id}] ${bad.length} frames with tile timeouts/missing tiles, ${rec.tiles.errors} tile errors · re-recording once`); continue; }
    if (bad.length) problems.push(`${bad.length} frame(s) with tile timeout or missing tiles: ${bad.slice(0, 6).map(p => p.i).join(', ')}`);
    if (rec.tiles.errors) problems.push(`${rec.tiles.errors} tile load errors, e.g. ${rec.tiles.samples.slice(0, 2).join(' ; ')}`);
    break;
  }
  if (!rec.attribution || !rec.attribution.visible) problems.push('map attribution not visible at the end of the shot');
  if (rec.dupes) problems.push(`${rec.dupes} frame(s) identical to the previous one (camera stalled)`);
  const priv = await page.eval('__cap.privacy()');
  if (priv.geoAttempts || priv.locatePos || priv.setupTabOpen || priv.photoLookups || priv.detailImages || priv.camsOn || priv.newsOn) problems.push('PRIVACY CHECK FAILED: ' + JSON.stringify(priv));
  if (rec.first.splashVisible || rec.first.welcomeVisible) problems.push('splash or welcome visible');
  if (shot.cleanup) await shot.cleanup(page);
  await page.eval('__cap.pause(false)');
  const totals = rec.per.map(p => p.totalMs);
  const feedsUsed = Object.fromEntries(Object.entries(rec.first.feeds).filter(([, f]) => f.on).map(([k, f]) => [k, { status: f.status, count: f.count, err: f.err || undefined }]));
  for (const [k, f] of Object.entries(feedsUsed)) if (f.status === 'error') problems.push(`feed ${k} in error: ${f.err}`);
  const res = {
    id, title: shot.title, dir: outDir, frames: rec.n, fps: FPS, seconds: shot.seconds, width: CSS_W * DSF, height: CSS_H * DSF, mode: shot.mode,
    preset: shot.setup.preset || null, layers_on: rec.first.on, map_css_size: size, ease: shot.ease, path: path_, events: shot.events || [],
    captured_utc: new Date(rec.t0).toISOString(), warmup_s: +w.waitedS.toFixed(1), attempts: attempt,
    counts: shot.facts(rec.first, rec.last), feeds: feedsUsed, header_chips: rec.last.chips,
    timing_ms: { per_frame_total: stats(totals), tile_wait: stats(rec.per.map(p => p.tileMs)), screenshot: stats(rec.per.map(p => p.screenshotMs)), wall_s: +rec.wallS.toFixed(1) },
    tile_errors: rec.tiles.errors, duplicate_consecutive_frames: rec.dupes, attribution: rec.attribution, privacy: priv, problems,
    app_log_errors: rec.last.logErrors, // the app's own feed log (error/alert rows), newest first
    frames_json: path.join(outDir, 'frames.json'),
  };
  log(`  [${id}] done: ${rec.n} frames in ${rec.wallS.toFixed(1)} s (${res.timing_ms.per_frame_total.mean} ms/frame avg) · ${problems.length ? 'PROBLEMS: ' + problems.join(' | ') : 'no problems'}`);
  return res;
}

/* ------------------------------------------------------------------ main */
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
  if (args['card-test']) { await cardTest(); if (!args.shots && !args.probe) return; }
  const head = await fetch(APP_URL, { method: 'GET' }).then(r => r.ok).catch(() => false);
  if (!head) throw new Error(`the app is not being served at ${APP_URL} — start serve.js (Start Open Overwatch.bat) first`);
  const relay = await fetch(APP_ORIGIN + '/proxy?ping=1').then(r => r.text()).catch(() => '');
  if (relay.trim() !== 'ok') log('warning: the helper relay did not answer /proxy?ping=1 — aircraft feeds will fail');
  const ids = args.probe ? [] : (typeof args.shots === 'string' ? args.shots.split(',').map(s => s.trim()).filter(Boolean) : SHOT_ORDER);
  for (const id of ids) if (!SHOTS[id]) throw new Error('unknown shot ' + id + ' (known: ' + SHOT_ORDER.join(', ') + ')');
  await mkdir(FOOTAGE, { recursive: true }); await mkdir(CACHE, { recursive: true });
  const browser = await launch();
  const onSig = async () => { log('interrupted, closing the browser'); await browser.close(); process.exit(130); };
  process.once('SIGINT', onSig);
  try {
    const app = await openApp(browser, { firstShot: SHOTS[ids[0] || 'air_world'] });
    if (args.probe) {
      await app.page.eval(`__cap.mode('full')`);
      const sh = { id: 'probe', maxWaitS: +(args.wait || 60), minWaitS: 0, ready: s => ({ ok: false, why: Object.entries(s.feeds).filter(([, f]) => f.on).map(([k, f]) => `${k}:${f.status}:${f.count}`).join(' ') + ` · air ${s.air.total} (${s.air.opensky} opensky)` }) };
      const w = await waitReady(app.page, sh); console.log(JSON.stringify(w.s, null, 1));
      return;
    }
    const mfFile = path.join(FOOTAGE, 'manifest.json');
    const prev = await readJson(mfFile, { shots: [] }); const byId = Object.fromEntries((prev.shots || []).map(s => [s.id, s]));
    if (prev.network && !prev.runs) prev.runs = [{ started_utc: prev.generated_utc, shots: (prev.shots || []).map(s => s.id), network: prev.network }];
    const runs = (prev.runs || []).slice(-9); const run = { started_utc: new Date().toISOString(), shots: ids, network: null }; runs.push(run);
    const save = async () => {
      run.network = { requests_by_host: app.net.hosts, blocked: app.net.blocked, privacy_hits: app.net.privacyHits };
      const mf = { generated_utc: new Date().toISOString(), app: APP_URL, tool: 'brand/tools/capture.mjs', fps: FPS, width: CSS_W * DSF, height: CSS_H * DSF, viewport_css: [CSS_W, CSS_H], device_scale_factor: DSF,
        frame_pattern: 'frame_#####.png (1-based)', shots: SHOT_ORDER.filter(id => byId[id]).map(id => byId[id]), runs };
      await writeFile(mfFile, JSON.stringify(mf, null, 2));
    };
    for (const id of ids) {
      try { byId[id] = await recordShot(app, id, { off: id === 'hazards' && args['radar-off'] ? ['radar'] : [], issWaitMin: args['iss-wait'] != null ? +args['iss-wait'] : 40 }); }
      catch (e) { log(`  [${id}] FAILED: ${e.stack || e.message}`); byId[id] = { id, failed: true, problems: [String(e.message || e)] }; await app.page.eval('__cap.endClock(), __cap.pause(false)').catch(() => { }); }
      await save();
    }
    try { const tle = await app.page.eval('__cap.tleCache()'); if (Object.keys(tle).length) await writeFile(path.join(CACHE, 'tle-cache.json'), JSON.stringify(tle)); } catch (e) { }
    log(`manifest: ${mfFile}`);
  } finally { process.off('SIGINT', onSig); await browser.close(); log('browser closed'); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
