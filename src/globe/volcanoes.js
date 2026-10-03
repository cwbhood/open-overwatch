// The world's volcanoes: ~3,100 from Wikidata (CC0, data/volcanoes.json, made by brand/tools/make_volcanoes.py). Dots appear below
// ~15,000 km, sized by summit height; extinct ones are dimmer. The data says what a volcano is, not whether it is erupting.
// Loaded the first time the layer is on.
import { C } from './env.js';
import { scene } from './viewer.js';
import { L, setCount } from './layers.js';
import { fetchAsset } from '../core/assets.js';

const pts = scene.primitives.add(new C.PointPrimitiveCollection());
const HOT = C.Color.fromCssColorString('#ff5a36'), OLD = C.Color.fromCssColorString('#9a8f88');
export const Volcanoes = {
  list: [], loading: null,
  load() {
    if (!this.loading) this.loading = fetchAsset('data/volcanoes.json', 'json').then(d => {
      const ix = Object.fromEntries(d.cols.map((c, i) => [c, i]));
      for (const r of d.rows) {
        const o = { kind: 'volcano', name: r[ix.name], lat: r[ix.lat], lon: r[ix.lon], elevationM: r[ix.elevationM], country: r[ix.country], type: r[ix.type], wiki: r[ix.wiki] };
        const dead = /extinct|dormant/i.test(o.type), size = 4 + Math.min(5, (o.elevationM || 1500) / 1000);
        o.pt = pts.add({ position: C.Cartesian3.fromDegrees(o.lon, o.lat, 0), pixelSize: size, color: (dead ? OLD : HOT).withAlpha(dead ? 0.7 : 0.95), outlineColor: (dead ? OLD : HOT).withAlpha(0.3), outlineWidth: 3,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1.5e7), show: L.volcanoes.on, id: o });
        this.list.push(o);
      }
      setCount('volcanoes', this.list.length);
    }).catch(e => { this.loading = null; console.warn('volcanoes', e); });
    return this.loading;
  },
  apply() { pts.show = L.volcanoes.on; if (L.volcanoes.on && !this.loading) this.load(); scene.requestRender(); },
};
