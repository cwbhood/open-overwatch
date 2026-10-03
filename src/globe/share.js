// Share a view: a link that puts the next person where you are, with the same layers, the same time and (if open) the same
// weather sources and country. Everything lives in the URL hash (nothing is stored on a server):
//   #c=lon,lat,height,heading,pitch  &l=ids,of,layers,on  &w=ir,wind  &t=julianDate,rate  &k=ISO2
import { C, $, toast } from './env.js';
import { camera, camHeight } from './viewer.js';
import { LAYERS, syncDock } from './layers.js';
import { Time } from './time.js';
import { hooks, state } from './state.js';
import { Weather } from './weather.js';
import { Country } from './country.js';
import { select } from './ui.js';

const r = (v, n) => +v.toFixed(n);

export const Share = {
  link() {
    const c = camera.positionCartographic, p = new URLSearchParams();
    p.set('c', [r(C.Math.toDegrees(c.longitude), 4), r(C.Math.toDegrees(c.latitude), 4), Math.round(c.height), r(C.Math.toDegrees(camera.heading), 1), r(C.Math.toDegrees(camera.pitch), 1)].join(','));
    p.set('l', LAYERS.filter(l => l.on).map(l => l.id).join(','));
    if (Weather.on) p.set('w', Object.entries(Weather.sets).filter(([, s]) => s.on).map(([k]) => k).join(','));
    if (!Time.live) p.set('t', r(Time.jd(), 5) + ',' + Time.rate);
    if (state.selected && state.selected.kind === 'country') p.set('k', state.selected.iso);
    return location.origin + location.pathname + '#' + p.toString();
  },
  async copy() {
    const url = this.link();
    try { await navigator.clipboard.writeText(url); toast('Link to this view copied', 3000); }
    catch (e) { window.prompt('Copy this link:', url); }
  },
  /** Apply a link's hash (called once, after the boot screen is gone). Returns true if there was one. */
  async restore() {
    if (!location.hash || location.hash.length < 4) return false;
    const p = new URLSearchParams(location.hash.slice(1)), c = (p.get('c') || '').split(',').map(Number);
    if (c.length < 3 || c.slice(0, 3).some(v => !Number.isFinite(v))) return false;
    if (p.has('l')) {
      const on = new Set(p.get('l').split(','));
      for (const l of LAYERS) l.on = on.has(l.id);
      syncDock(); hooks.applyVisibility();
    }
    if (p.has('t')) { const [jd, rate] = p.get('t').split(',').map(Number); if (Number.isFinite(jd)) Time.setJd(jd, Number.isFinite(rate) ? rate : 1); }
    camera.setView({ destination: C.Cartesian3.fromDegrees(c[0], c[1], Math.max(150, c[2])), orientation: { heading: C.Math.toRadians(c[3] || 0), pitch: C.Math.toRadians(Number.isFinite(c[4]) ? c[4] : -90), roll: 0 } });
    if (p.has('w')) { for (const [k, s] of Object.entries(Weather.sets)) s.on = p.get('w').split(',').includes(k); await Weather.open(); Weather.build(); Weather.show(); }
    if (p.has('k')) { const o = await Country.byIso(p.get('k')).catch(() => null); if (o) select(o); }
    return true;
  },
};
