// Solar System view: one three.js scene in AU, from the Moon to the Local Group, on a logarithmic depth buffer.
// The camera rides along with whatever it is focused on; every module adds bodies to the registry (world.js) and
// gets an update(jd) per simulation step and a frame(view) per rendered frame.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LY_AU } from '../core/units.js';
import { SimClock, jdFromMs } from '../core/time.js';
import { smoothLog, Sharpen, PHONE } from './util.js';
import { bodies, byKey, defineLayer, applyLayers } from './world.js';
import { createSky } from './sky.js';
import { createPlanets } from './planets.js';
import { createMoons } from './moons.js';
import { createSmallBodies, CLASS_LAYERS } from './smallbodies.js';
import { createSpacecraft } from './spacecraft.js';
import { createDeepSpace } from './deepspace.js';
import { createCosmicWeb } from './cosmic.js';
import { createLightDelay } from './lightdelay.js';
import { createExoplanets } from './exoplanets.js';
import { createNerd } from './nerd.js';
import { createStory } from './story.js';
import { createUI } from './ui.js';
import { createEmbed, EMBED } from './embed.js';
import { createQuality } from './quality.js';
import { SOFTWARE_HINT } from '../core/gpu.js';

const showError = m => { const el = document.querySelector('#err'); el.style.display = 'block'; el.textContent = 'Something went wrong: ' + m; };
addEventListener('error', e => showError(e.message));
addEventListener('unhandledrejection', e => showError(e.reason?.message || String(e.reason)));

// ---- renderer, camera, controls
const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#c'), antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight); renderer.outputColorSpace = THREE.SRGBColorSpace;
// error checks read every shader's info log as it's created, which forces the compile to finish right then (a stall,
// worst in Firefox, where each such call is a round trip to the GPU process); ?debug turns them back on
renderer.debug.checkShaderErrors = new URLSearchParams(location.search).has('debug');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1e-9, 1e15);  // 150 m .. 16 billion light-years
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, zoomSpeed: 2.2, rotateSpeed: 0.6, enablePan: false, minDistance: 1e-6, maxDistance: 2.5e14 });   // out to ~4 billion light-years
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// planet formulae: 1800-2200 (good to 2050, plausible beyond)
const clock = new SimClock({ min: jdFromMs(Date.UTC(1800, 0, 1)), max: jdFromMs(Date.UTC(2200, 0, 1)) });
Sharpen.camera = camera;
const sunView = new THREE.Vector3();   // the Sun in view space: every lit shader reads this one uniform

// ---- layers (order = the panel's order)
[{ id: 'orbits', name: 'Planet orbits', c: '#7dffa6', on: true }, { id: 'labels', name: 'Labels', c: '#e6edf3', on: true },
  { id: 'moons', name: 'Moons', c: '#cfd3da', on: true, n: 0 }, { id: 'dwarfs', name: 'Dwarf planets', c: '#e8cfb0', on: true }, { id: 'asteroids', name: 'Asteroids', c: '#c8b89e', on: true, n: 0 },
  ...CLASS_LAYERS, { id: 'comets', name: 'Comets', c: '#bfe3ff', on: true }, { id: 'craft', name: 'Spacecraft', c: '#ffb44d', on: true, n: 0 },
  { id: 'stars', name: 'Stars near the Sun (HYG)', c: '#fff3d6', on: true, n: 0 }, { id: 'radio', name: 'Our radio bubble', c: '#7dffa6', on: true },
  { id: 'exo', name: 'Planets of other stars (NASA)', c: '#6fe0ff', on: true },
  { id: 'lightdelay', name: 'Light delay (as seen from Earth)', c: '#7dffa6', on: true }, { id: 'galaxy', name: 'Milky Way & galaxies', c: '#b6c6ff', on: true },
].forEach(defineLayer);

// ---- the world
const sky = createSky(scene);
const planets = createPlanets({ scene, sunView, renderer });
const moons = createMoons({ scene, sunView, renderer });
const small = createSmallBodies({ scene, renderer });
const craft = createSpacecraft({ scene });
const deep = createDeepSpace({ scene, camera, renderer });
const web = createCosmicWeb({ scene, renderer });
const exo = createExoplanets({ scene, camera, renderer });

