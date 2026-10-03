// Wind and temperature for weather mode. One live snapshot from Open-Meteo (open data, CC BY 4.0, non-commercial use, no key):
// 10 m wind and 2 m temperature on a 10-degree grid, ~15 minutes old, kept for 30 minutes in localStorage so reopening the
// mode costs nothing. Wind is drawn as moving streaks on a canvas laid over the globe (each particle is advected through
// the bilinear wind field and projected with the camera); temperature is a colour wash made once from the same grid.
import { C, store, PHONE } from './env.js';
import { viewer, scene, camera, camHeight } from './viewer.js';

const LATS = [], LONS = [];
for (let la = -80; la <= 80; la += 10) LATS.push(la);
for (let lo = -180; lo < 180; lo += 10) LONS.push(lo);
const NX = LONS.length, NY = LATS.length, COUNT = PHONE ? 1400 : 3800;
const CHUNK = 306, TTL = 30 * 60e3, KEY = 'wx.grid.v1';
const R = 6378137;
const COLORS = ['#7fe8ff', '#b6f5ff', '#ffffff', '#fff3a8', '#ffc46b', '#ff7a5c'];   // calm to gale
const EDGES = [3, 6, 10, 15, 22];   // m/s between the colours

export const Wind = {
  grid: null, loading: null, canvas: null, ctx: null, parts: [], raf: 0, windOn: false, tempLayer: null,
  async load() {
    if (this.grid) return this.grid;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const c = store.get(KEY, null);
      if (c && Date.now() - c.t < TTL && c.u && c.u.length === NX * NY) return (this.grid = c);
      const pts = []; for (const la of LATS) for (const lo of LONS) pts.push([la, lo]);
      const u = new Array(NX * NY), v = new Array(NX * NY), t = new Array(NX * NY); let when = '';
      const jobs = []; for (let i = 0; i < pts.length; i += CHUNK) jobs.push(i);
      await Promise.all(jobs.map(async i => {   // both halves at once
        const part = pts.slice(i, i + CHUNK);
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + part.map(p => p[0]).join(',') + '&longitude=' + part.map(p => p[1]).join(',') + '&current=wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=ms';
        const rows = await (await fetch(url)).json();
        if (!Array.isArray(rows)) throw new Error('weather model unavailable');
        rows.forEach((r, j) => { const s = r.current.wind_speed_10m, d = r.current.wind_direction_10m * Math.PI / 180;   // direction the wind blows FROM
          u[i + j] = -s * Math.sin(d); v[i + j] = -s * Math.cos(d); t[i + j] = r.current.temperature_2m; when = r.current.time; });
      }));
      const g = { t: Date.now(), at: when, u, v, temp: t }; store.set(KEY, g); return (this.grid = g);
    })().catch(e => { this.loading = null; throw e; });
    return this.loading;
  },

  // bilinear sample of the grid: out = [u, v, temp]
  sample(lon, lat, out) {
    const fx = ((lon + 180) % 360 + 360) % 360 / 10, fy = (Math.max(-80, Math.min(80, lat)) + 80) / 10;
    const x0 = Math.floor(fx) % NX, x1 = (x0 + 1) % NX, y0 = Math.min(NY - 2, Math.floor(fy)), y1 = y0 + 1, ax = fx - Math.floor(fx), ay = fy - y0, g = this.grid;
    const at = (a, x, y) => a[y * NX + x], bil = a => (at(a, x0, y0) * (1 - ax) + at(a, x1, y0) * ax) * (1 - ay) + (at(a, x0, y1) * (1 - ax) + at(a, x1, y1) * ax) * ay;
    out[0] = bil(g.u); out[1] = bil(g.v); out[2] = bil(g.temp); return out;
  },

  // ---- temperature wash
  async setTemp(on) {
    if (!on) { if (this.tempLayer) this.tempLayer.show = false; viewer.scene.requestRender(); return; }
    if (this.tempLayer && this.tempLayer.show) return;
    await this.load();
    if (!this.tempLayer) {
      const cv = document.createElement('canvas'); cv.width = 360; cv.height = 180; const cx = cv.getContext('2d'), img = cx.createImageData(360, 180), o = [0, 0, 0];
      for (let y = 0; y < 180; y++) for (let x = 0; x < 360; x++) {
        this.sample(x - 180 + 0.5, 90 - y - 0.5, o); const [r, g, b] = ramp(o[2]), i = (y * 360 + x) * 4; img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
      const p = await C.SingleTileImageryProvider.fromUrl(cv.toDataURL(), { rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90), credit: new C.Credit('Wind and temperature: Open-Meteo.com (CC BY 4.0)') });
      this.tempLayer = viewer.imageryLayers.addImageryProvider(p); this.tempLayer.alpha = 0.6;
    }
    this.tempLayer.show = true; viewer.imageryLayers.raiseToTop(this.tempLayer); viewer.scene.requestRender();
  },
  dropTemp() { if (this.tempLayer) { viewer.imageryLayers.remove(this.tempLayer, true); this.tempLayer = null; } },

  // ---- wind particles
  async setWind(on) {
    if (!on) { this.windOn = false; cancelAnimationFrame(this.raf); if (this.canvas) this.canvas.style.display = 'none'; return; }
    if (this.windOn) return;   // already running (the panel calls this on every animation step)
    this.windOn = true; await this.load().catch(e => { this.windOn = false; throw e; });
    if (!this.windOn) return;   // closed while loading
    if (!this.canvas) this.makeCanvas();
    this.windOn = true; this.canvas.style.display = 'block'; this.resize(); this.parts = Array.from({ length: COUNT }, () => this.spawn({}));
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.last = null; cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.frame());
  },
  makeCanvas() {
    const cv = document.createElement('canvas'); cv.id = 'windcv'; cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:3';
    document.body.append(cv); this.canvas = cv; this.ctx = cv.getContext('2d'); addEventListener('resize', () => this.windOn && this.resize());
  },
  resize() { const dpr = Math.min(devicePixelRatio || 1, PHONE ? 1.5 : 2); this.canvas.width = Math.round(innerWidth * dpr); this.canvas.height = Math.round(innerHeight * dpr); this.dpr = dpr; },
  spawn(p) {   // a random point, preferably on the side of the Earth that faces the camera
    this.camDist = this.camDist || C.Cartesian3.magnitude(camera.positionWC);
    for (let tries = 0; tries < 6; tries++) {
      p.lon = Math.random() * 360 - 180; p.lat = Math.asin(Math.random() * 2 - 1) * 180 / Math.PI;
      if (tries === 5 || this.facing(p.lon, p.lat)) break;
    }
    p.age = Math.floor(Math.random() * 90); p.life = 70 + Math.floor(Math.random() * 60); p.px = NaN; p.py = NaN; return p;
  },
  facing(lon, lat) {   // is the point on the visible hemisphere? (dot with the camera position beats the horizon)
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, c = camera.positionWC, cr = Math.cos(la);
    return (cr * Math.cos(lo) * c.x + cr * Math.sin(lo) * c.y + Math.sin(la) * c.z) * R > R * R + 0.07 * R * this.camDist;   // a margin keeps the near-horizon pile-up off
  },
  frame() {
    if (!this.windOn) return;
    this.raf = requestAnimationFrame(() => this.frame());
    this.camDist = C.Cartesian3.magnitude(camera.positionWC);
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, dpr = this.dpr;
    const hidden = !viewer.useDefaultRenderLoop || document.body.classList.contains('lookup') || camHeight() > 2.5e8;
    this.canvas.style.visibility = hidden ? 'hidden' : 'visible'; if (hidden) return;
    // the camera moved: old streaks no longer line up with the globe
    const c = camera.positionWC, d = camera.directionWC, key = [c.x, c.y, c.z, d.x, d.y, d.z], moved = !this.last || key.some((v, i) => Math.abs(v - this.last[i]) > 1e-6 * (i < 3 ? R : 1)); this.last = key;
    if (moved) { ctx.clearRect(0, 0, W, H); for (const p of this.parts) p.px = NaN; }
    else { ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,0.07)'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
    const k = Math.max(0.04, Math.min(1, camHeight() / 2.0e7)) * 0.9 / 111e3 * 900, s = [0, 0, 0], buckets = COLORS.map(() => []);   // degrees per m/s per frame
    const pos = new C.Cartesian3(), win = new C.Cartesian2();
    for (const p of this.parts) {
      this.sample(p.lon, p.lat, s); const speed = Math.hypot(s[0], s[1]);
      p.lon += s[0] * k / Math.max(0.2, Math.cos(p.lat * Math.PI / 180)); p.lat += s[1] * k; p.age++;
      if (p.age > p.life || p.lat > 84 || p.lat < -84) { this.spawn(p); continue; }
      if (p.lon > 180) p.lon -= 360; else if (p.lon < -180) p.lon += 360;
      if (!this.facing(p.lon, p.lat)) { p.px = NaN; continue; }
      C.Cartesian3.fromDegrees(p.lon, p.lat, 0, undefined, pos);
      const w = C.SceneTransforms.worldToWindowCoordinates(scene, pos, win); if (!w) { p.px = NaN; continue; }
      const x = w.x * dpr, y = w.y * dpr;
      if (!Number.isNaN(p.px) && Math.abs(x - p.px) < 80 && Math.abs(y - p.py) < 80) { let b = 0; while (b < EDGES.length && speed > EDGES[b]) b++; buckets[b].push(p.px, p.py, x, y); }
      p.px = x; p.py = y;
    }
    ctx.lineWidth = 1.3 * dpr; ctx.lineCap = 'round';
    buckets.forEach((seg, b) => { if (!seg.length) return; ctx.strokeStyle = COLORS[b]; ctx.globalAlpha = 0.85; ctx.beginPath(); for (let i = 0; i < seg.length; i += 4) { ctx.moveTo(seg[i], seg[i + 1]); ctx.lineTo(seg[i + 2], seg[i + 3]); } ctx.stroke(); });
    ctx.globalAlpha = 1;
  },
};

const STOPS = [[-40, [120, 60, 200]], [-20, [70, 100, 240]], [0, [40, 190, 250]], [10, [40, 210, 140]], [20, [255, 230, 60]], [30, [255, 130, 40]], [40, [220, 30, 30]]];
function ramp(t) {   // degrees C to colour
  if (t <= STOPS[0][0]) return STOPS[0][1]; if (t >= STOPS[STOPS.length - 1][0]) return STOPS[STOPS.length - 1][1];
  let i = 1; while (t > STOPS[i][0]) i++; const [t0, a] = STOPS[i - 1], [t1, b] = STOPS[i], f = (t - t0) / (t1 - t0);
  return a.map((v, j) => Math.round(v + (b[j] - v) * f));
}
