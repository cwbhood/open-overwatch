// Boot: splash, initial layers and feeds, keyboard, and the window.OW console handle.
import { $, Log, Net, Relay, Sound, Store, esc, fmt, regionOf, sleep, toast } from './util.js';
import { map } from './mapview.js';
import { Dyn, Feeds, Layers, Points, Sel, UI, glyphs, requestDraw, runFeed } from './engine.js';
import { Detail, Hover, Tracks, applyLayoutMode, openSheet, showTab } from './detail.js';
import { Air, Photos } from './aircraft.js';
import { Sats } from './satellites.js';
import { AisWs, World, auroraOverlay, countryIso, fetchKp, irTiles, radarTiles, scanArea } from './feeds.js';
import { Fun, Locate, PRESETS, Presets, legendHtml } from './presets.js';
import { Brief, Welcome } from './brief.js';
import { Music, Synth } from './audio.js';
import { Keys, Probe, buildSetup, runDiagnostics } from './setup.js';
import './util.js';
import './mapview.js';
import './engine.js';
import './detail.js';
import './aircraft.js';
import './satellites.js';
import './feeds.js';
import './presets.js';
import './brief.js';
import './audio.js';
import './setup.js';

/* ============================================================ INIT */
Detail.el = $('#detail'); Log.el = $('#log'); Brief.el = $('#brief'); Hover.el = $('#hovertip');
$('#legend').innerHTML = legendHtml();
buildSetup(); UI.build(); Presets.build(); applyLayoutMode(); Sound.toggle(Sound.on);
$('#btnLocate').addEventListener('click', () => Locate.go());
$('#brief').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) Brief.act(b.dataset.act); });
Feeds.paused = true; // hold the scheduler until we know whether the relay is there
$('#verTag').textContent = 'v' + OW_VERSION;
export const Splash = {
  lines: [], done: false,
  line(k, v, cls = '') { const el = $('#boot'); const cur = $('.cursor', el); if (cur) cur.classList.remove('cursor'); const d = document.createElement('div'); d.innerHTML = `<span>${esc(k)}</span><span class="${cls}">${esc(v)}</span>`; el.appendChild(d); while (el.children.length > 7) el.firstChild.remove(); },
  async run() {
    const t0 = Date.now(); const ok = await Relay.check(); Keys.relayStatus(); Feeds.paused = false;
    this.line('relay', ok ? (Relay.usingCustom() ? 'custom relay answering' : 'helper online · aircraft feeds unlocked') : (Relay.custom ? 'custom relay not answering' : Relay.local ? 'helper not answering' : 'not running · aircraft feeds locked'), ok ? 'ok' : 'warn');
    if (Relay.custom && !Relay.usingCustom()) Log.warn('The custom relay (Setup tab) is not answering' + (ok ? ' — using the local helper instead' : ''));
    if (ok) Log.info(Relay.usingCustom() ? 'Custom relay answering — blocked sources routed through it' : 'Helper detected — aircraft, OpenSky, NYC cameras, NHC, cables, FIRMS and Windy go through it');
    else Log.warn(Relay.local ? 'Served from localhost but the helper /proxy route is not answering — is this serve.py / serve.js?' : 'Opened as a plain file: aircraft, OpenSky, NYC cameras, NHC, the live cable map, FIRMS and Windy are blocked by the browser. Run the helper (Setup tab) to enable them.');
    const watch = [['sats', 'orbital data'], ['air_mil', 'military ads-b'], ['quakes', 'seismic'], ['storms', 'storm tracks'], ['nws', 'weather warnings']]; const seen = new Set();
    for (let i = 0; i < 40 && seen.size < watch.length; i++) { await sleep(150); for (const [id, name] of watch) { const f = Layers.byId[id] && Layers.byId[id].feed; if (seen.has(id) || !f) continue; if (!Layers.byId[id].on) { seen.add(id); this.line(name, 'standby', ''); continue; } if (f.status === 'ok') { seen.add(id); this.line(name, `online · ${fmt.n(f.count)}`, 'ok'); } else if (f.status === 'error') { seen.add(id); this.line(name, f.err.slice(0, 60), 'bad'); } } }
    this.line('ready', `${((Date.now() - t0) / 1000).toFixed(1)} s`, 'ok'); this.done = true;
  },
  close(withAudio) { const el = $('#splash'); el.classList.add('out'); setTimeout(() => { el.hidden = true; }, 650); if (withAudio) { Music.auto = true; Store.set('music_auto', true); Music.start(); } else { Music.auto = false; Store.set('music_auto', false); } if (!Store.get('welcomed', false)) Welcome.show(); requestDraw(); },
};
$('#enterAudio').addEventListener('click', () => Splash.close(true)); $('#enterSilent').addEventListener('click', () => Splash.close(false));
if (Music.auto) $('#enterAudio').classList.add('vibe'); else { $('#enterAudio').classList.remove('vibe'); $('#enterSilent').classList.add('primary'); }
Splash.run();
$('#btnAudio').addEventListener('click', () => Music.togglePop());
// close the soundtrack popover on an outside click; a click on something that was inside it (the popover re-renders itself, detaching the clicked button) does not count
document.addEventListener('click', e => { const pop = $('#audioPop'); if (pop.hidden) return; const inside = e.composedPath().some(n => n === pop || n === $('#btnAudio')); if (!inside) pop.hidden = true; });
for (const d of Layers.defs) if (d.on && d.enable) d.enable();
if (Locate.pos && Date.now() - Locate.pos.t < 24 * 3600e3) setTimeout(() => Brief.render(), 1500);
document.addEventListener('keydown', e => {
  const t = e.target; if (t && t.matches && t.matches('input,textarea,select')) { if (e.key === 'Escape') t.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return; const k = e.key.toLowerCase();
  if (e.key === 'Escape') { Detail.clear(); map.closePopup(); Welcome.hide(); Fun.issFollow = false; Fun.issPending = 0; } else if (e.key === '/') { e.preventDefault(); $('#q').focus(); } else if (k === 'l') { $('#rail').classList.toggle('hidden'); setTimeout(() => map.invalidateSize(), 50); } else if (k === 'p') { $('#btnPause').click(); }
  else if (k === 'm') Fun.surprise(); else if (k === 'i') Fun.followIss(); else if (k === 's') Sound.toggle(); else if (k === 'a') Music.toggle(); else if (k === 'n') { const ks = Object.keys(Synth.SETS); Music.setSet(ks[(ks.indexOf(Music.set) + 1) % ks.length]); if (!Music.playing) Music.start(); toast('Audio: ' + Music.label()); } else if (/^[1-5]$/.test(k)) { Welcome.hide(); Presets.apply(PRESETS[+k - 1].id); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { requestDraw(); Sats.prop(true); Brief.render(); } });
try { // the ADS-B and GDELT limits are per IP address, so a second open copy halves everyone's budget
  const bc = new BroadcastChannel('open-overwatch'); const me = Math.random().toString(36).slice(2); let warned = false;
  bc.onmessage = e => { if (e.data && e.data.id !== me) { if (e.data.t === 'hello') bc.postMessage({ t: 'here', id: me }); if (!warned) { warned = true; Log.warn('Another copy of this page is open in this browser. Aircraft and news sources rate-limit per IP address, so keep one copy running.'); } } };
  bc.postMessage({ t: 'hello', id: me });
} catch (e) { }
window.addEventListener('error', e => { if (/satellite|Leaflet|\bL\b/.test(e.message || '')) Log.error('Script: ' + e.message); });
Log.info('Open Overwatch v' + OW_VERSION + ' online · ' + Layers.defs.filter(d => d.on).length + ' layers active');
// console handle for tinkering: OW.Layers, OW.Dyn.air, OW.Feeds …
window.OW = { map, Layers, Feeds, Dyn, Sel, Detail, Log, Net, Relay, Store, Keys, Sats, Air, Probe, Points, World, Brief, Presets, Fun, Locate, Welcome, Hover, Sound, Music, Synth, Splash, Photos, glyphs, Tracks, scanArea, runFeed, runDiagnostics, countryIso, regionOf, showTab, openSheet, applyLayoutMode, fetchKp, AisWs, get auroraOverlay() { return auroraOverlay; }, get radarTiles() { return radarTiles; }, get irTiles() { return irTiles; } };
