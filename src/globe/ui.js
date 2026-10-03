// Globe UI: stats, the altitude band and presets, hover tips, the details card, keyboard, and model lighting.
import { C, $, esc, fmt } from './env.js';
import { viewer, scene, camera, airIcons, orbitLines, camHeight } from './viewer.js';
import { L } from './layers.js';
import { state, hooks } from './state.js';
import { Follow, release } from './follow.js';
import { Sats, SatModels } from './satellites.js';
import { Air, AirModels } from './aircraft.js';
import { Quakes } from './quakes.js';
import { Country } from './country.js';
import { sunlitView, moonPosition, showPlaceNames } from './earth.js';
import { Time } from './time.js';

// ---- stats + altitude band
export function updateStats() {
  const { air, mil } = Air.counts();
  $('#sAir').textContent = fmt(air); $('#sMil').textContent = fmt(mil);
  $('#sSat').textContent = fmt(Sats.list.filter(s => L[s.layer].on).length); $('#sQk').textContent = fmt(Quakes.list.length);
}
// ---- time bar
const NARROW = matchMedia('(max-width: 480px)');
const RATE_TEXT = { '-3600': '1 h/s backwards', 0: 'paused', 1: 'live', 60: '1 min/s', 600: '10 min/s', 3600: '1 h/s' };
function syncTime() {
  const ms = Time.nowMs(), k = Time.live ? 1 : Time.rate;
  const iso = new Date(ms).toISOString();
  $('#tNow').textContent = NARROW.matches ? iso.slice(5, 16).replace('T', ' ') : iso.slice(0, 16).replace('T', ' ') + ' UTC';   // phones: MM-DD hh:mm
  const mode = Time.live ? 'live' : Time.offLive() ? (k === 1 ? 'real speed' : RATE_TEXT[k] || k + '×') + ' · not live' : RATE_TEXT[k] || k + '×';
  $('#tMode').textContent = mode; $('#tMode').classList.toggle('off', Time.offLive());
  document.querySelectorAll('#timebar [data-rate]').forEach(b => b.classList.toggle('on', +b.dataset.rate === (Time.live ? 1 : Time.rate)));
}
document.querySelectorAll('#timebar [data-rate]').forEach(b => { b.onclick = () => Time.setRate(+b.dataset.rate); });
$('#tLive').onclick = () => Time.goLive();
Time.onChange(syncTime); setInterval(syncTime, 500); syncTime();
const BANDS = [[1.0e8, 'Cislunar'], [3.0e7, 'Deep space'], [8.0e6, 'High orbit'], [1.2e6, 'Low orbit'], [1.5e5, 'Airspace'], [8.0e3, 'Region'], [-Infinity, 'Street']];
export function updateBand() {
  const h = camHeight(), name = (BANDS.find(([min]) => h >= min) || BANDS[BANDS.length - 1])[1];
  $('#bandName').textContent = name;
  $('#bandAlt').textContent = h > 1e6 ? fmt(h / 1000) + ' km above Earth' : h > 1e4 ? fmt(h / 1000) + ' km' : fmt(h) + ' m';
  showPlaceNames(L.labels.on && h < 3.0e6);
  airIcons.show = h > 6.0e4 && !state.weather;   // from low down, flat top-down icons near the horizon look like upright cards; models cover it
}
camera.percentageChanged = 0.02; camera.changed.addEventListener(updateBand);
setInterval(updateBand, 250);   // lookAt/follow moves don't always raise camera.changed

// ---- presets
function flyDeg(lon, lat, h, pitchDeg) { release(); camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, h), orientation: { heading: 0, pitch: C.Math.toRadians(pitchDeg), roll: 0 }, duration: 3 }); }
export const PRESETS = {
  ground: () => flyDeg(-0.1278, 51.495, 3500, -45),
  air: () => flyDeg(2.5, 46, 1.4e6, -70),
  earth: () => { const [lon, lat] = sunlitView(); flyDeg(lon, lat, 2.0e7, -90); },
  geo: () => flyDeg(-40, 0, 1.6e8, -90),
  moon: () => {
    release();
    camera.flyToBoundingSphere(new C.BoundingSphere(moonPosition(), 1737400), { offset: new C.HeadingPitchRange(0, -0.15, 9.0e6), duration: 4.5,
      complete: () => { camera.lookAt(moonPosition(), new C.HeadingPitchRange(camera.heading, camera.pitch, C.Cartesian3.distance(camera.positionWC, moonPosition()))); state.lookingAtMoon = true; } });
  },
};
$('#band').addEventListener('click', e => {
  const b = e.target.closest('[data-go]'); if (!b) return;
  document.querySelectorAll('.go').forEach(x => x.classList.toggle('on', x === b)); PRESETS[b.dataset.go]();
});
hooks.clearPresets = () => $('#band').querySelectorAll('.go').forEach(x => x.classList.remove('on'));

