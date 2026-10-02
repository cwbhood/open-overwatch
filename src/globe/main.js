// 3D globe: wiring, the frame hooks, feeds on timers, and boot.
import { C, $, toast, PHONE } from './env.js';
import { viewer, scene, globe, camera, satPts, airPts, airIcons, qkPts, camHeight } from './viewer.js';
import { L, initDock } from './layers.js';
import { hooks } from './state.js';
import { Earth, BASES, setBase, currentBase, sunlitView, marbleLayer, nightLayer, fxShell, cloudShell, limbShell, Fx, moonPosition } from './earth.js';
import { Follow, MODEL_FIX, SOLAR_AXIS } from './follow.js';
import { Sats, SatModels, SHADOW_FILL } from './satellites.js';
import { warmModels } from './warm.js';
import { Air, AirModels, airShown } from './aircraft.js';
import { Time } from './time.js';
import { Quakes } from './quakes.js';
import { updateStats, updateBand, PRESETS, Lighting, select } from './ui.js';
import { Space } from './space.js';
import { Quality, LEVELS } from './quality.js';

function applyVisibility() {
  for (const s of Sats.list) if (s.pt) s.pt.show = L[s.layer].on && !s.ent && !s.docked;
  airPts.show = airIcons.show = true;
  for (const a of Air.map.values()) { const on = airShown(a); a.pt.show = on && !a.ent; a.icon.show = on && !a.ent; if (!on && a.ent) AirModels.drop(a); }
  qkPts.show = L.quakes.on;
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
setInterval(() => SatModels.refresh(), 400);
setInterval(() => AirModels.refresh(), 500);
setInterval(() => Air.update(Date.now()), 250);
setInterval(() => Air.prune(), 30e3);

/** Run a feed now and every `ms`; failures become a toast, not an exception. */
function every(ms, fn, label) { const run = () => fn().catch(e => { console.warn(label, e); toast(`${label}: ${e.message}`); }); run(); return setInterval(run, ms); }

// boot: a mostly sunlit Earth, held behind the boot screen until the globe has something to show
{ const [lon, lat] = sunlitView(); camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, 2.0e7) }); }
updateBand(); applyVisibility();
{
  const t0 = Date.now(), wait = setInterval(() => {
    if (globe.tilesLoaded || Date.now() - t0 > 8000) { clearInterval(wait); $('#boot').classList.add('out'); setTimeout(() => $('#boot').remove(), 900); }
  }, 200);
}
// compile every model type's shaders now, not mid-flight: aircraft (0.8 MB) behind the boot screen, satellites (6.7 MB;
// phones only the two common types) once the page is idle. Model options must match the real ones (aircraft.js,
// satellites.js) where they change the shader: the satellites' shadow CustomShader does, sizes don't.
warmModels(['airliner', 'prop', 'heli', 'fighter', 'heavy', 'tprop'].flatMap(t => ['civ', 'mil'].map(k => ({ uri: `brand/models/aircraft/${t}_${k}.glb` }))));
setTimeout(() => warmModels((PHONE ? ['starlink', 'smallsat'] : ['starlink', 'smallsat', 'rocketbody', 'gnss', 'geo', 'weather', 'soyuz', 'hubble', 'iss', 'css'])
  .flatMap(t => [{ uri: `brand/models/${t}.glb`, runAnimations: false }, { uri: `brand/models/${t}.glb`, runAnimations: false, customShader: SHADOW_FILL }])), 6000);
Sats.load().catch(e => toast('Satellites failed: ' + e.message));
every(15 * 60e3, () => Air.opensky(), 'Civil aircraft');
every(60e3, () => Air.military(), 'Military aircraft');
every(10 * 60e3, () => Quakes.load(), 'Earthquakes');

window.OO3D = {
  viewer, space: Space, time: Time, Earth, marbleLayer, nightLayer, fxShell, cloudShell, limbShell, Fx, Sats, Air, Quakes, L, PRESETS, moonPosition, SatModels, AirModels, Follow, select, applyVisibility,
  /** debug: the axes test model at lon/lat/height, body X = east, Y = north, Z = up, arrays turned by `deg` */
  debugAxes(lon, lat, h, deg = 0, uri = 'brand/models/test/axes.glb') {
    const pos = C.Cartesian3.fromDegrees(lon, lat, h), R = C.Matrix4.getMatrix3(C.Transforms.eastNorthUpToFixedFrame(pos), new C.Matrix3());
    const q = C.Quaternion.multiply(C.Quaternion.fromRotationMatrix(R), MODEL_FIX, new C.Quaternion());
    return viewer.entities.add({ position: pos, orientation: q, model: { uri, minimumPixelSize: 0, nodeTransformations: { solar_1: { rotation: C.Quaternion.fromAxisAngle(SOLAR_AXIS, C.Math.toRadians(deg)) } } } });
  },
};