// ---- navigation: focus a body and fly there (log-interpolated distance), then keep riding along with it
const nav = {
  focus: byKey.earth, fly: null,
  focusOn(b, dist = null, dur = 2.2, card = true) {
    if (!b) return;
    const sys = b.exo && exo.X.systems.find(s => s.host === b.host);
    const d1 = dist ?? (b.exo ? (sys ? exo.viewDistance(sys) : 0.25) : Math.max(b.radius * 4, b.kind === 'planet' ? b.radius * 3.2 : b.parent ? b.radius * 5 : 0.002));
    if (b.exo) exo.load().catch(() => {});
    this.fly = { from: controls.target.clone(), d0: camera.position.distanceTo(controls.target), d1, t0: performance.now(), dur: dur * 1000 };
    this.focus = b; controls.minDistance = Math.max(b.radius * 1.15, 1e-7);
    ui.showCard(card ? b : null);
  },
  flyDist(d, dur = 2) { this.fly = { from: controls.target.clone(), d0: camera.position.distanceTo(controls.target), d1: d, t0: performance.now(), dur: dur * 1000 }; },
  frame() {
    const p = this.focus.pos;
    if (this.fly) {
      const s = Math.min(1, (performance.now() - this.fly.t0) / this.fly.dur), e = s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
      const dir = camera.position.clone().sub(controls.target).normalize(), target = this.fly.from.clone().lerp(p, e);
      controls.target.copy(target); camera.position.copy(target).addScaledVector(dir, Math.exp(Math.log(this.fly.d0) + (Math.log(this.fly.d1) - Math.log(this.fly.d0)) * e));
      if (s >= 1) this.fly = null;
    } else { camera.position.add(p.clone().sub(controls.target)); controls.target.copy(p); }
  },
};
const lightDelay = createLightDelay({ scene, nav });
const story = createStory({ scene, clock, nav, caption: (...a) => ui.caption(...a), onTourChange: on => ui.tourLabel(on) });
const quality = createQuality({ renderer, small, onAutoChange: q => { ui.renderLayers(); ui.caption(`Graphics set to ${q.name}`, 'Lowered automatically for smoother motion. You can change it in the layer panel.', '', 5000); } });
const ui = createUI({ camera, controls, clock, nav, story, small, deep, quality, exo });
exo.onChange = () => { applyLayers(); ui.renderLayers(); };
const nerd = createNerd({ renderer, quality, small, exo, moons });
document.querySelector('#bNerd').onclick = () => nerd.toggle();
small.onChange = () => ui.renderLayers();
if (quality.software) setTimeout(() => ui.caption('Slow graphics', SOFTWARE_HINT, '', 15000), 10e3);

// ---- the loop
let lastT = performance.now();
const view = { camera, camSun: 1, camFocus: 1, fade: (a, b, x, unit) => unit === 'ly' ? smoothLog(a * LY_AU, b * LY_AU, x) : smoothLog(a, b, x) };
function update(jd) {
  planets.update(jd); small.update(jd);
  for (const b of bodies) if (b.update && b.key !== 'moon') b.update(jd);
  byKey.moon.update(jd);                                      // after Earth
  moons.update(jd);                                           // after their planets (Pluto included)
}
// the render loop can pause: inside the globe page this view sleeps while the globe is showing
const loop = {
  running: false,
  resume() { if (this.running) return; this.running = true; lastT = performance.now(); requestAnimationFrame(frame); },
  pause() { this.running = false; },
};
const embed = createEmbed({ camera, controls, nav, clock, loop, update });
if (EMBED) { small.defer(true); const enter = embed.api.enterFromGlobe; embed.api.enterFromGlobe = s => { small.defer(false); return enter(s); }; }
function frame(t) {
  if (!loop.running) return;
  const dt = Math.min((t - lastT) / 1000, 0.1); lastT = t; quality.tick(t); nerd.tick(t);
  update(clock.tick(Math.max(dt, 0)));
  if (!embed.frame(view)) nav.frame();
  controls.update(); camera.updateMatrixWorld();
  view.camSun = camera.position.length(); view.camFocus = camera.position.distanceTo(controls.target); view.jd = clock.jd;
  sunView.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
  Sharpen.tick();
  sky.frame(view); planets.frame(view); moons.frame(view); small.frame(view); craft.frame(view); deep.frame(view); web.frame(view); exo.frame(view); lightDelay.frame(view);
  story.updatePulse(); ui.frame(view);
  renderer.render(scene, camera);
  embed.api.ready = true;
  requestAnimationFrame(frame);
}

