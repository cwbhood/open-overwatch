// Lighthouses of the world: every man_made=lighthouse in OpenStreetMap (data/lighthouses.json, made by
// brand/tools/make_lighthouses.py; (c) OpenStreetMap contributors, ODbL). Dots appear below ~4,000 km; click one for its
// height, light, range and builder. Loaded on first use, so a visitor with the layer off never downloads it.
import { C } from './env.js';
import { scene, camHeight } from './viewer.js';
import { L, setCount } from './layers.js';
import { fetchAsset } from '../core/assets.js';

const pts = scene.primitives.add(new C.PointPrimitiveCollection());
const COLOR = C.Color.fromCssColorString('#ffe27a');
export const Lighthouses = {
  list: [], loading: null,
  load() {
    if (!this.loading) this.loading = fetchAsset('data/lighthouses.json', 'json').then(d => {
      const ix = Object.fromEntries(d.cols.map((c, i) => [c, i]));
      this.credit = d.source; this.updated = d.updated;
      for (const r of d.rows) {
        const o = { kind: 'lighthouse', lat: r[ix.lat], lon: r[ix.lon], name: r[ix.name], heightM: r[ix.heightM], colour: r[ix.colour], character: r[ix.character],
          rangeNm: r[ix.rangeNm], built: r[ix.built], operator: r[ix.operator], wiki: r[ix.wiki], status: r[ix.status] };
        o.pt = pts.add({ position: C.Cartesian3.fromDegrees(o.lon, o.lat, 0), pixelSize: 4, color: COLOR.withAlpha(o.status ? 0.45 : 0.95), id: o,
          show: L.lighthouses.on, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 4.0e6), disableDepthTestDistance: 0 });
        this.list.push(o);
      }
      setCount('lighthouses', this.list.length);
    }).catch(e => { this.loading = null; console.warn('lighthouses', e); });
    return this.loading;
  },
  apply() { pts.show = L.lighthouses.on; if (L.lighthouses.on && !this.loading) this.load(); },
};
