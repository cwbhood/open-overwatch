// 3D buildings: Cesium's worldwide OpenStreetMap buildings (a streamed 3D Tiles set from Cesium ion). They need an ion access
// token, which is free but belongs to whoever publishes the site (the one bundled with CesiumJS is for evaluation only, so this
// code never uses it unless the page is opened with ?ion=dev on a local server). Set yours once, in the browser console:
//     OO3D.setIonToken('your token')        (kept in this browser; to ship it for everyone, put it in config.js)
// Buildings show below ~150 km and, without terrain on this globe, sit on the ellipsoid: in hilly places they float or sink a little.
import { C, store, toast } from './env.js';
import { viewer, camHeight } from './viewer.js';
import { L } from './layers.js';
import { ION_TOKEN } from './config.js';

const DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).get('ion') === 'dev';
export const token = () => ION_TOKEN || store.get('ionToken', '') || (DEV ? C.Ion.defaultAccessToken : '');

export const Buildings = {
  tileset: null, loading: false, shown: false,
  setToken(t) { store.set('ionToken', String(t || '').trim()); toast(t ? 'Token saved: turn on "3D buildings" in Layers' : 'Token removed', 4000); },
  async apply() {
    if (!L.buildings.on) { if (this.tileset) this.tileset.show = false; return; }
    if (!token()) { L.buildings.on = false; toast('3D buildings need a free Cesium ion token: OO3D.setIonToken("…") in the console (see src/globe/buildings.js)', 9000); document.querySelector('[data-ly="buildings"]')?.classList.add('off'); return; }
    if (!this.tileset && !this.loading) {
      this.loading = true;
      try { C.Ion.defaultAccessToken = token(); this.tileset = await C.createOsmBuildingsAsync(); viewer.scene.primitives.add(this.tileset); this.tick(); setInterval(() => this.tick(), 800); }
      catch (e) { console.warn('buildings', e); L.buildings.on = false; toast('3D buildings could not load: is the ion token valid?', 6000); }
      this.loading = false;
    }
    this.tick();
  },
  tick() { if (this.tileset) { this.tileset.show = L.buildings.on && camHeight() < 1.5e5; viewer.scene.requestRender(); } },
};
