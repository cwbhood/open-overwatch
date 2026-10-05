// 3D globe: wiring, the frame hooks, feeds on timers, and boot.
import { C, $, toast, PHONE } from './env.js';
import { viewer, scene, globe, camera, satPts, airPts, airIcons, qkPts, camHeight } from './viewer.js';
import { L, initDock } from './layers.js';
import { hooks, state } from './state.js';
import { Earth, BASES, setBase, currentBase, sunlitView, marbleLayer, nightLayer, fxShell, cloudShell, limbShell, Fx, moonPosition } from './earth.js';
import { Follow, MODEL_FIX, SOLAR_AXIS } from './follow.js';
import { Sats, SatModels, SHADOW_FILL } from './satellites.js';
import { warmModels, warmAgain, warmSlowly } from './warm.js';
import { Air, AirModels, airShown } from './aircraft.js';
import { Time } from './time.js';
import { Quakes } from './quakes.js';
import { Lighthouses } from './lighthouses.js';
import { updateStats, updateBand, PRESETS, Lighting, select } from './ui.js';
import { Space } from './space.js';
import { Quality, LEVELS } from './quality.js';
import { Conj } from './conjunctions.js';
import { LookUp } from './lookup.js';
import { Eclipses } from './eclipses.js';
import { initMobile } from './mobile.js';
import { initNavpad } from './navpad.js';
import { Weather, initWeather } from './weather.js';
import { Aurora } from './aurora.js';
import { Flybys } from './flybys.js';
import { Companies } from './companies.js';
import { Volcanoes } from './volcanoes.js';
import { SunLine } from './sunline.js';
import { Buildings } from './buildings.js';
import { Share } from './share.js';
import { Tour } from './tour.js';
import { Wind } from './wind.js';
import { Country } from './country.js';
import { toggle as toggleNerd } from './nerd.js';
import { Tonight } from './tonight.js';
import { Flight } from './flight.js';
import { Snapshot } from './snapshot.js';
import { Search } from './search.js';
import { Launches } from './launches.js';

function applyVisibility() {
  for (const s of Sats.list) if (s.pt) s.pt.show = L[s.layer].on && !s.ent && !s.docked;
  airPts.show = airIcons.show = !state.weather; satPts.show = !state.weather;
  for (const a of Air.map.values()) { const on = airShown(a); a.pt.show = on && !a.ent; a.icon.show = on && !a.ent; if (!on && a.ent) AirModels.drop(a); }
  qkPts.show = L.quakes.on; Lighthouses.apply(); Aurora.apply(); Companies.apply(); Volcanoes.apply(); SunLine.apply(); Buildings.apply(); Launches.apply();
  Earth.apply(); updateBand(); updateStats();
}
hooks.applyVisibility = applyVisibility;
hooks.updateStats = updateStats;
initDock({ bases: BASES, currentBase, onBase: setBase, quality: { levels: LEVELS, chosen: () => Quality.chosen, current: () => Quality.level, choose: id => Quality.choose(id) } });
Quality.follow(q => { AirModels.max = q.air; SatModels.max = q.sat; cloudShell.material.uniforms.octaves = q.octaves; });

// before each frame: follow camera, model lighting; before rendering: sun direction, satellite dots, Earth fades
scene.preUpdate.addEventListener((sc, time) => { Follow.track(time); Lighting.update(); });
scene.preRender.addEventListener((sc, time) => { SatModels.updateSun(time); Sats.update(Time.nowMs()); Earth.update(camHeight()); Space.update(); });
PRESETS.space = () => Space.go();
PRESETS.conj = () => Conj.openList();
PRESETS.lookup = () => { hooks.clearPresets(); LookUp.enter(); };
PRESETS.eclipses = () => Eclipses.openList();
PRESETS.weather = () => Weather.toggle();
PRESETS.tour = () => { hooks.clearPresets(); Tour.start(); };
PRESETS.flybys = () => { hooks.clearPresets(); Flybys.openList(); };
PRESETS.tonight = () => Tonight.open();
PRESETS.search = () => Search.open();
PRESETS.launches = () => { hooks.clearPresets(); Launches.openList(); };
hooks.showLaunch = o => Launches.show(o);
PRESETS.flight = () => Flight.open();
hooks.shareCopy = () => Share.copy();
hooks.snapshot = () => Snapshot.share();
hooks.toggleNerd = toggleNerd;
initMobile();   // phones only: the bottom dock
initNavpad();
initWeather();   // everything else: zoom, north and reset buttons
$('#luExit').onclick = () => LookUp.leave();
addEventListener('keydown', e => { if (e.key === 'Escape' && LookUp.active) LookUp.leave(); });
setInterval(() => SatModels.refresh(), 400);
setInterval(() => AirModels.refresh(), 500);
// aircraft dead reckoning: 4 times a second close in, once a second from high up (a quarter-second of flight is invisible
// from 1,000 km, and each pass moves ~8,000 dots: the globe's biggest main-thread cost on a phone)
{ let lastAir = 0; setInterval(() => { const now = Date.now(); if (state.weather) return; if (now - lastAir < (camHeight() > 1.0e6 ? 1000 : 250)) return; lastAir = now; Air.update(now); }, 250); }
setInterval(() => Air.prune(), 30e3);

/** Run a feed now and every `ms`. A failure is logged and retried on the next run; only one that keeps failing
 *  (three in a row) is mentioned, and not as a scary "Failed to fetch" on a first visit. */
function every(ms, fn, label) {
  let fails = 0;
  const run = () => fn().then(() => { fails = 0; }, e => { console.warn(label, e); if (++fails === 3) toast(`${label} is unavailable right now; retrying`, 3500); });
  run(); return setInterval(run, ms);
}

