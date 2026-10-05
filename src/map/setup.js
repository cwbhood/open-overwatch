// The Setup tab (keys, relay, diagnostics), the open-map probe, and search.
import { $, esc, fmt, haversine, isHttp, late, Log, Net, Relay, safeHost, Store, toast } from './util.js';
import { map, sunElevation } from './mapview.js';
import { Dyn, Layers } from './engine.js';
import { Detail } from './detail.js';
import { Air, lyAirLocal } from './aircraft.js';
import { Sats } from './satellites.js';
import { AisWs, scanArea } from './feeds.js';
import { legendHtml } from './presets.js';
import { Brief, Welcome } from './brief.js';

/* ============================================================ SETUP TAB: keys, relay, sources, diagnostics, help */
export const Keys = {
  DEFS: [
    { id: 'windy', name: 'Windy Webcams API key', note: 'Unlocks webcams anywhere in the world near the map center. Free key from api.windy.com/keys (webcams product).', url: 'https://api.windy.com/keys' },
    { id: 'aisstream', name: 'aisstream.io API key', note: 'Streams global AIS ship positions over WebSocket for the area on screen. Free key from aisstream.io.', url: 'https://aisstream.io/' },
    { id: 'firms', name: 'NASA FIRMS MAP_KEY', note: 'Active fire / thermal-anomaly detections from VIIRS for the area on screen (zoom 5+). Free key from firms.modaps.eosdis.nasa.gov/api/.', url: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/' },
  ],
  relayStatus() { const el = $('#relayStatus'); if (!el) return; const ok = Relay.available; el.innerHTML = `<span class="flag ${ok ? 'good' : 'warn'}">${ok ? '● relay active' : '○ relay off'}</span> <span class="mono" style="font-size:12px">${esc(Relay.status())}</span>${Relay.local ? '' : ' · this page was opened as a file, so the helper is not in use'}`; },
  get(id) { return (Store.get('keys', {})[id] || '').trim(); },
  set(id, v) { const k = Store.get('keys', {}); k[id] = v.trim(); Store.set('keys', k); },
  build() {
    const el = $('#setupKeys'); el.innerHTML = `<div class="prose"><h3>Helper / relay</h3><p id="relayStatus"></p><p>Aircraft feeds, OpenSky, NYC cameras, NHC and the live submarine-cable map refuse direct browser requests, and so do FIRMS and Windy (the keyed layers). The bundled helper (<span class="mono">serve.py</span>, <span class="mono">serve.js</span> or the <span class="mono">.bat</span>) serves this page from <span class="mono">localhost</span> and relays only those hosts. If you host your own relay (a Cloudflare Worker, say), put its URL here; <span class="mono">{url}</span> marks where the encoded target goes, otherwise it is appended.</p></div>
    <div class="form"><div class="field"><label class="label" for="key_proxy">Custom relay URL (optional)</label><input id="key_proxy" type="text" autocomplete="off" spellcheck="false" placeholder="https://my-relay.example.workers.dev/?url={url}" value="${esc(Relay.custom)}"><small>Leave empty to use the local helper automatically.</small></div></div>
    <div class="prose"><h3>API keys</h3><p>Keys are optional. Everything else on the map works without them. They are stored only in this browser (localStorage) and sent only to the provider that issued them, through the relay for FIRMS and Windy: the local helper passes them on without logging them, but a custom relay above sees them (the FIRMS key is part of the URL), so only use a relay you run yourself.</p></div><div class="form" id="keyform"></div>`;
    const f = $('#keyform');
    this.relayStatus();
    for (const d of this.DEFS) { const w = document.createElement('div'); w.className = 'field'; w.innerHTML = `<label class="label" for="key_${d.id}">${esc(d.name)}</label><input id="key_${d.id}" type="password" autocomplete="off" spellcheck="false" placeholder="paste key" value="${esc(this.get(d.id))}"><small>${esc(d.note)} <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(safeHost(d.url))}</a></small>`; f.appendChild(w); }
    const actions = document.createElement('div'); actions.className = 'actions'; actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    actions.innerHTML = `<button class="btn primary small" id="keysSave">Save keys</button><button class="btn small" id="keysClearCache">Clear cached orbital data</button><button class="btn small" id="keysReset">Reset layout & layers</button><button class="btn small" id="keysWelcome">Welcome screen</button>`; f.appendChild(actions);
    $('#keysSave').addEventListener('click', async () => {
      const changed = this.DEFS.filter(d => this.get(d.id) !== $('#key_' + d.id).value.trim()).map(d => d.id);
      for (const d of this.DEFS) this.set(d.id, $('#key_' + d.id).value);
      const px = $('#key_proxy').value.trim();
      if (px && !isHttp(px)) { toast('The relay URL must start with https://', 'alert'); return; }
      if (/^http:/i.test(px) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(px)) Log.warn('The custom relay is plain http://, so relayed requests (and the FIRMS / Windy keys) cross the network unencrypted');
      const relayChanged = px !== Relay.custom; if (relayChanged) { Relay.custom = px; Store.set('proxy', px); await Relay.check(); this.relayStatus(); }
      // refetch only what the change affects: the keyed layers whose key changed, and after a relay change the failing feeds
      const KEY_LAYER = { windy: 'cams', aisstream: 'ships_ws', firms: 'fires' };
      for (const l of Layers.defs) if (l.on && l.feed && ((relayChanged && l.feed.status === 'error') || changed.some(k => KEY_LAYER[k] === l.id))) l.feed.nextAt = 0;
      if (changed.includes('aisstream') && Layers.on('ships_ws')) AisWs.connect(); // the open socket was subscribed with the old key
      toast(relayChanged ? `Saved in this browser · relay ${Relay.status()}` : 'Saved in this browser'); Brief.render();
    });
    const lsKeys = () => { try { const out = []; for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)); return out; } catch (e) { return []; } }; // storage can throw when site data is blocked
    const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { } };
    $('#keysClearCache').addEventListener('click', () => { for (const k of lsKeys()) if (k && k.startsWith('ow.tle.')) lsDel(k); toast('Orbital data cache cleared — next satellite load fetches fresh TLEs'); });
    // reset keeps the "Helper & keys" settings (keys, custom relay) and the orbital cache
    $('#keysReset').addEventListener('click', () => { for (const k of lsKeys()) if (k && k.startsWith('ow.') && !k.startsWith('ow.keys') && k !== 'ow.proxy' && !k.startsWith('ow.tle.')) lsDel(k); location.reload(); });
    $('#keysWelcome').addEventListener('click', () => Welcome.show());
  },
};


