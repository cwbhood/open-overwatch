// Views (presets), the legend, your location, and the ISS follow mode.
import { $, $$, C, esc, late, Net, pick, Store, toast } from './util.js';
import { map, vecRenderer } from './mapview.js';
import { Dyn, Layers } from './engine.js';
import { Detail, Tracks } from './detail.js';
import { Air } from './aircraft.js';
import { Sats, lySats } from './satellites.js';

/* ============================================================ PRESETS ("views") */
export const PRESETS = [
  { id: 'me', name: 'Around me', desc: 'Aircraft, cameras and weather near you', layers: ['air_local', 'air_mil', 'air_emg', 'cams', 'sats', 'quakes', 'storms', 'nws', 'terminator', 'osm_scan'], sats: ['stations'], go: 'locate' },
  { id: 'mil', name: 'Military air picture', desc: 'Every military-flagged aircraft in the world', layers: ['air_mil', 'air_emg', 'air_local', 'terminator', 'osm_scan'], sats: ['stations'], view: [40, 20, 3] },
  { id: 'space', name: 'Space', desc: 'ISS, bright satellites, GPS, aurora', layers: ['sats', 'aurora', 'terminator', 'osm_scan'], sats: ['stations', 'visual', 'gps-ops'], go: 'iss' },
  { id: 'hazards', name: 'Storms & quakes', desc: 'Earthquakes, cyclones, disasters, US warnings, radar', layers: ['quakes', 'events', 'gdacs', 'storms', 'nws', 'radar', 'terminator', 'osm_scan'], view: [20, -40, 3] },
  { id: 'all', name: 'Everything', desc: 'All default layers at once', layers: ['air_local', 'air_mil', 'air_emg', 'sats', 'ships_fi', 'quakes', 'events', 'storms', 'nws', 'cams', 'terminator', 'osm_scan', 'news', 'gdacs'], sats: ['stations', 'visual'] },
];
export const Presets = {
  current: Store.get('preset', null),
  apply(id, { fly = true } = {}) {
    const p = PRESETS.find(x => x.id === id); if (!p) return;
    Layers.apply(p.layers); if (p.sats) this.satOpt('sat_groups', p.sats);
    this.current = id; Store.set('preset', id); $$('.view').forEach(b => b.classList.toggle('on', b.dataset.preset === id));
    // clear the old selection and follow BEFORE flying: the ISS follow below selects the ISS, draws its track and toasts its own hint
    Detail.clear(); Fun.issFollow = false; Fun.issPending = 0; toast(`View: ${p.name}`);
    if (fly) { if (p.view) map.flyTo([p.view[0], p.view[1]], p.view[2], { duration: 1 }); else if (p.go === 'locate') Locate.go(); else if (p.go === 'iss') Fun.followIss(); }
    late.Brief.render();
  },
  // satellite options changed by a view or the ISS shortcut: redraw the Satellites pills to match, and reload the groups
  // (after any reload already in flight, which read the old ones)
  satOpt(k, v) {
    Layers.setOpt(k, v); const sr = $('.subrow[data-sub="sats"]'); if (sr) lySats.sub(sr);
    if (k === 'sat_groups' && lySats.on) { const go = () => { this.satWait = null; if (!lySats.on) return; if (Sats.loading) this.satWait = setTimeout(go, 1000); else Sats.reload(); }; if (!this.satWait) go(); }
  },
  build() { const root = $('#views'); for (const p of PRESETS) { const b = document.createElement('button'); b.type = 'button'; b.className = 'view' + (this.current === p.id ? ' on' : ''); b.dataset.preset = p.id; b.innerHTML = `<b>${esc(p.name)}</b><small>${esc(p.desc)}</small>`; b.addEventListener('click', () => this.apply(p.id)); root.appendChild(b); } },
};
export const LEGEND = [['civil aircraft', C.civ], ['military', C.mil], ['emergency squawk', C.emg], ['degraded GPS', '#ff9ad5'], ['satellite', C.sat, 'dm'], ['vessel', C.ship], ['radiosonde', C.bal, 'rd'], ['camera', C.cam, 'rd'], ['earthquake', C.qk, 'rd'], ['event', C.evt, 'rd'], ['storm', '#7fd0ff', 'rd'], ['news', C.news, 'rd']];
export function legendHtml() { return LEGEND.map(([n, c, cls]) => `<span><i class="${cls || ''}" style="--c:${c}"></i>${esc(n)}</span>`).join(''); }

