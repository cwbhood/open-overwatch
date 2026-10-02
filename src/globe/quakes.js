// Earthquakes: USGS M2.5+ in the last 24 h (the feed sends CORS headers, so no relay).
import { C, getJSON } from './env.js';
import { qkPts } from './viewer.js';
import { L, setCount } from './layers.js';
import { hooks } from './state.js';

export const Quakes = {
  list: [],
  async load() {
    const d = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
    qkPts.removeAll(); this.list = [];
    for (const f of d.features || []) {
      const [lon, lat, depth] = f.geometry.coordinates, m = f.properties.mag || 0;
      const q = { kind: 'quake', mag: m, place: f.properties.place, time: f.properties.time, depth, lat, lon, url: f.properties.url };
      q.pt = qkPts.add({ position: C.Cartesian3.fromDegrees(lon, lat, 0), pixelSize: 4 + m * 2.2, color: C.Color.fromCssColorString('#ff7b4f').withAlpha(0.75),
        outlineColor: C.Color.fromCssColorString('#ff7b4f'), outlineWidth: 1, id: q, show: L.quakes.on, disableDepthTestDistance: 0 });
      this.list.push(q);
    }
    setCount('quakes', this.list.length); hooks.updateStats();
  },
};
