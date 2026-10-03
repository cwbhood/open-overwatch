// Weather mode: live satellite cloud imagery, rain radar and satellite rain, animated over the last couple of hours.
//  - Infrared clouds: NASA GIBS, GOES-East + GOES-West + Himawari (10-minute images, ~50 min old; cold cloud tops in colour).
//    Between them they cover the Americas, the Pacific and Asia-Australia; Europe, Africa and the Indian Ocean need
//    Meteosat, which no free tile service carries.
//  - Rain radar: RainViewer's composite of national radars (10-minute frames; only where radar exists).
//  - Rain from space: NASA IMERG, global between 60 deg N and S, about 7 hours old (still).
// Nothing is fetched until the mode is opened. Frames are Cesium imagery layers made on demand; only the current frame (and
// the next, while playing) is shown, so the GPU holds a few tiles, not the whole loop.
import { C, $, toast, PHONE } from './env.js';
import { viewer, camHeight } from './viewer.js';
import { Earth } from './earth.js';
import { state, hooks } from './state.js';
import { PRESETS } from './ui.js';
import { Wind } from './wind.js';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/';
const SCHEME = () => new C.GeographicTilingScheme({ rectangle: C.Rectangle.fromDegrees(-180, -198, 396, 90), numberOfLevelZeroTilesX: 2, numberOfLevelZeroTilesY: 1 });   // see earth.js
const nasa = new C.Credit('Clouds and rain: NASA GIBS (NOAA GOES-East/West, JMA Himawari, NASA IMERG)');
const rv = new C.Credit('Radar © RainViewer.com');
const gibsProvider = (layer, time, matrix, max) => new C.UrlTemplateImageryProvider({ url: `${GIBS}${layer}/default/${time}/${matrix}/{z}/{y}/{x}.png`, tilingScheme: SCHEME(),
  rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90), tileWidth: 512, tileHeight: 512, maximumLevel: max, credit: nasa });
/** The three infrared satellites as ONE imagery layer: each 512 px tile is the three GIBS tiles drawn onto one canvas.
 *  Three layers meant up to three more textures per globe tile, and Cesium builds (and links, on the main thread) a globe
 *  shader for every texture count it meets: opening weather built 14 programs and pressing play 13 more. */
class CompositeProvider {
  constructor(urls, maximumLevel) {
    Object.assign(this, { urls, tilingScheme: SCHEME(), rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90), tileWidth: 512, tileHeight: 512, maximumLevel, minimumLevel: 0,
      tileDiscardPolicy: undefined, errorEvent: new C.Event(), credit: nasa, proxy: undefined, hasAlphaChannel: true, ready: true });
  }
  getTileCredits() { return undefined; }
  pickFeatures() { return undefined; }
  requestImage(x, y, level) {
    const url = u => u.replace('{z}', level).replace('{y}', y).replace('{x}', x);
    return Promise.all(this.urls.map(u => C.Resource.fetchImage({ url: url(u), preferImageBitmap: false }).catch(() => null))).then(imgs => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 512; const cx = cv.getContext('2d');
      for (const im of imgs) if (im) cx.drawImage(im, 0, 0, 512, 512);
      return cv;
    });
  }
}
const SATS = [['GOES-East_ABI_Band13_Clean_Infrared'], ['GOES-West_ABI_Band13_Clean_Infrared'], ['Himawari_AHI_Band13_Clean_Infrared']];
const FRAMES = PHONE ? 4 : 6, STEP = 30 * 60e3, PLAY_MS = 900;
const iso = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';
const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + ' UTC';

async function haveWms(layer, time, minBytes) {   // whole-world 256x128 image: WMS answers a missing time with a blank image (WMTS: a 404 without CORS headers)
  try { const r = await fetch(`https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${layer}&STYLES=&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=256&HEIGHT=128&FORMAT=image/png&TRANSPARENT=true&TIME=${time}`); return r.ok && (await r.blob()).size > minBytes; } catch (e) { return false; }
}
async function latest(layer, step, from, to, minBytes) {   // newest time (ms) in [to, from] that has data
  for (let t = Math.floor(from / step) * step; t >= to; t -= step) if (await haveWms(layer, iso(t), minBytes)) return t;
  return null;
}

