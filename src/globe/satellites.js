// Satellites: TLEs from the shared source (src/core/tle.js), SGP4 for every dot in a worker, and Blender-built glTF
// models with exact per-frame SGP4 for the nearest ones.
import { C, toast, bigStore, getText, ON_SITE } from './env.js';
import { viewer, camera, satPts, orbitLines } from './viewer.js';
import { L, LAYERS, setCount } from './layers.js';
import { state, hooks } from './state.js';
import { Follow, MODEL_FIX, SOLAR_AXIS } from './follow.js';
import { sunDirection } from './earth.js';
import { createTleSource, parseTle } from '../core/tle.js';
import { Time } from './time.js';

const satellite = window.satellite;
const tles = createTleSource({ fetchText: (url, o) => getText(url, o), cache: bigStore, onSite: ON_SITE });

// The worker propagates every satellite once a second (position + 1 s velocity, Earth-fixed km); the page extrapolates.
const WORKER_SRC = `
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');
let recs = [];
onmessage = e => {
  const m = e.data;
  if (m.type === 'load') { recs = m.tles.map(([l1, l2]) => { try { return satellite.twoline2satrec(l1, l2); } catch (err) { return null; } }); return; }
  if (m.type === 'tick') {
    const t0 = new Date(m.t), t1 = new Date(m.t + 1000), g0 = satellite.gstime(t0), g1 = satellite.gstime(t1);
    const out = new Float32Array(recs.length * 6);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]; let ok = false;
      if (r) {
        const a = satellite.propagate(r, t0), b = satellite.propagate(r, t1);
        if (a.position && b.position && !isNaN(a.position.x)) {
          const p = satellite.eciToEcf(a.position, g0), q = satellite.eciToEcf(b.position, g1);
          out.set([p.x, p.y, p.z, q.x - p.x, q.y - p.y, q.z - p.z], i * 6); ok = true;
        }
      }
      if (!ok) out[i * 6] = NaN;
    }
    postMessage({ t: m.t, buf: out }, [out.buffer]);
  }
};`;

