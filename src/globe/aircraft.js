// Aircraft: the OpenSky global snapshot (every 15 min) and adsb.lol military (every 60 s), dead-reckoned between fixes,
// drawn as Blender-rendered sprites far out and as glTF models (pitch from climb rate, bank from turn rate) up close.
import { C, bigStore, getJSON, NO_ENV_MAP } from './env.js';
import { viewer, camera, airPts, airIcons, camHeight } from './viewer.js';
import { L, setCount } from './layers.js';
import { state, hooks } from './state.js';
import { Follow, MODEL_FIX } from './follow.js';
import { deadReckon } from '../core/geo.js';
import { Time } from './time.js';

const DR_MAX_S = 900;              // dead-reckoning horizon: the global snapshot refreshes every 15 min
export const AIR_ICON_RANGE = 2.5e6; // planes become heading icons below ~2,500 km camera distance
const EMERGENCY = ['7500', '7600', '7700'];

// sprite shape by ICAO type code (brand/tools/plane_sprites.py renders one per shape and colour)
const SPRITE_SIZE = { airliner: 30, prop: 26, heli: 26, fighter: 24, heavy: 36, tprop: 32 };
const TYPES = [
  ['heli', /^(H\d|EC\d|AS\d|S6|S7|S9|NH90|A1\d9|MI\d|KA\d|UH|AH|CH|B06|B4\d\d|LYNX|PUMA|TIGR|AW1|R44|R22|B505)/],
  ['fighter', /^(F1[4-8]|F22|F35|F5|FA|EUFI|RFAL|TOR|JAS|GRIF|HAWK|T38|T45|A10|MG\d|SU\d|M2T|MIR|L159|AV8|AJET|F4|J10|J20|LCA|KFIR|T50|M346)/],
  ['tprop', /^(C130|C30J|A400|C27J|CN35|C295|AN12$|AN2[46]|AN32|P3|E2|L188|ATLA|C160|Y8|Y9|V22)/],
  ['heavy', /^(K35|KC|K46|C17|C5|E3|E6|E8|R135|C135|B52|B1|B2|IL7|AN12[45]|A33|A31|B74|B76|B77|DC10|MD11)/],
  ['prop', /^(C12|BE\d|PC12|PC21|PC9|T6|DHC|C208|G120|TEX|SR2|C17[0-9]|DA4|U28|MQ|RQ|L410|SW4)/],
];
export function airShape(r) {
  const t = String(r.type || '').toUpperCase();
  if (t) for (const [shape, re] of TYPES) if (re.test(t)) return shape;
  if (!r.ground && r.gs != null && r.gs < 85 && (r.alt || 0) < 5000) return 'prop';   // slow and low without a type: GA
  return 'airliner';
}

/** Where an aircraft is at time ms: along its track for up to 15 min (planes never freeze between snapshots), climbing or
 *  descending at its vertical rate for up to 1 min. */
export function aircraftAt(r, ms) {
  const dts = Math.max(0, (ms - r.ts) / 1000), { lat, lon } = deadReckon(r, Math.min(DR_MAX_S, dts));
  const alt = Math.max(0, (r.alt || 0) + (r.ground ? 0 : (r.vr || 0) * Math.min(60, dts))) + (r.ground ? 3 : 0);
  return { lat, lon, alt };
}

/** An adsb.lol (readsb) aircraft as one of ours; mil: true for the /mil feed, else from its database flags. */
export function fromAdsb(a, now, mil = !!(a.dbFlags & 1)) {
  const ground = a.alt_baro === 'ground';
  return { hex: a.hex, flight: (a.flight || '').trim(), type: a.t, reg: a.r, lon: a.lon, lat: a.lat, alt: ground ? 0 : (a.alt_baro || 0) * 0.3048, ground,
    gs: a.gs != null ? a.gs * 0.514444 : null, track: a.track, vr: a.baro_rate != null ? a.baro_rate * 0.00508 : 0, squawk: a.squawk, emerg: EMERGENCY.includes(a.squawk),
    mil, ts: now - (a.seen_pos || 0) * 1000, src: 'adsb.lol' };
}

