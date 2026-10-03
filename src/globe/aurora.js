// The aurora oval, live: NOAA SWPC's OVATION model (a 1-degree grid of the chance of seeing aurora, updated every few minutes,
// public domain, sends CORS). Painted once into a 360 x 180 picture and laid over the Earth as a single imagery layer: green
// where it is faint, through yellow to pink where it is strong. Loaded only while the layer is on; refreshed every 10 minutes.
import { C } from './env.js';
import { viewer } from './viewer.js';
import { L, setCount } from './layers.js';

const URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const STOPS = [[3, [60, 255, 160]], [25, [110, 255, 110]], [55, [240, 255, 110]], [80, [255, 160, 90]], [100, [255, 80, 200]]];
const color = p => { let i = 1; while (i < STOPS.length - 1 && p > STOPS[i][0]) i++; const [p0, a] = STOPS[i - 1], [p1, b] = STOPS[i], f = Math.max(0, Math.min(1, (p - p0) / (p1 - p0))); return a.map((v, j) => Math.round(v + (b[j] - v) * f)); };

export const Aurora = {
  layer: null, loading: false, at: '', peak: 0, tried: 0,
  async load() {
    if (this.loading) return; this.loading = true; this.tried = Date.now();
    try {
      const d = await (await fetch(URL)).json();
      const cv = document.createElement('canvas'); cv.width = 360; cv.height = 181; const cx = cv.getContext('2d'), img = cx.createImageData(360, 181); let peak = 0;
      for (const [lon, lat, p] of d.coordinates) {
        if (p < 3) continue; const x = (lon >= 180 ? lon - 360 : lon) + 180, y = 90 - lat; if (x < 0 || x > 359 || y < 0 || y > 180) continue;
        const [r, g, b] = color(p), i = (y * 360 + x) * 4; img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = Math.min(235, 40 + p * 4); if (p > peak) peak = p;
      }
      cx.putImageData(img, 0, 0);
      const provider = await C.SingleTileImageryProvider.fromUrl(cv.toDataURL(), { rectangle: C.Rectangle.fromDegrees(-180, -90.5, 180, 90.5), credit: new C.Credit('Aurora forecast: NOAA Space Weather Prediction Center (OVATION)') });
      const old = this.layer; this.layer = viewer.imageryLayers.addImageryProvider(provider); this.layer.alpha = 0.9; if (old) viewer.imageryLayers.remove(old, true);
      this.at = d['Forecast Time']; this.peak = peak; setCount('aurora', 0); this.apply();
    } catch (e) { console.warn('aurora', e); } finally { this.loading = false; }
  },
  apply() {
    if (this.layer) { this.layer.show = L.aurora.on; if (L.aurora.on) viewer.imageryLayers.raiseToTop(this.layer); viewer.scene.requestRender(); }
    if (L.aurora.on && (!this.layer || Date.now() - this.tried > 10 * 60e3)) this.load();
  },
};