/* ============================================================ LOCATION */
export const Locate = {
  pos: Store.get('pos', null), // {lat, lon, how, t}
  refresh() {
    return new Promise((resolve, reject) => {
      const ok = (lat, lon, how) => { this.pos = { lat, lon, how, t: Date.now() }; Store.set('pos', this.pos); resolve(this.pos); };
      const ip = () => Net.json('https://ipapi.co/json/').then(d => { if (d.latitude) ok(d.latitude, d.longitude, 'approximate (IP)'); else reject(new Error('no fix')); }).catch(reject);
      // fall back to an IP lookup when the device can't get a fix, but not when the user refused location access
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => ok(p.coords.latitude, p.coords.longitude, 'device'), e => e && e.code === 1 ? reject(new Error('location access was denied')) : ip(), { timeout: 8000, maximumAge: 60000 }); else ip();
    });
  },
  async go() { try { const p = await this.refresh(); map.flyTo([p.lat, p.lon], 8, { duration: 1 }); L.circleMarker([p.lat, p.lon], { radius: 6, color: C.accent, weight: 2, fillOpacity: .2, interactive: false, renderer: vecRenderer }).addTo(Tracks.group); toast(`Centered on your ${p.how} position`); late.Brief.render(); } catch (e) { toast('Could not determine location: ' + e.message, 'alert'); } },
};

/* ============================================================ FUN */
export const Fun = {
  surprise() {
    const pool = [...Dyn.air.values()].filter(a => a.mil && !a.ground && Air.notable(a)); const pool2 = pool.length ? pool : [...Dyn.air.values()].filter(a => a.mil && !a.ground);
    if (!pool2.length) { toast(Layers.on('air_mil') ? 'No military aircraft loaded yet — give the feed a few seconds' : 'Turn on "Military aircraft, worldwide" first', 'alert'); return; }
    const a = pick(pool2); map.flyTo([a.lat, a.lon], 7, { duration: 1.2 }); Detail.show('air', a, a.hex); setTimeout(() => Air.trail(a.hex), 1300);
    toast(`${a.flight || a.r || a.hex.toUpperCase()} · ${a.desc || a.t || 'military'} · ${Air.roleOf(a)} · near ${Air.where(a)}`);
  },
  followIss() {
    const iss = Sats.iss(); Air.following = null; // one follow at a time
    if (!iss || iss.lat == null) { // not loaded yet: start it, and the follow interval below picks the ISS up once it is propagated
      if (!Layers.on('sats')) Layers.set('sats', true); if (!Sats.groupsOn().includes('stations')) Presets.satOpt('sat_groups', [...Sats.groupsOn(), 'stations']);
      this.issPending = Date.now(); toast('Loading the ISS orbit… the map will follow it once it is in'); return;
    }
    this.issPending = 0; map.flyTo([iss.lat, iss.lon], Math.max(map.getZoom(), 3), { duration: 1 }); Detail.show('sat', iss, iss.id); Sats.drawTrack(iss); if (!Layers.opt('sat_tracks')) Presets.satOpt('sat_tracks', true);
    this.issFollow = true; toast('Following the ISS — pan the map to stop');
  },
  issInView() { const iss = Sats.iss(); if (!iss || iss.lat == null) return true; const b = map.getBounds(), c = b.getCenter(); return iss.lat >= b.getSouth() && iss.lat <= b.getNorth() && Math.abs(((iss.lon - c.lng) % 360 + 540) % 360 - 180) <= (b.getEast() - b.getWest()) / 2; },
};
// the ISS follow stops on a drag, or when anything else (Brief, search, Locate, an aircraft follow…) moves the ISS out of view;
// it never pans over another move in progress (panTo would cancel that flyTo)
export let mapMovingAt = 0;
map.on('dragstart', () => { Fun.issFollow = false; Fun.issPending = 0; });
map.on('movestart', () => { mapMovingAt = Date.now(); });
map.on('moveend', () => { mapMovingAt = 0; if (Fun.issFollow && !Fun.issInView()) Fun.issFollow = false; });
setInterval(() => {
  if (Fun.issPending) { const iss = Sats.iss(); if (!Layers.on('sats') || Date.now() - Fun.issPending > 120e3) Fun.issPending = 0; else if (iss && iss.lat != null) Fun.followIss(); }
  if (Fun.issFollow) { const iss = Sats.iss(); if (!Layers.on('sats')) Fun.issFollow = false; else if (iss && iss.lat != null && !document.hidden && Date.now() - mapMovingAt > 4000) map.panTo([iss.lat, iss.lon], { animate: true, duration: .8 }); }
}, 2500);