export const DIAG = [
  ['adsb.lol (aircraft)', 'https://api.adsb.lol/v2/squawk/7700'], ['airplanes.live (aircraft, needs their permission)', 'https://api.airplanes.live/v2/sqk/7700'], ['adsb.fi (aircraft)', 'https://opendata.adsb.fi/api/v2/sqk/7700'], ['OpenSky', 'https://opensky-network.org/api/states/all?lamin=50&lomin=5&lamax=51&lomax=6'],
  ['CelesTrak (satellites)', 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE', true], ['USGS earthquakes', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.geojson'], ['NASA EONET', 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=1&limit=1'],
  ['GDACS', 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=EQ'], ['NOAA NHC', 'https://www.nhc.noaa.gov/CurrentStorms.json'], ['NWS alerts', 'https://api.weather.gov/alerts/active?severity=Extreme'], ['NOAA SWPC', 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'], ['RainViewer', 'https://api.rainviewer.com/public/weather-maps.json'],
  ['GDELT news', 'https://api.gdeltproject.org/api/v2/doc/doc?query=earthquake&mode=artlist&format=json&maxrecords=1&timespan=1h'], ['TfL cameras', 'https://api.tfl.gov.uk/Place/JamCams_00001.07450'], ['NYC DOT cameras', 'https://webcams.nyctmc.org/api/cameras'], ['Caltrans cameras', 'https://cwwp2.dot.ca.gov/data/d12/cctv/cctvStatusD12.json'], ['Singapore cameras', 'https://api.data.gov.sg/v1/transport/traffic-images'], ['Finland cameras', 'https://tie.digitraffic.fi/api/weathercam/v1/stations/C01503'],
  ['Digitraffic AIS', () => 'https://meri.digitraffic.fi/api/ais/v1/vessels?from=' + (Date.now() - 60e3)], /* built per run: only the last minute */ ['SondeHub', 'https://api.v2.sondehub.org/sondes?lat=52&lon=5&distance=100000&last=3600'], ['Open-Meteo', 'https://api.open-meteo.com/v1/forecast?latitude=40&longitude=-74&current=temperature_2m'], ['Photon geocoder', 'https://photon.komoot.io/reverse?lat=40.7&lon=-74'], ['Overpass (OSM)', 'https://overpass-api.de/api/status', true], ['GitHub (cables)', 'https://raw.githubusercontent.com/lintaojlu/submarine_cable_information/master/README.md', true],
];
export async function runDiagnostics(btn) {
  btn.disabled = true; const out = $('#diagOut'); out.innerHTML = '<p>Testing ' + DIAG.length + ' sources…</p>'; const rows = [];
  await Relay.check(); Keys.relayStatus();
  await Promise.all(DIAG.map(async ([name, u, isText]) => { const url = typeof u === 'function' ? u() : u, t0 = Date.now(); let st, cls; try { await Net.fetch(url, { timeout: 20000, text: !!isText }); st = 'ok' + (Relay.needs(url) ? ' via relay' : ''); cls = 'good'; } catch (e) { st = e.message; cls = /blocked|relay/.test(st) ? 'warn' : 'emg'; } rows.push([name, st, Date.now() - t0, cls]); }));
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  out.innerHTML = `<table>${rows.map(r => `<tr><td>${esc(r[0])}</td><td><span class="flag ${r[3]}">${esc(r[1])}</span> <span class="mono" style="font-size:11px;color:var(--ink-faint)">${r[2]} ms</span></td></tr>`).join('')}</table><p style="margin-top:8px">${Relay.available ? 'Relay is active, so the sources that block browsers are reached through the helper.' : 'Sources marked "blocked" refuse browser requests. Start the helper (see above) and open the page through it to enable them.'}</p>`;
  btn.disabled = false; Log.info('Diagnostics: ' + rows.filter(r => r[3] === 'good').length + '/' + rows.length + ' sources reachable');
}

export function buildSetup() {
  $('#setup').innerHTML = `
<details class="setup" open><summary>Helper &amp; keys</summary><div id="setupKeys"></div></details>
<details class="setup"><summary>Test all feeds</summary><div class="prose"><p>Checks every source from this browser and shows ok / blocked / error with response times.</p><p><button class="btn small" id="btnDiag">Run test</button></p><div id="diagOut"></div></div></details>
<details class="setup"><summary>How to read the map</summary><div class="prose">
<div class="legend" style="padding:0 0 8px;border:0">${legendHtml()}</div>
<p>Aircraft glyphs point along their track and are dead-reckoned between fixes; labels show callsign and flight level (FL350 = 35,000 ft). Satellites are propagated from CelesTrak orbital elements with SGP4, so their positions are computed here, not received. Ships appear individually from zoom 5, cameras from zoom 8.</p>
<p>Click anything for details and outbound links. Click open ground for a probe: local weather, place, sun angle, nearest aircraft, and an OpenStreetMap scan of the surroundings. The <b>Brief</b> tab summarises what is notable right now and refreshes every few seconds.</p>
<h3>Keyboard</h3><p><kbd>1</kbd>–<kbd>5</kbd> views · <kbd>M</kbd> surprise me · <kbd>I</kbd> follow ISS · <kbd>A</kbd> audio on/off · <kbd>N</kbd> next generated set · <kbd>S</kbd> alert sounds · <kbd>/</kbd> search · <kbd>Esc</kbd> clear selection · <kbd>L</kbd> layer rail · <kbd>P</kbd> pause feeds</p></div></details>
<details class="setup"><summary>Sources &amp; terms</summary><div class="prose">
<p>A single-file situation map fed entirely by public, open data. It runs in your browser and talks straight to each source. Nothing is stored anywhere except your own browser (layer choices, map position, cached orbital elements and any keys you add). Version ${OW_VERSION}.</p>
<h3>The helper</h3><p>A few sources refuse requests that come from a web page (no CORS headers): the ADS-B aggregators, OpenSky, NYC DOT, NHC and the live submarine-cable map, plus FIRMS and Windy for the keyed layers. The bundled helper fixes that: run <span class="mono">Start Open Overwatch.bat</span> (Windows), or <span class="mono">python serve.py</span> / <span class="mono">node serve.js</span> in the folder. It serves this page at <span class="mono">http://127.0.0.1:8787/</span> and relays only those hosts, adding the missing header. No dependencies, nothing leaves your machine except the requests you would make anyway.</p>
<h3>Sources and terms</h3>
<table>
<tr><td>Aircraft</td><td><a href="https://www.adsb.lol/" target="_blank" rel="noopener">adsb.lol</a> (primary) and <a href="https://adsb.fi/" target="_blank" rel="noopener">adsb.fi</a> (fallback): community ADS-B/MLAT, unfiltered, ~1 request/s, non-commercial. <a href="https://airplanes.live/" target="_blank" rel="noopener">airplanes.live</a> now answers 403 unless they have granted you API access, so it is only used if you pick it. Optional <a href="https://opensky-network.org/" target="_blank" rel="noopener">OpenSky Network</a> anonymous snapshot (400 credits/day, CC BY-NC). All via the helper.</td></tr>
<tr><td>Satellites</td><td><a href="https://celestrak.org/" target="_blank" rel="noopener">CelesTrak</a> GP element sets, propagated in-browser with SGP4 (satellite.js). CelesTrak refreshes every 2 h and asks for at most one download per group per update, so TLEs are cached for 2 h here.</td></tr>
<tr><td>Cameras</td><td><a href="https://api.tfl.gov.uk/" target="_blank" rel="noopener">TfL JamCams</a> (London), <a href="https://webcams.nyctmc.org/" target="_blank" rel="noopener">NYC DOT</a> (via the helper), <a href="https://cwwp2.dot.ca.gov/" target="_blank" rel="noopener">Caltrans CCTV</a> (all 12 districts, loaded as you look at them), <a href="https://data.gov.sg/" target="_blank" rel="noopener">LTA Singapore</a>, <a href="https://www.digitraffic.fi/en/road-traffic/" target="_blank" rel="noopener">Fintraffic weather cameras</a>; <a href="https://api.windy.com/" target="_blank" rel="noopener">Windy Webcams</a> with a key.</td></tr>
<tr><td>Ships</td><td><a href="https://www.digitraffic.fi/en/marine-traffic/" target="_blank" rel="noopener">Fintraffic Digitraffic</a> open AIS (Baltic, CC BY 4.0); <a href="https://aisstream.io/" target="_blank" rel="noopener">aisstream.io</a> worldwide with a key.</td></tr>
<tr><td>Balloons</td><td><a href="https://sondehub.org/" target="_blank" rel="noopener">SondeHub</a> radiosonde telemetry (amateur receivers). <b>Community-uploaded and unverified</b>: anyone can submit a balloon, so the layer is off by default and asks first.</td></tr>
<tr><td>Earthquakes</td><td><a href="https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php" target="_blank" rel="noopener">USGS</a> real-time GeoJSON feeds.</td></tr>
<tr><td>Natural events</td><td><a href="https://eonet.gsfc.nasa.gov/" target="_blank" rel="noopener">NASA EONET</a> (events and storm tracks); <a href="https://www.gdacs.org/" target="_blank" rel="noopener">GDACS</a> disaster alerts; <a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">NOAA NHC</a> advisories via the helper; <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noopener">NASA FIRMS</a> fires with a key.</td></tr>
<tr><td>Weather</td><td><a href="https://www.rainviewer.com/api.html" target="_blank" rel="noopener">RainViewer</a> radar and IR composites; <a href="https://www.weather.gov/documentation/services-web-api" target="_blank" rel="noopener">NWS API</a> alerts; <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> point conditions (CC BY 4.0).</td></tr>
<tr><td>Space weather</td><td><a href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener">NOAA SWPC</a> planetary K-index and OVATION aurora forecast.</td></tr>
<tr><td>News</td><td><a href="https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/" target="_blank" rel="noopener">GDELT DOC 2.0</a>: worldwide coverage matching your query in the last 24 h, plotted by the country of the outlet (GDELT's geo API was retired). One request per 15 min; GDELT allows one per 5 s per IP.</td></tr>
<tr><td>Infrastructure</td><td><a href="https://www.submarinecablemap.com/" target="_blank" rel="noopener">TeleGeography</a> submarine cable data (CC BY-NC-SA 3.0, via a maintained GitHub mirror); <a href="https://overpass-api.de/" target="_blank" rel="noopener">Overpass API</a> for OpenStreetMap scans (ODbL); <a href="https://photon.komoot.io/" target="_blank" rel="noopener">Photon</a> / Nominatim reverse geocoding.</td></tr>
<tr><td>Audio</td><td>The generated soundtrack is synthesized in the browser with Web Audio (original, no samples). Radio mode lists stations from the community directory <a href="https://www.radio-browser.info/" target="_blank" rel="noopener">radio-browser.info</a> by tag and plays their public streams; the streams belong to their broadcasters, and some only allow playback on their own sites. Airframe photos come from <a href="https://www.planespotters.net/" target="_blank" rel="noopener">Planespotters.net</a> with photographer credit.</td></tr>
<tr><td>Base maps</td><td>Esri dark gray canvas, Esri World Imagery and topographic, OpenStreetMap (plain and inverted to dark), OpenTopoMap, <a href="https://worldview.earthdata.nasa.gov/" target="_blank" rel="noopener">NASA GIBS</a> daily VIIRS true color and night lights. None need a key.</td></tr>
</table>
<h3>Fair use</h3><p>These are volunteer and public-agency services. The page rate-limits itself (one ADS-B call per 2.5 s per source with automatic slow-down on 429s, cached orbital data, feeds that back off on errors), slows to a third of the cadence while the tab is hidden, and the Pause button stops everything. If a feed shows ✕, the source is down, rate-limited, or blocks browser requests; the rest keeps running. Check each provider's terms before using this commercially.</p></div></details>`;
  Keys.build(); $('#btnDiag').addEventListener('click', e => runDiagnostics(e.target));
}

/* ============================================================ PROBE: click on open map */
export const Probe = {
  open(latlng) {
    const lat = +latlng.lat.toFixed(5), lon = +((((latlng.lng + 540) % 360) - 180).toFixed(5));
    const el = document.createElement('div'); el.className = 'probe';
    const sunEl = sunElevation(lat, lon, Date.now());
    let nearest = null, nd = Infinity; for (const a of Dyn.air.values()) { const d = haversine(lat, lon, a.lat, a.lon); if (d < nd) { nd = d; nearest = a; } }
    el.innerHTML = `<h4>Probe</h4><dl class="kv"><dt>Position</dt><dd>${fmt.ll(lat, lon)}</dd><dt>Sun</dt><dd>${sunEl.toFixed(1)}° · ${sunEl > 0 ? 'daylight' : sunEl > -6 ? 'civil twilight' : sunEl > -18 ? 'twilight' : 'night'}</dd><dt>Place</dt><dd id="pbPlace">…</dd><dt>Weather</dt><dd id="pbWx">…</dd>${nearest ? `<dt>Nearest a/c</dt><dd><a href="#" id="pbNear">${esc(nearest.flight || nearest.r || nearest.hex)}</a> · ${fmt.dist(nd)}</dd>` : ''}</dl>
    <div class="row"><button class="btn small" id="pbScan">Scan area (OSM)</button><button class="btn small" id="pbLocal">Aircraft bubble here</button><button class="btn small" id="pbCopy">Copy</button></div>`;
    const pop = L.popup({ maxWidth: 340, autoPan: true }).setLatLng(latlng).setContent(el).openOn(map);
    $('#pbScan', el).addEventListener('click', async () => { $('#pbScan', el).disabled = true; try { await scanArea(lat, lon); } catch (e) { Log.error('OSM scan: ' + e.message); toast('Scan failed: ' + e.message, 'alert'); } $('#pbScan', el).disabled = false; });
    $('#pbLocal', el).addEventListener('click', () => { map.setView([lat, lon], Math.max(map.getZoom(), 6)); if (!lyAirLocal.on) Layers.set('air_local', true); lyAirLocal.feed.nextAt = 0; toast('Aircraft bubble recentred here'); });
    $('#pbCopy', el).addEventListener('click', () => { const t = `${lat}, ${lon}`; (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => toast('Copied ' + t)).catch(() => toast(t)); });
    if (nearest) $('#pbNear', el).addEventListener('click', ev => { ev.preventDefault(); Detail.show('air', nearest, nearest.hex); });
    Net.json(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,cloud_cover,visibility,weather_code&wind_speed_unit=kn`).then(d => {
      const c = d.current || {}; const wx = $('#pbWx', el); if (!wx) return; wx.innerHTML = `${fmt.n(c.temperature_2m, 1)} °C · wind ${fmt.n(c.wind_direction_10m)}° ${fmt.n(c.wind_speed_10m)} kt${c.wind_gusts_10m ? ' G' + fmt.n(c.wind_gusts_10m) : ''} · cloud ${fmt.n(c.cloud_cover)} % · vis ${fmt.dist(c.visibility || 0)}${c.precipitation ? ' · precip ' + c.precipitation + ' mm' : ''}`;
    }).catch(e => { const wx = $('#pbWx', el); if (wx) wx.textContent = 'unavailable (' + e.message + ')'; });
    Net.json(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`, { throttle: 'photon', gap: 800 }).then(d => { const p = d.features?.[0]?.properties || {}; const s = [p.name, p.city || p.town || p.village, p.state, p.country].filter(Boolean).join(', ') || 'no named place nearby'; const pl = $('#pbPlace', el); if (pl) pl.textContent = s; })
      .catch(() => Net.json(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10`, { throttle: 'nominatim', gap: 1200 }).then(d => { const pl = $('#pbPlace', el); if (pl) pl.textContent = d.display_name || 'no named place nearby'; }).catch(e => { const pl = $('#pbPlace', el); if (pl) pl.textContent = 'unavailable'; }));
  },
};


/* ============================================================ SEARCH */
$('#search').addEventListener('submit', async ev => {
  ev.preventDefault(); const q = $('#q').value.trim(); if (!q) return; const ql = q.toLowerCase();
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/); if (m) { map.flyTo([+m[1], +m[2]], Math.max(map.getZoom(), 8)); return; }
  for (const a of Dyn.air.values()) if ([a.hex, a.flight, a.r].some(v => v && String(v).toLowerCase() === ql)) { flyTo(a.lat, a.lon, 8); Detail.show('air', a, a.hex); return; }
  const showSat = sat => { if (sat.lat != null) flyTo(sat.lat, sat.lon, 3); Detail.show('sat', sat, sat.id); };
  // exact matches in every loaded category first, then a satellite name fragment, then the online lookups
  const satExact = Dyn.sats.find(s => s.name.toLowerCase() === ql || String(s.id) === q); if (satExact) return showSat(satExact);
  for (const s of Dyn.ships.values()) if ((s.name || '').toLowerCase() === ql || String(s.id) === q) { flyTo(s.lat, s.lon, 10); Detail.show('ship', s, s.id); return; }
  const satPart = Dyn.sats.find(s => s.name.toLowerCase().includes(ql)); if (satPart) return showSat(satPart);
  toast('Searching feeds for ' + q + '…');
  // six hex digits may be an ICAO address or a callsign such as CCA981, so try both; one failed lookup doesn't stop the next
  const lookups = [...(/^[0-9a-f]{6}$/i.test(q) ? [['hex', q.toLowerCase()]] : []), ['callsign', encodeURIComponent(q.toUpperCase())], ['reg', encodeURIComponent(q.toUpperCase())]];
  let airErr = '';
  for (const [kind, v] of lookups) {
    try { const d = await Air.get(kind, v); if (Air.ingest(d, 'search')) { const hex = Air.lastHexes[0]; const a = Dyn.air.get(hex); if (a) { flyTo(a.lat, a.lon, 8); Detail.show('air', a, hex); return; } } }
    catch (e) { airErr = airErr || e.message || String(e); }
  }
  try { const s = await Sats.searchByName(q); if (s) { const o = Sats.byId.get(s.id); toast(`Loaded ${s.name} from CelesTrak`); if (o) { Detail.show('sat', o, o.id); setTimeout(() => { if (o.lat != null) flyTo(o.lat, o.lon, 3); }, 1500); } return; } } catch (e) { }
  if (/blocked by browser|no helper/.test(airErr)) toast('Aircraft lookups need the helper running (see the Setup tab)', 'alert');
  else toast(`No aircraft, satellite or ship matched "${q}"` + (airErr ? ` · aircraft lookup failed: ${airErr}` : ''), 'alert');
});

Object.assign(late, { Keys, Probe });