// ---- start: near Earth (or ?focus=<key>), then fly in
update(clock.jd);
const startKey = new URLSearchParams(location.search).get('focus') || 'earth', first = byKey[startKey] || byKey.earth;
camera.position.copy(first.pos).add(new THREE.Vector3(0.6, -1, 0.35).normalize().multiplyScalar(first.key === 'earth' ? 0.004 : 3));
controls.target.copy(first.pos); nav.focus = first;
if (EMBED) {   // inside the globe: no splash, no opening flight; render one frame (to be ready) and wait for the hand-over
  document.querySelector('#load').classList.add('gone'); document.body.classList.add('embedded'); ui.start();
  loop.resume(); requestAnimationFrame(() => requestAnimationFrame(() => { if (!embed.api.active) loop.pause(); }));
  for (const a of document.querySelectorAll('a[href="globe.html"]')) a.addEventListener('click', e => { e.preventDefault(); embed.api.goToEarth(); });
} else {
  loop.resume();
  setTimeout(() => {
    document.querySelector('#load').classList.add('gone'); ui.start();
    nav.focusOn(first, first.key === 'earth' ? 0.0012 : 3, 3, !PHONE);   // phones: no card over the view at start
    ui.caption('The Solar System, right now', 'Every planet, moon, asteroid and spacecraft is where it really is at this moment. Scroll out, or pick a step below.', 'Tip: try the guided tour in the left panel.', 9000);
  }, 700);
}
const settle = p => p.catch(e => console.warn(e)).finally(() => { applyLayers(); ui.renderLayers(); });
const loads = [moons.load(), small.load(), craft.load()];   // stars, galaxies and most textures load as you approach them
deep.onStars = () => { applyLayers(); ui.renderLayers(); };
if (!PHONE) setTimeout(() => { deep.needStars(); web.load().catch(e => console.warn(e)).finally(() => applyLayers()); }, 6000);   // desktops: in the background
document.querySelector('#q').addEventListener('focus', () => deep.needStars(), { once: true });   // searching for a star
loads.forEach(settle);

/* GPU warm-up while idle. three.js uploads a texture and compiles a shader the first time something is drawn, so the
   hand-over from the globe froze for ~0.6 s on the planet maps, and every new object type hitched once. Here textures
   go up one per idle slice as they arrive (the view may be paused inside the globe), and once the data is in, the
   scene's shaders are compiled with compileAsync (parallel compile where the browser has it). */
{
  const done = new WeakSet(), idle = fn => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));
  const pending = () => {
    const out = [];
    scene.traverse(o => { const m = o.material; if (!m) return;
      for (const t of [m.map, ...Object.values(m.uniforms || {}).map(u => u.value)]) if (t && t.isTexture && t.image && !done.has(t)) out.push(t); });
    return out;
  };
  const step = () => { const t = pending()[0]; if (t) { renderer.initTexture(t); done.add(t); idle(step); } else setTimeout(() => idle(step), 1500); };
  idle(step);
  const warm = () => new Promise(res => idle(() => renderer.compileAsync(scene, camera).catch(e => console.warn('shader warm-up', e)).finally(res)));
  embed.api.warm = false;   // the globe waits for this before handing over
  warm().then(() => { embed.api.warm = true; }); Promise.allSettled(loads).then(warm);   // what exists now, then the rest once the data is in
  setTimeout(() => { embed.api.warm = true; }, 8000);   // never hold the hand-over longer than this
}
applyLayers();

window.OOSS = { THREE, scene, camera, controls, clock, bodies, byKey, small, moons, quality, web, exo, nav, story, renderer, LY: LY_AU, embed: embed.api, loop };