// ---- picking: hover tip + details card
const handler = new C.ScreenSpaceEventHandler(scene.canvas);
// points carry the object as their id; model entities carry .sat / .air
// fingers are wide and dots are a few pixels: touch picks within a 28 px square, the mouse within 3 px
let touchInput = matchMedia('(pointer: coarse)').matches;
scene.canvas.addEventListener('pointerdown', e => { touchInput = e.pointerType !== 'mouse'; if (touchInput) $('#hover').style.display = 'none'; }, true);
function pickObj(pos, r = touchInput ? 28 : 3) { const p = scene.pick(pos, r, r), id = p && p.id; return id ? (id.kind ? id : id.sat || id.air || null) : null; }
function tipFor(o) {
  if (o.kind === 'sat') return `${o.name} · ${L[o.layer].name.split(' (')[0]}`;
  if (o.kind === 'air') return `${o.flight || o.hex} · ${o.ground ? 'on ground' : fmt((o.alt || 0) / 0.3048) + ' ft'}${o.mil ? ' · military' : ''}`;
  if (o.kind === 'quake') return `M${o.mag.toFixed(1)} · ${o.place}`;
  if (o.kind === 'volcano') return `${o.name}${o.elevationM ? ' · ' + fmt(o.elevationM) + ' m' : ''}`;
  if (o.kind === 'company') return `${o.name} · ${fmt(o.employees)} employees`;
  if (o.kind === 'lighthouse') return `${o.name || 'Lighthouse'}${o.heightM ? ' · ' + fmt(o.heightM) + ' m' : ''}`;
  return '';
}
let hoverRaf = 0;
handler.setInputAction(m => {
  if (hoverRaf || touchInput) return;   // no hover tips from a finger: they stayed on screen after the touch
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0; const o = pickObj(m.endPosition), t = $('#hover');
    if (!o) { t.style.display = 'none'; scene.canvas.style.cursor = ''; return; }
    t.textContent = tipFor(o); t.style.display = 'block'; t.style.left = (m.endPosition.x + 14) + 'px'; t.style.top = (m.endPosition.y + 12) + 'px'; scene.canvas.style.cursor = 'pointer';
  });
}, C.ScreenSpaceEventType.MOUSE_MOVE);
let clickNo = 0;
handler.setInputAction(c => {
  const o = pickObj(c.position), n = ++clickNo; if (o) { select(o); return; }
  // nothing under the cursor: the country under it, if the click landed on the Earth
  const p = camera.pickEllipsoid(c.position, scene.globe.ellipsoid);
  if (!p) { closeCard(); return; }
  const g = C.Cartographic.fromCartesian(p);
  Country.at(C.Math.toDegrees(g.longitude), C.Math.toDegrees(g.latitude)).then(k => { if (n !== clickNo) return; if (k) select(k); else closeCard(); }).catch(() => { if (n === clickNo) closeCard(); });
}, C.ScreenSpaceEventType.LEFT_CLICK);
// double-click a satellite or aircraft to follow it (replaces Cesium's default entity tracking)
viewer.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
handler.setInputAction(c => {
  const o = pickObj(c.position); if (!o) return;
  if (o.kind === 'sat') { select(o); SatModels.follow(o); } else if (o.kind === 'air') { select(o); AirModels.follow(o); }
}, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
export function select(o) {
  state.selected = o; orbitLines.removeAll(); let html = '';
  if (o.kind !== 'country') Country.clear(); else Country.highlight(o);
  if (o.kind === 'sat') {
    const i = Sats.info(o), l = L[o.layer];
    html = `<div class="k" style="--c:${l.color}">${esc(l.name)}</div><h2>${esc(o.name)}</h2><dl>${row('NORAD', o.id)}${row('Altitude', fmt(i.alt) + ' km')}${row('Speed', fmt(i.speed) + ' km/h')}${row('Orbit period', i.period.toFixed(1) + ' min')}${row('Inclination', i.incl.toFixed(1) + '°')}${row('Over', i.lat.toFixed(2) + ', ' + i.lon.toFixed(2))}</dl>`;
    Sats.orbit(o);
  } else if (o.kind === 'air') {
    html = `<div class="k" style="--c:${o.mil ? '#ffb44d' : '#5fd3ff'}">${o.mil ? 'Military aircraft' : 'Aircraft'} · ${esc(o.src)}</div><h2>${esc(o.flight || o.hex)}</h2><dl>${row('ICAO hex', o.hex)}${o.type ? row('Type', o.type) : ''}${o.reg ? row('Registration', o.reg) : ''}${o.country ? row('Country', o.country) : ''}${row('Altitude', o.ground ? 'on ground' : fmt((o.alt || 0) / 0.3048) + ' ft')}${row('Speed', o.gs != null ? fmt(o.gs / 0.514444) + ' kt' : '—')}${row('Track', o.track != null ? Math.round(o.track) + '°' : '—')}${row('Squawk', o.squawk || '—')}${row('Last fix', Math.round((Date.now() - o.ts) / 1000) + ' s ago')}</dl>`;
  } else if (o.kind === 'volcano') {
    const wd = /^Q\d+$/.test(o.wiki) ? `<div class="acts"><a class="chipbtn" href="https://www.wikidata.org/wiki/${o.wiki}" target="_blank" rel="noopener">Wikidata</a></div>` : '';
    html = `<div class="k" style="--c:#ff5a36">Volcano</div><h2>${esc(o.name)}</h2><dl>${row('Type', o.type)}${o.elevationM ? row('Summit', fmt(o.elevationM) + ' m') : ''}${o.country ? row('Country', o.country) : ''}${row('Position', o.lat.toFixed(3) + '°, ' + o.lon.toFixed(3) + '°')}</dl>${wd}<div class="note" style="margin-top:8px">Wikidata says what this is, not whether it is erupting. Recent eruptions: Smithsonian Global Volcanism Program.</div>`;
  } else if (o.kind === 'company') {
    const wd = /^Q\d+$/.test(o.wiki) ? `<div class="acts"><a class="chipbtn" href="https://www.wikidata.org/wiki/${o.wiki}" target="_blank" rel="noopener">Wikidata</a></div>` : '';
    html = `<div class="k" style="--c:${o.color}">${esc(o.group)}</div><h2>${esc(o.name)}</h2><dl>${row('Employees', fmt(o.employees))}${o.industry ? row('Industry', o.industry) : ''}${o.country ? row('Headquarters', o.country) : ''}${o.founded ? row('Founded', o.founded) : ''}${o.exchange ? row('Listed on', o.exchange) : ''}</dl>${wd}<div class="note" style="margin-top:8px">Wikidata is edited by volunteers: figures can be out of date or wrong. Tower height follows employees, not value.</div>`;
  } else if (o.kind === 'country') {
    html = Country.html(o);
  } else if (o.kind === 'lighthouse') {
    const wd = /^Q\d+$/.test(o.wiki) ? `<div class="acts"><a class="chipbtn" href="https://www.wikidata.org/wiki/${o.wiki}" target="_blank" rel="noopener">Wikidata</a></div>` : '';
    const light = [o.colour, o.character].filter(Boolean).join(' · ');
    html = `<div class="k" style="--c:#ffe27a">${o.status ? 'Disused lighthouse' : 'Lighthouse'}</div><h2>${esc(o.name || 'Unnamed lighthouse')}</h2><dl>${o.heightM ? row('Height', fmt(o.heightM) + ' m') : ''}${light ? row('Light', light) : ''}${o.rangeNm ? row('Range', fmt(o.rangeNm) + ' nautical miles') : ''}${o.built ? row('Built', o.built) : ''}${o.operator ? row('Run by', o.operator) : ''}${row('Position', o.lat.toFixed(4) + '°, ' + o.lon.toFixed(4) + '°')}</dl>${wd}<div class="note" style="margin-top:8px">© OpenStreetMap contributors (ODbL)</div>`;
  } else if (o.kind === 'quake') {
    const link = /^https:\/\//.test(o.url) ? `<div class="acts"><a class="chipbtn" href="${esc(o.url)}" target="_blank" rel="noopener">USGS page</a></div>` : '';
    html = `<div class="k" style="--c:#ff7b4f">Earthquake</div><h2>M${o.mag.toFixed(1)}</h2><dl>${row('Where', o.place)}${row('When', new Date(o.time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')}${row('Depth', fmt(o.depth) + ' km')}</dl>${link}`;
  }
  const following = Follow.obj === o, card = $('#card');
  const followBtn = (o.kind === 'sat' && SatModels.classify(o)) || o.kind === 'air' ? `<button class="chipbtn" id="btnFollow">${following ? 'Stop following' : 'Follow in 3D'}</button>` : '';
  card.innerHTML = `<button class="x" aria-label="Close">×</button>${html}<div class="acts">${following ? '' : '<button class="chipbtn" id="btnFocus">Fly to</button>'}${followBtn}</div>`;
  card.classList.add('show');
  card.querySelector('.x').onclick = closeCard;
  if ($('#btnFocus')) $('#btnFocus').onclick = () => flyToObject(o);
  if (o.kind === 'country') Country.after(o);
  if ($('#btnFollow')) $('#btnFollow').onclick = () => following ? Follow.stop() : o.kind === 'air' ? AirModels.follow(o) : SatModels.follow(o);
}
hooks.reselect = select;
export function closeCard() { state.selected = null; orbitLines.removeAll(); Country.clear(); $('#card').classList.remove('show'); }
function flyToObject(o) {
  release();
  if (o.kind === 'sat') { const st = SatModels.state(o), p = st.ok ? st.pos : o.pt.position, h = C.Cartesian3.magnitude(p) - 6371000; camera.flyToBoundingSphere(new C.BoundingSphere(p, 1), { offset: new C.HeadingPitchRange(0, -0.6, Math.max(2.5e6, h * 0.6)), duration: 2.5 }); }
  else if (o.kind === 'air') flyDeg(o.cur?.lon ?? o.lon, (o.cur?.lat ?? o.lat) - 0.35, 45000, -50);
  else if (o.kind === 'lighthouse') flyDeg(o.lon, o.lat - 0.025, 7000, -45);
  else if (o.kind === 'country') Country.fly(o);
  else if (o.kind === 'volcano') flyDeg(o.lon, o.lat - 0.2, 3.5e4, -40);
  else if (o.kind === 'company') flyDeg(o.lon, o.lat - 0.6, 4.0e5, -50);
  else flyDeg(o.lon, o.lat - 1.2, 3.5e5, -60);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (Follow.obj) Follow.stop(); else closeCard(); } });

/* Model lighting. Cesium lights glTF models from the real sun, which leaves aircraft over a night-time map almost black.
   Below 20 km the globe itself is unlit, so swapping the scene light there is safe: a soft light from overhead and
   slightly behind the viewer. Higher up the scene light must stay the sun (the globe's day/night shading uses it);
   satellites in Earth's shadow get an ambient term instead (satellites.js). */
export const Lighting = {
  sun: scene.light, fill: new C.DirectionalLight({ direction: new C.Cartesian3(0, 0, -1), intensity: 2.2 }),
  update() {
    if (camHeight() < 2.2e4) {
      const up = C.Cartesian3.normalize(camera.positionWC, new C.Cartesian3());
      const dir = C.Cartesian3.add(C.Cartesian3.negate(up, new C.Cartesian3()), C.Cartesian3.multiplyByScalar(camera.directionWC, 0.45, new C.Cartesian3()), new C.Cartesian3());
      C.Cartesian3.normalize(dir, this.fill.direction);
      if (scene.light !== this.fill) scene.light = this.fill;
    } else if (scene.light !== this.sun) scene.light = this.sun;
  },
};
