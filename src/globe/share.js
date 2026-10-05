// Share a view: a link that puts the next person where you are, with the same layers, the same time and (if open) the same
// weather sources and country. Everything lives in the URL hash (nothing is stored on a server):
//   #c=lon,lat,height,heading,pitch  &l=ids,of,layers,on  &w=ir,wind  &t=julianDate,rate  &k=ISO2  &f=CALLSIGN
// and #go=tonight (a panel that needs no camera, e.g. from the landing page)
import { C, $, toast } from './env.js';
import { camera, camHeight } from './viewer.js';
import { LAYERS, syncDock } from './layers.js';
import { Time } from './time.js';
import { hooks, state } from './state.js';
import { Weather } from './weather.js';
import { Country } from './country.js';
import { select, PRESETS } from './ui.js';
import { Flight } from './flight.js';
import { encodeView, decodeView, decodeExtras } from '../core/viewlink.js';

const r = (v, n) => +v.toFixed(n);

export const Share = {
  link() {
    const c = camera.positionCartographic;
    return location.origin + location.pathname + '#' + encodeView({ lon: C.Math.toDegrees(c.longitude), lat: C.Math.toDegrees(c.latitude), height: c.height, heading: C.Math.toDegrees(camera.heading), pitch: C.Math.toDegrees(camera.pitch),
      layers: LAYERS.filter(l => l.on).map(l => l.id), weather: Weather.on ? Object.entries(Weather.sets).filter(([, s]) => s.on).map(([k]) => k) : null,
      time: Time.live ? null : { jd: Time.jd(), rate: Time.rate }, country: state.selected && state.selected.kind === 'country' ? state.selected.iso : null, flight: Flight.shareId });
  },
  /** An <iframe> for someone else's page: this view, in embed mode. */
  embedCode() { const u = this.link().replace('#', '#embed=1&'); return `<iframe src="${u.replace(/"/g, '&quot;')}" width="100%" height="480" style="border:0;border-radius:12px" loading="lazy" allow="fullscreen" title="Open Overwatch: the Earth, live"></iframe>`; },
  async copyEmbed() {
    const code = this.embedCode();
    try { await navigator.clipboard.writeText(code); toast('Embed code copied: paste it into any web page', 3500); } catch (e) { window.prompt('Copy this embed code:', code); }
  },
  async copy() {
    const url = this.link();
    try { await navigator.clipboard.writeText(url); toast(Flight.shareId ? `Link copied: it finds ${Flight.shareId} wherever it is when opened` : 'Link to this view copied', 3000); }
    catch (e) { window.prompt('Copy this link:', url); }
  },
  /** Apply a link's hash (called once, after the boot screen is gone). Returns true if there was one. */
  async restore() {
    const v = decodeView(location.hash), x = decodeExtras(location.hash);
    if (!v) { if (x.go) { const b = document.querySelector(`#band [data-go="${x.go}"]`); if (b) b.click(); else PRESETS[x.go](); } if (x.flight) Flight.find(x.flight); return !!(x.go || x.flight); }
    if (v.layers) { const on = new Set(v.layers); for (const l of LAYERS) l.on = on.has(l.id); syncDock(); hooks.applyVisibility(); }
    if (v.time) Time.setJd(v.time.jd, v.time.rate);
    camera.setView({ destination: C.Cartesian3.fromDegrees(v.lon, v.lat, Math.max(150, v.height)), orientation: { heading: C.Math.toRadians(v.heading), pitch: C.Math.toRadians(v.pitch), roll: 0 } });
    if (v.weather) { for (const [k, s] of Object.entries(Weather.sets)) s.on = v.weather.includes(k); await Weather.open(); Weather.build(); Weather.show(); }
    if (v.country) { const o = await Country.byIso(v.country).catch(() => null); if (o) select(o); }
    if (v.flight) Flight.find(v.flight);
    return true;
  },
};