// boot: a mostly sunlit Earth, held behind the boot screen until the globe has something to show. Behind that screen the
// camera first dips to 600 km for a moment: below ~800 km Cesium switches on fog and atmosphere in the globe's and the
// models' shaders, so those versions compile now instead of freezing the first zoom down (2.3 s of compiles measured).
// Every model type is drawn once at both heights (warm.js); model options must match aircraft.js / satellites.js where
// they change the shader (the satellites' shadow CustomShader does, sizes don't).
const AIR_WARM = ['airliner', 'prop', 'heli', 'fighter', 'heavy', 'tprop'].flatMap(t => ['civ', 'mil'].map(k => ({ uri: `brand/models/aircraft/${t}_${k}.glb` })));
const SAT_WARM = (PHONE ? ['starlink', 'smallsat'] : ['starlink', 'smallsat', 'rocketbody', 'gnss', 'geo', 'weather', 'soyuz', 'hubble', 'iss', 'css'])
  .flatMap(t => [{ uri: `brand/models/${t}.glb`, runAnimations: false }, { uri: `brand/models/${t}.glb`, runAnimations: false, customShader: SHADOW_FILL }]);
updateBand(); applyVisibility();
(async () => {
  const [lon, lat] = sunlitView(), t0 = Date.now();
  const until = (ms, cond = () => false) => new Promise(res => { const id = setInterval(() => { if (cond() || Date.now() - t0 > ms) { clearInterval(id); res(); } }, 100); });
  const say = t => { const el = $('#boot div'); if (el) el.textContent = t; };
  let high;
  if (PHONE) {   // phones: a fast first view matters more; the models warm up in the background, from orbit only
    camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, 2.0e7) }); say('Loading the Earth…');
    // the cloud and glint shells compile on their first draw (half a second on a phone): let that happen behind the
    // boot screen; the models then warm one by one once the globe is showing
    await until(9000, () => Fx.ok && globe.tilesLoaded && !!scene.skyBox);   // + the star cube map (its upload was a 0.5 s hitch)
    high = new Promise(res => setTimeout(() => res(warmSlowly([...AIR_WARM, ...SAT_WARM])), 6000));
  } else {
    say('Preparing the 3D models…');
    camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, 6.0e5) });
    await Promise.race([Promise.all([warmModels([...AIR_WARM, ...SAT_WARM]), until(4000, () => globe.tilesLoaded)]), until(5000)]);
    camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, 2.0e7) });
    say('Loading the Earth…');
    high = warmAgain();
  }
  await until(10000, () => globe.tilesLoaded);
  $('#boot').classList.add('out'); setTimeout(() => $('#boot').remove(), 900);
  updateBand(); Share.restore().catch(e => console.warn('share link', e)); Tonight.peek().catch(e => console.warn('tonight', e)); return high;
})();
Sats.load().catch(e => toast('Satellites failed: ' + e.message));
// load the Solar System view in the background once the globe has settled, so zooming out never waits on it (its
// start-up was 6 s of main-thread work on a phone, landing in the middle of the pinch); phones a little later
{ // ...and on phones only while nobody is touching it (the work would otherwise land in the middle of a gesture)
  let lastInput = performance.now();
  for (const ev of ['pointerdown', 'pointermove', 'wheel']) addEventListener(ev, () => { lastInput = performance.now(); window.OO_inputAt = Date.now(); }, { passive: true, capture: true });   // OO_inputAt: read by the preloaded Solar System view
  const t0 = performance.now(), wait = setInterval(() => {
    const now = performance.now();
    if (now - t0 < (PHONE ? 15e3 : 10e3) || (PHONE && now - lastInput < 3000)) return;
    clearInterval(wait); (window.requestIdleCallback || setTimeout)(() => Space.preload());
    setTimeout(function warm() { if (PHONE && performance.now() - lastInput < 3000) return setTimeout(warm, 2000); Weather.prewarm(); }, 6000);   // weather's first open would otherwise freeze the globe ~0.6 s
  }, 1000);
}
every(15 * 60e3, () => Air.opensky(), 'Civil aircraft');
every(60e3, () => Air.military(), 'Military aircraft');
every(10 * 60e3, () => Quakes.load(), 'Earthquakes');
setInterval(() => Aurora.apply(), 60e3);   // refreshes itself every 10 minutes while the layer is on

window.OO3D = { Conj, LookUp, Eclipses, Tonight, Flight, Snapshot, Search, Launches,
  viewer, space: Space, time: Time, Earth, marbleLayer, nightLayer, fxShell, cloudShell, limbShell, Fx, Sats, Air, Quakes, Lighthouses, Weather, Wind, Country, Aurora, Flybys, Companies, Volcanoes, SunLine, Buildings, Share, Tour, setIonToken: t => Buildings.setToken(t), L, PRESETS, moonPosition, SatModels, AirModels, Follow, select, applyVisibility,
  /** debug: the axes test model at lon/lat/height, body X = east, Y = north, Z = up, arrays turned by `deg` */
  debugAxes(lon, lat, h, deg = 0, uri = 'brand/models/test/axes.glb') {
    const pos = C.Cartesian3.fromDegrees(lon, lat, h), R = C.Matrix4.getMatrix3(C.Transforms.eastNorthUpToFixedFrame(pos), new C.Matrix3());
    const q = C.Quaternion.multiply(C.Quaternion.fromRotationMatrix(R), MODEL_FIX, new C.Quaternion());
    return viewer.entities.add({ position: pos, orientation: q, model: { uri, minimumPixelSize: 0, nodeTransformations: { solar_1: { rotation: C.Quaternion.fromAxisAngle(SOLAR_AXIS, C.Math.toRadians(deg)) } } } });
  },
};