export const Weather = {
  on: false, playing: false, frame: FRAMES - 1, timer: 0, ready: null, layers: new Map(),
  sets: { ir: { name: 'Infrared clouds', on: true }, radar: { name: 'Rain radar', on: true }, rain: { name: 'Rain from space', on: false }, wind: { name: 'Wind', on: false }, temp: { name: 'Temperature', on: false } },
  ir: [], radar: [], rainAt: 0,

  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const now = Date.now();
      const [ir, rainAt, maps] = await Promise.all([
        Promise.all(SATS.map(async ([layer]) => ({ layer, latest: await latest(layer, 600e3, now - 25 * 60e3, now - 4 * 3600e3, 2000) }))),
        latest('IMERG_Precipitation_Rate_30min', 1800e3, now - 3 * 3600e3, now - 30 * 3600e3, 1500),
        fetch('https://api.rainviewer.com/public/weather-maps.json').then(r => r.json()).catch(() => null)]);
      this.ir = ir.filter(s => s.latest); this.rainAt = rainAt || 0;
      this.radar = maps && maps.radar ? maps.radar.past.map(f => ({ time: f.time * 1000, url: maps.host + f.path })) : [];
      this.end = this.ir.length ? Math.max(...this.ir.map(s => s.latest)) : Math.max(0, ...this.radar.map(f => f.time));   // the timeline is the satellites' clock; radar follows to the nearest frame
      if (!this.end) throw new Error('no weather data reachable');
    })().catch(e => { this.ready = null; throw e; });
    return this.ready;
  },

  // the imagery layers of one frame of one set (made once, hidden until shown)
  layersFor(set, k) {
    const key = set + k; if (this.layers.has(key)) return this.layers.get(key);
    const at = this.end - (FRAMES - 1 - k) * STEP, out = [];
    if (set === 'ir' && this.ir.length) out.push(this.add(new CompositeProvider(this.ir.map(s => `${GIBS}${s.layer}/default/${iso(s.latest - (FRAMES - 1 - k) * STEP)}/2km/{z}/{y}/{x}.png`), 5)));
    else if (set === 'radar' && this.radar.length) {
      const f = this.radar.reduce((a, b) => Math.abs(b.time - at) < Math.abs(a.time - at) ? b : a);
      out.push(this.add(new C.UrlTemplateImageryProvider({ url: `${f.url}/256/{z}/{x}/{y}/2/1_1.png`, maximumLevel: 7, credit: rv })));
    } else if (set === 'rain' && this.rainAt) out.push(this.add(gibsProvider('IMERG_Precipitation_Rate_30min', iso(this.rainAt), '2km', 5)));
    this.layers.set(key, out); return out;
  },
  add(provider) { const l = viewer.imageryLayers.addImageryProvider(provider); l.show = false; l.alpha = 0.9; return l; },

  show() {   // current frame (and the next while playing) of the sets that are on
    const want = new Set([this.frame, ...(this.playing ? [(this.frame + 1) % FRAMES] : [])]);
    for (const set of ['ir', 'rain', 'radar']) {   // bottom to top
      const still = set === 'rain', ks = still ? [FRAMES - 1] : [...Array(FRAMES).keys()];
      for (const k of ks) {
        const on = this.on && this.sets[set].on && (still || want.has(k));
        if (on) this.layersFor(set, k);
        for (const l of this.layers.get(set + k) || []) {
          l.show = on && !Earth.hidden; l.alpha = (set === 'ir' ? 0.92 : set === 'rain' ? 0.7 : 0.85) * (still || k === this.frame ? 1 : 0.001);
          if (l.show) viewer.imageryLayers.raiseToTop(l);
        }
      }
    }
    const fields = (set, f) => { if (this.on && this.sets[set].on) f(true).catch(() => { this.sets[set].on = false; this.build(); toast('Wind and temperature data is not reachable right now'); }); else f(false); };
    fields('wind', on => Wind.setWind(on)); fields('temp', on => Wind.setTemp(on));
    viewer.scene.requestRender();
    this.label();
  },
  label() {
    const at = this.end - (FRAMES - 1 - this.frame) * STEP, ago = Math.round((Date.now() - at) / 60e3);
    $('#wxTime').textContent = `${hhmm(at)} · ${ago >= 90 ? Math.round(ago / 60) + ' h' : ago + ' min'} ago`;
    $('#wxSlider').value = this.frame; $('#wxPlay').textContent = this.playing ? '❚❚' : '▶';
    const rain = this.sets.rain.on && this.rainAt ? ` Rain from space: ${hhmm(this.rainAt)}.` : '';
    const field = (this.sets.wind.on || this.sets.temp.on) && Wind.grid ? ` Wind/temperature: ${Wind.grid.at.slice(11)} UTC (Open-Meteo).` : '';
    $('#wxNote').textContent = field + (this.ir.length ? `Infrared: ${this.ir.length} of 3 satellites reached.` : 'No infrared images reachable.') + (this.sets.radar.on && !this.radar.length ? ' Radar unreachable.' : '') + rain;
  },
  set(frame) { this.frame = (frame + FRAMES) % FRAMES; this.show(); },
  play(on) {
    this.playing = on; clearInterval(this.timer);
    if (on) { this.timer = setInterval(() => this.set(this.frame + 1), PLAY_MS); }
    this.show();
  },

  async open() {
    if (this.on) return;
    this.on = true; state.weather = true; $('#wx').classList.add('show'); Earth.apply(); hooks.applyVisibility();
    if (camHeight() < 3.0e6) PRESETS.earth();   // weather is a whole-Earth picture
    try { await this.init(); } catch (e) { this.close(); toast('Weather data is not reachable right now'); return; }
    this.frame = FRAMES - 1; this.build(); this.show();
  },
  close() {
    this.on = false; state.weather = false; this.play(false); $('#wx').classList.remove('show');
    for (const ls of this.layers.values()) for (const l of ls) viewer.imageryLayers.remove(l, true);
    Wind.setWind(false); Wind.setTemp(false); Wind.dropTemp();
    this.layers.clear(); Earth.apply(); hooks.applyVisibility(); viewer.scene.requestRender();
    document.querySelector('[data-go="weather"]')?.classList.remove('on');
  },
  /** Opening weather the first time froze the globe for ~0.6 s (Cesium links a new globe shader for every count of imagery layers
   *  on a tile; later opens are smooth because the programs stay cached). Here a few blank layers (a 1 px data: image, no
   *  network) are shown for a moment while the page is idle, one more every few frames, so those programs are built before
   *  anyone asks. Layer properties matter (alpha below 1 is a shader flag), so they match the real ones. */
  prewarm() {
    if (this.warmed || this.on || state.weather || Earth.hidden) return; this.warmed = true;
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const layers = []; let frames = 0;
    const off = viewer.scene.postRender.addEventListener(() => {
      frames++;
      if (frames % 4 === 1 && layers.length < 5) { const l = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: px, maximumLevel: 3 })); l.alpha = 0.9; layers.push(l); }
      if (frames >= 40 || this.on) { off(); for (const l of layers) viewer.imageryLayers.remove(l, true); viewer.scene.requestRender(); }
    });
    viewer.scene.requestRender();
  },
  toggle() { this.on ? this.close() : this.open(); },
  build() {
    $('#wxSets').innerHTML = Object.entries(this.sets).map(([id, s]) => `<button class="chipbtn${s.on ? ' on' : ''}" data-set="${id}">${s.name}</button>`).join('');
    $('#wxSlider').max = FRAMES - 1;
  },
};

export function initWeather() {
  const el = document.createElement('div'); el.id = 'wx'; el.className = 'glass';
  el.innerHTML = `<div class="wx-head"><b>Weather</b><span id="wxTime">loading…</span><button class="x" aria-label="Close weather">×</button></div>
    <div id="wxSets" class="wx-sets"></div>
    <div class="wx-play"><button id="wxPlay" class="chipbtn" aria-label="Play or pause">▶</button><input id="wxSlider" type="range" min="0" max="${FRAMES - 1}" value="${FRAMES - 1}" step="1" aria-label="Time"></div>
    <div id="wxNote" class="note"></div>`;
  document.body.append(el);
  el.querySelector('.x').onclick = () => Weather.close();
  $('#wxPlay').onclick = () => Weather.play(!Weather.playing);
  $('#wxSlider').oninput = e => { Weather.play(false); Weather.set(+e.target.value); };
  $('#wxSets').onclick = e => { const b = e.target.closest('[data-set]'); if (!b) return; const s = Weather.sets[b.dataset.set]; s.on = !s.on; b.classList.toggle('on', s.on); Weather.show(); };
}