export const Sats = {
  list: [], byId: new Map(), state: null, worker: null,
  async load() {
    const seen = new Set(), elements = [];
    for (const l of LAYERS.filter(x => x.sat)) {
      let n = 0;
      for (const g of l.sat) {
        let res;
        try { res = await tles.load(g); } catch (e) { toast(`Satellites (${e.message})`, 4200); continue; }
        if (res.source === 'stale cache') console.warn(`${g}: using TLEs cached ${Math.round(res.ageMs / 3600e3)} h ago`);
        for (const t of parseTle(res.txt)) {
          if (seen.has(t.id)) continue; seen.add(t.id);
          const s = { kind: 'sat', ...t, layer: l.id, idx: elements.length };
          elements.push([t.l1, t.l2]); this.list.push(s); this.byId.set(t.id, s); n++;
        }
      }
      setCount(l.id, n);
    }
    for (const s of this.list) {
      const l = L[s.layer], col = C.Color.fromCssColorString(l.color).withAlpha(l.alpha ?? 1);
      s.pt = satPts.add({ position: C.Cartesian3.ZERO, pixelSize: l.size, color: col, outlineWidth: 0, id: s, show: false, scaleByDistance: new C.NearFarScalar(5.0e5, 2.0, 1.5e8, 0.55),
        // 10,000 Starlinks would cover the whole disc like fur from beyond the GEO belt (and are far too faint to see): fade them out
        translucencyByDistance: s.layer === 'starlink' ? new C.NearFarScalar(4.0e7, 1.0, 1.6e8, 0.0) : undefined });
    }
    this.worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    this.worker.onmessage = e => { this.state = { t: e.data.t, buf: e.data.buf }; };
    this.worker.postMessage({ type: 'load', tles: elements });
    // ask for positions at the clock's time: once a second live, more often when the clock runs fast
    const tick = () => { this.worker.postMessage({ type: 'tick', t: Time.nowMs() }); setTimeout(tick, Math.max(150, Math.min(1000, 20000 / Math.max(1, Math.abs(Time.rate))))); };
    tick();
    hooks.updateStats();
  },
  scratch: new C.Cartesian3(),
  update(now) { // extrapolate from the last worker tick (ECF, km): straight along v for a few seconds, else round the orbit
    const st = this.state; if (!st) return; const dt = (now - st.t) / 1000, b = st.buf, P = this.scratch, curve = Math.abs(dt) > 3;
    for (const s of this.list) {
      const i = s.idx * 6, x = b[i]; if (Number.isNaN(x)) { s.pt.show = false; continue; }
      s.pt.show = L[s.layer].on && !s.ent && !s.docked; if (!s.pt.show) continue;   // hidden dots: no position work
      const y = b[i + 1], z = b[i + 2], vx = b[i + 3], vy = b[i + 4], vz = b[i + 5];
      if (!curve) { P.x = (x + vx * dt) * 1000; P.y = (y + vy * dt) * 1000; P.z = (z + vz * dt) * 1000; }
      else { // rotate about the orbit normal k = r x v at the mean angular rate |r x v| / r^2 (near-circular orbits)
        const nx = y * vz - z * vy, ny = z * vx - x * vz, nz = x * vy - y * vx, nl = Math.hypot(nx, ny, nz), a = nl / (x * x + y * y + z * z) * dt;
        const kx = nx / nl, ky = ny / nl, kz = nz / nl, c = Math.cos(a), sn = Math.sin(a);
        P.x = (x * c + (ky * z - kz * y) * sn) * 1000; P.y = (y * c + (kz * x - kx * z) * sn) * 1000; P.z = (z * c + (kx * y - ky * x) * sn) * 1000;
      }
      s.pt.position = P;
    }
  },
  info(s) {
    const rec = satellite.twoline2satrec(s.l1, s.l2), now = new Date(Time.nowMs()), pv = satellite.propagate(rec, now);
    const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(now));
    const v = pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) : null;
    return { alt: gd.height, lat: satellite.degreesLat(gd.latitude), lon: satellite.degreesLong(gd.longitude), speed: v * 3600, period: 2 * Math.PI / rec.no, incl: rec.inclo * 180 / Math.PI };
  },
  orbit(s) { // one inertial orbit, drawn in the current Earth-fixed frame so it passes through the satellite
    orbitLines.removeAll();
    const rec = satellite.twoline2satrec(s.l1, s.l2), now = new Date(Time.nowMs()), g = satellite.gstime(now), per = 2 * Math.PI / rec.no, pts = [];
    for (let k = 0; k <= 180; k++) {
      const pv = satellite.propagate(rec, new Date(now.getTime() + k / 180 * per * 60000)); if (!pv.position) continue;
      const f = satellite.eciToEcf(pv.position, g); pts.push(new C.Cartesian3(f.x * 1000, f.y * 1000, f.z * 1000));
    }
    orbitLines.add({ positions: pts, width: 1.6, material: C.Material.fromType('Color', { color: C.Color.fromCssColorString(L[s.layer].color).withAlpha(0.55) }) });
  },
};

// ambient fill for satellite models in Earth's shadow (otherwise they render black)
export const SHADOW_FILL = new C.CustomShader({ fragmentShaderText: 'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { material.emissive += material.diffuse * 0.42; }' });

/* Satellites near the camera swap their point for a glTF model at real size, flying nose-first (+X along velocity, +Z
   to zenith), with solar arrays (nodes solar_*) turned toward the real sun about the model's Y axis. Modelled
   satellites get exact SGP4 every frame (the worker's 1 s linear extrapolation drifts ~4 m, visible up close). */