const layerOf = r => L[r.mil ? 'mil' : 'air'];
/** Shown: its layer is on and the clock is at the live moment (aircraft feeds have no history). */
export const airShown = r => layerOf(r).on && !Time.offLive();
export const Air = {
  map: new Map(),
  upsert(a) {
    let r = this.map.get(a.hex);
    if (!r) {
      r = { ...a, kind: 'air' };
      r.pt = airPts.add({ position: C.Cartesian3.ZERO, pixelSize: 2.4, id: r, scaleByDistance: new C.NearFarScalar(2.0e5, 2.2, 2.0e7, 0.7), distanceDisplayCondition: new C.DistanceDisplayCondition(AIR_ICON_RANGE * 0.8, 1e12) });
      r.icon = airIcons.add({ position: C.Cartesian3.ZERO, id: r, alignedAxis: C.Cartesian3.UNIT_Z, scaleByDistance: new C.NearFarScalar(2.0e4, 1.5, AIR_ICON_RANGE, 0.6), distanceDisplayCondition: new C.DistanceDisplayCondition(0, AIR_ICON_RANGE) });
      this.map.set(a.hex, r);
    } else if (r.mil && !a.mil && Date.now() - r.ts < 180e3) return;   // keep fresher military data
    else {
      const dt = (a.ts - r.ts) / 1000;   // turn rate (deg/s) from consecutive fixes, for banking the model; short gaps only
      r.turn = (a.track != null && r.track != null && dt >= 2 && dt <= 120) ? (((a.track - r.track + 540) % 360) - 180) / dt : 0;
      Object.assign(r, a);
    }
    r.pt.color = C.Color.fromCssColorString(r.emerg ? '#ff4d5e' : r.mil ? '#ffb44d' : '#5fd3ff'); r.icon.rotation = -C.Math.toRadians(r.track || 0);
    const shape = airShape(r), img = `brand/sprites/${shape}_${r.emerg ? 'emg' : r.mil ? 'mil' : 'civ'}.png`;
    if (r.sprite !== img) { r.sprite = img; r.shape = shape; r.icon.image = img; r.icon.width = r.icon.height = SPRITE_SIZE[shape]; }
    const on = airShown(r); r.pt.show = on && !r.ent; r.icon.show = on && !r.ent;
    if (r.ent) AirModels.restyle(r);
  },
  async opensky() {
    let rows = null; const c = await bigStore.get('opensky');
    if (c && Date.now() - c.t < 15 * 60e3) rows = c.rows;   // anonymous OpenSky: 400 credits/day, a global snapshot costs 4
    else {
      const d = await getJSON('https://opensky-network.org/api/states/all', { relay: true, timeout: 60000 });
      rows = (d.states || []).filter(s => s[5] != null && s[6] != null).map(s => [s[0], (s[1] || '').trim(), s[2], s[5], s[6], s[8] ? 0 : s[7], s[8] ? 1 : 0, s[9], s[10], s[14], s[11]]);
      await bigStore.set('opensky', { t: Date.now(), rows });
    }
    const now = Date.now(), ts = (c && rows === c.rows) ? c.t : now;
    for (const [hex, flight, country, lon, lat, alt, ground, gs, track, squawk, vr] of rows)
      this.upsert({ hex, flight, country, lon, lat, alt: alt || 0, ground: !!ground, gs, track, vr: vr ?? 0, squawk, emerg: EMERGENCY.includes(squawk), mil: false, ts, src: 'OpenSky' });
    this.snapshotAt = ts; setCount('air', rows.length); hooks.updateStats();
  },
  async military() {
    const d = await getJSON('https://api.adsb.lol/v2/mil', { relay: true }), now = Date.now(); let n = 0; this.milAt = now;
    for (const a of d.ac || []) { if (a.lat == null || a.lon == null) continue; n++; this.upsert(fromAdsb(a, now, true)); }
    setCount('mil', n); hooks.updateStats();
  },
  prune() {
    const now = Date.now();
    for (const [k, r] of this.map) if (now - r.ts > (r.mil ? 5 * 60e3 : 20 * 60e3) && r !== Follow.obj && r !== state.selected) {
      AirModels.drop(r, true); airPts.remove(r.pt); airIcons.remove(r.icon); this.map.delete(k);
    }
  },
  update(now) {
    for (const r of this.map.values()) {
      if (!airShown(r)) continue;
      const { lat, lon } = aircraftAt(r, now), pos = C.Cartesian3.fromDegrees(lon, lat, Math.max(0, r.alt || 0) + 60);
      r.pt.position = pos; r.icon.position = pos; r.cur = { lat, lon };
    }
  },
  counts() { let air = 0, mil = 0; for (const r of this.map.values()) r.mil ? mil++ : air++; return { air, mil }; },
};

/* The nearest aircraft to the camera (when it is below ~600 km) swap their icon for a glTF model at real size. Same axes
   as the satellites (+X nose, +Z up), so the same MODEL_FIX applies. */