export const SatModels = {
  dir: 'brand/models/', max: 40, range: 4.0e6, pool: new Map(), nodes: {}, stations: null,
  // follow-camera scale (m): the camera starts at (-r, -r, 0.55r) east/north/up of the satellite, r = the model's size
  view: { iss: 110, css: 56, hubble: 19, soyuz: 11, starlink: 10.5, gnss: 13, geo: 30, weather: 10.5, smallsat: 8.5, rocketbody: 11, axes: 12 },
  classify(s) {
    const n = s.name.toUpperCase();
    if (n === 'ISS (ZARYA)') return 'iss';
    if (n === 'CSS (TIANHE)') return 'css';
    if (/^(ISS|CSS) \(/.test(n)) return null;              // other station modules share the station's orbit and position
    if (n === 'HST') return 'hubble';
    if (/SOYUZ|PROGRESS|SHENZHOU|TIANZHOU|DRAGON|CYGNUS|STARLINER|HTV/.test(n)) return 'soyuz';
    if (/STARLINK/.test(n)) return 'starlink';
    if (/\bDEB\b/.test(n)) return null;                  // debris fragments stay dots
    if (/ R\/B|R\/B$/.test(n)) return 'rocketbody';
    if (s.layer === 'gnss') return 'gnss';
    if (s.layer === 'geo') return 'geo';
    if (s.layer === 'weather') return 'weather';
    return 'smallsat';
  },
  async solarNodes(type) { // node names straight from the GLB's JSON chunk; null = file missing (don't refetch)
    if (type in this.nodes) return this.nodes[type];
    try {
      const buf = await (await fetch(this.dir + type + '.glb')).arrayBuffer(), dv = new DataView(buf);
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
      this.nodes[type] = (json.nodes || []).map(n => n.name).filter(n => /^solar_/.test(n || ''));
    } catch (e) { console.warn('model', type, e); this.nodes[type] = null; }
    return this.nodes[type];
  },
  sunEcf: new C.Cartesian3(1, 0, 0),
  updateSun(time) { sunDirection(time, this.sunEcf); },
  state(s, time = viewer.clock.currentTime) { // exact position, attitude and array angle at the clock time (cached per instant)
    const key = time.dayNumber * 86400 + time.secondsOfDay;
    if (s._k === key && s._st) return s._st;
    s.rec = s.rec || satellite.twoline2satrec(s.l1, s.l2);
    const now = C.JulianDate.toDate(time).getTime(), d0 = new Date(now), d1 = new Date(now + 1000);
    const a = satellite.propagate(s.rec, d0), b = satellite.propagate(s.rec, d1);
    const st = s._st || (s._st = { pos: new C.Cartesian3(), quat: new C.Quaternion(), solar: new C.Quaternion(), ok: false });
    s._k = key;
    if (!a.position || !b.position || Number.isNaN(a.position.x)) { st.ok = false; return st; }
    const p = satellite.eciToEcf(a.position, satellite.gstime(d0)), q = satellite.eciToEcf(b.position, satellite.gstime(d1));
    C.Cartesian3.fromElements(p.x * 1000, p.y * 1000, p.z * 1000, st.pos);
    const Z = C.Cartesian3.normalize(st.pos, new C.Cartesian3());
    const v = new C.Cartesian3((q.x - p.x) * 1000, (q.y - p.y) * 1000, (q.z - p.z) * 1000);
    const X = C.Cartesian3.normalize(C.Cartesian3.subtract(v, C.Cartesian3.multiplyByScalar(Z, C.Cartesian3.dot(v, Z), new C.Cartesian3()), new C.Cartesian3()), new C.Cartesian3());
    const Y = C.Cartesian3.cross(Z, X, new C.Cartesian3());
    const R = new C.Matrix3(X.x, Y.x, Z.x, X.y, Y.y, Z.y, X.z, Y.z, Z.z);   // columns = body axes in Earth-fixed coordinates
    C.Quaternion.multiply(C.Quaternion.fromRotationMatrix(R, st.quat), MODEL_FIX, st.quat);
    // arrays: rotate about body +Y so their +Z normal points at the sun: theta = atan2(sun.x, sun.z) in body axes
    C.Quaternion.fromAxisAngle(SOLAR_AXIS, Math.atan2(C.Cartesian3.dot(this.sunEcf, X), C.Cartesian3.dot(this.sunEcf, Z)), st.solar);
    const sd = C.Cartesian3.dot(st.pos, this.sunEcf);    // in Earth's shadow: behind the Earth and inside its cylinder
    st.shadow = sd < 0 && C.Cartesian3.magnitude(C.Cartesian3.subtract(st.pos, C.Cartesian3.multiplyByScalar(this.sunEcf, sd, new C.Cartesian3()), new C.Cartesian3())) < 6371000;
    st.ok = true; return st;
  },
  async ensure(s) {
    if (s.ent) return s.ent;
    if (!s.pt) return null;                              // still loading (the list fills before the dots exist)
    const type = s.model === undefined ? (s.model = this.classify(s)) : s.model;
    if (!type) return null;
    const solar = await this.solarNodes(type);
    if (solar === null || s.ent) return s.ent || null;   // model file missing (or added while awaiting)
    const nodeTransformations = {};
    for (const n of solar) nodeTransformations[n] = new C.NodeTransformationProperty({ rotation: new C.CallbackProperty(t => this.state(s, t).solar, false) });
    s.ent = viewer.entities.add({
      position: new C.CallbackProperty(t => { const st = this.state(s, t); return st.ok ? st.pos : undefined; }, false),
      orientation: new C.CallbackProperty(t => this.state(s, t).quat, false),
      model: { uri: this.dir + type + '.glb', minimumPixelSize: 34, maximumScale: 4.0e4, nodeTransformations, runAnimations: false,
        customShader: new C.CallbackProperty(t => this.state(s, t).shadow ? SHADOW_FILL : undefined, false) },
    });
    s.ent.sat = s; s.pt.show = false; this.pool.set(s.id, s);
    return s.ent;
  },
  drop(s) {
    if (!s.ent || !s.pt || s === this.followed || s === state.selected) return;
    viewer.entities.remove(s.ent); s.ent = null; this.pool.delete(s.id);
    s.pt.show = L[s.layer].on && !s.docked;
  },
  refresh() { // which satellites get a model: the nearest within range, plus the selected and followed ones
    const st = Sats.state; if (!st) return;
    const cam = camera.positionWC, b = st.buf, dt = (Date.now() - st.t) / 1000, near = [];
    for (const s of Sats.list) {
      if (!L[s.layer].on || s.model === null) continue;
      const i = s.idx * 6; if (Number.isNaN(b[i])) continue;
      const dx = (b[i] + b[i + 3] * dt) * 1000 - cam.x, dy = (b[i + 1] + b[i + 4] * dt) * 1000 - cam.y, dz = (b[i + 2] + b[i + 5] * dt) * 1000 - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz; if (d2 < this.range * this.range) near.push([d2, s]);
    }
    near.sort((p, q) => p[0] - q[0]);
    // docked vehicles and station modules have their own TLEs at the station's position: no model, no dot. Checked over
    // the whole catalogue (not just near the camera), so Follow/selection can never pick a docked one.
    const pos = s => { const i = s.idx * 6; return [b[i] + b[i + 3] * dt, b[i + 1] + b[i + 4] * dt, b[i + 2] + b[i + 5] * dt]; };
    this.stations = this.stations || Sats.list.filter(x => ['iss', 'css'].includes(this.classify(x)));
    const docked = new Set();
    for (const st2 of this.stations) {
      if (Number.isNaN(b[st2.idx * 6])) continue; const P = pos(st2);
      for (const s of Sats.list) { if (s === st2 || Number.isNaN(b[s.idx * 6])) continue; const Q = pos(s); if (Math.hypot(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]) < 5) docked.add(s); }
    }
    for (const s of Sats.list) {
      const was = s.docked; s.docked = docked.has(s);
      if (was !== s.docked && s.pt) s.pt.show = L[s.layer].on && !s.ent && !s.docked;
      if (s.docked && s.ent && s !== this.followed) this.drop(s);
    }
    const want = new Set(near.filter(x => !docked.has(x[1])).slice(0, this.max).map(x => x[1]));
    if (this.followed) want.add(this.followed);
    const sel = state.selected; if (sel && sel.kind === 'sat' && !sel.docked) want.add(sel);
    for (const s of [...this.pool.values()]) if (!want.has(s)) this.drop(s);
    for (const s of want) if (!s.ent && L[s.layer].on) this.ensure(s);
  },
  get followed() { return Follow.obj && Follow.obj.kind === 'sat' ? Follow.obj : null; },
  async follow(s) {
    if (s.docked) { // follow the station it is docked to
      const st = Sats.list.find(x => ['iss', 'css'].includes(x.model ?? this.classify(x)) && x.ent) || Sats.list.find(x => x.name === 'ISS (ZARYA)');
      if (st) { toast(`${s.name} is docked to ${st.name} · following the station`); s = st; }
    }
    const ent = await this.ensure(s);
    if (!ent) { toast('No 3D model for this object'); return; }
    if (!this.state(s).ok) { toast('No position for this object right now'); return; }
    Follow.start(s, t => { const st = this.state(s, t); return st.ok ? st.pos : null; }, this.view[s.model] || 40, ent, 34);
  },
};