export const AirModels = {
  max: 200, range: 3.0e5, ceiling: 6.0e5, pool: new Map(), _p: new C.Cartesian3(),
  view: { airliner: 38, prop: 28, heli: 18, fighter: 17, heavy: 50, tprop: 40 },
  get followed() { return Follow.obj && Follow.obj.kind === 'air' ? Follow.obj : null; },
  state(r, time = viewer.clock.currentTime) {
    const key = time.dayNumber * 86400 + time.secondsOfDay;
    if (r._k === key && r._st) return r._st;
    const st = r._st || (r._st = { pos: new C.Cartesian3(), quat: new C.Quaternion() }); r._k = key;
    const g = aircraftAt(r, C.JulianDate.toDate(time).getTime());
    C.Cartesian3.fromDegrees(g.lon, g.lat, g.alt, C.Ellipsoid.WGS84, st.pos);
    const enu = C.Transforms.eastNorthUpToFixedFrame(st.pos), E = new C.Cartesian3(enu[0], enu[1], enu[2]), N = new C.Cartesian3(enu[4], enu[5], enu[6]), U = new C.Cartesian3(enu[8], enu[9], enu[10]);
    const h = C.Math.toRadians(r.track || 0);
    const pitch = r.ground ? 0 : Math.max(-0.35, Math.min(0.35, Math.atan2(r.vr || 0, Math.max(30, r.gs || 0))));
    const bank = r.ground ? 0 : Math.max(-0.5, Math.min(0.5, Math.atan((r.gs || 0) * C.Math.toRadians(r.turn || 0) / 9.81)));   // coordinated turn
    const f = C.Cartesian3.add(C.Cartesian3.multiplyByScalar(E, Math.sin(h), new C.Cartesian3()), C.Cartesian3.multiplyByScalar(N, Math.cos(h), new C.Cartesian3()), new C.Cartesian3());
    const X = C.Cartesian3.normalize(C.Cartesian3.add(C.Cartesian3.multiplyByScalar(f, Math.cos(pitch), new C.Cartesian3()), C.Cartesian3.multiplyByScalar(U, Math.sin(pitch), new C.Cartesian3()), new C.Cartesian3()), new C.Cartesian3());
    const Y0 = C.Cartesian3.normalize(C.Cartesian3.cross(U, X, new C.Cartesian3()), new C.Cartesian3());   // left wing
    const Z0 = C.Cartesian3.cross(X, Y0, new C.Cartesian3());
    const Z = C.Cartesian3.normalize(C.Cartesian3.subtract(C.Cartesian3.multiplyByScalar(Z0, Math.cos(bank), new C.Cartesian3()), C.Cartesian3.multiplyByScalar(Y0, Math.sin(bank), new C.Cartesian3()), new C.Cartesian3()), new C.Cartesian3()); // right turn = right wing down
    const Y = C.Cartesian3.cross(Z, X, new C.Cartesian3());
    C.Quaternion.multiply(C.Quaternion.fromRotationMatrix(new C.Matrix3(X.x, Y.x, Z.x, X.y, Y.y, Z.y, X.z, Y.z, Z.z), st.quat), MODEL_FIX, st.quat);
    return st;
  },
  uri: r => `brand/models/aircraft/${r.shape || 'airliner'}_${r.mil ? 'mil' : 'civ'}.glb`,
  restyle(r) { // shape/colour can change when a fresher fix arrives (a type code, a squawk)
    const m = r.ent.model; if (!m) return;
    const uri = this.uri(r); if (m.uri.getValue() !== uri) m.uri = uri;
    m.silhouetteColor = C.Color.fromCssColorString('#ff4d5e'); m.silhouetteSize = r.emerg ? 2.0 : 0.0;
  },
  ensure(r) {
    if (r.ent) return r.ent;
    const rotor = new C.NodeTransformationProperty({ rotation: new C.CallbackProperty(t => C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_Y, (t.secondsOfDay * 2 * Math.PI * 4.5) % (2 * Math.PI)), false) });
    r.ent = viewer.entities.add({
      position: new C.CallbackProperty(t => this.state(r, t).pos, false),
      orientation: new C.CallbackProperty(t => this.state(r, t).quat, false),
      model: { uri: this.uri(r), environmentMapOptions: NO_ENV_MAP, minimumPixelSize: 26, maximumScale: 2.0e4, nodeTransformations: { rotor }, silhouetteColor: C.Color.fromCssColorString('#ff4d5e'), silhouetteSize: r.emerg ? 2.0 : 0.0 },
    });
    r.ent.air = r; r.pt.show = false; r.icon.show = false; this.pool.set(r.hex, r);
    return r.ent;
  },
  drop(r, force = false) {
    if (!r.ent || (!force && (r === Follow.obj || r === state.selected))) return;
    if (r === Follow.obj) Follow.stop();
    viewer.entities.remove(r.ent); r.ent = null; this.pool.delete(r.hex);
    const on = airShown(r); r.pt.show = on; r.icon.show = on;
  },
  refresh() {
    if (state.lookup) { for (const r of [...this.pool.values()]) this.drop(r); return; }   // look-up mode labels aircraft instead
    const want = new Set();
    if (camHeight() < this.ceiling) {
      const cam = camera.positionWC, near = [];
      for (const r of Air.map.values()) {
        if (!airShown(r) || !r.cur) continue;
        const d = C.Cartesian3.distance(C.Cartesian3.fromDegrees(r.cur.lon, r.cur.lat, r.alt || 0, C.Ellipsoid.WGS84, this._p), cam);
        if (d < this.range) near.push([d, r]);
      }
      near.sort((a, b) => a[0] - b[0]);
      for (const [, r] of near.slice(0, this.max)) want.add(r);
    }
    if (this.followed) want.add(this.followed);
    if (state.selected && state.selected.kind === 'air') want.add(state.selected);
    for (const r of [...this.pool.values()]) if (!want.has(r)) this.drop(r);
    for (const r of want) if (!r.ent && Air.map.has(r.hex)) this.ensure(r);
  },
  follow(r) { const ent = this.ensure(r); Follow.start(r, t => this.state(r, t).pos, this.view[r.shape] || 38, ent, 26); },
};
