// Every catalogued asteroid (1.57M, JPL SBDB) and comet, each solving Kepler's equation in the vertex shader, plus
// the named worlds (dwarf planets, famous asteroids and comets) as focusable bodies.
import * as THREE from 'three';
import { KM_AU, DEG } from '../core/units.js';
import { positionAt, orbitPath, periodDays } from '../core/kepler.js';
import { CLASSES, viewSmallBodies, decodeElements, cometElements, packSmallBodies, DEFAULT_EPOCH } from '../core/smallbodies.js';
import { fetchAsset } from '../core/assets.js';
import { distance, period } from '../core/format.js';
import { LOGDEPTH_V, LOGDEPTH_F, PHONE } from './util.js';
import { addBody, removeBody, byKey, bodies, layer, layerOn, onLayers } from './world.js';

const CLASS_STYLE = [ // colour, per-point brightness (the main belt is 1.47M points: keep each faint), default on
  [[0.78, 0.72, 0.62], 0.032], [[1.0, 0.42, 0.32], 0.38], [[0.5, 0.9, 0.55], 0.24], [[0.82, 0.6, 1.0], 0.6],
  [[0.45, 0.72, 1.0], 0.4], [[1.0, 0.76, 0.42], 0.14], [[0.7, 0.7, 0.7], 0.3],
];
export const CLASS_LAYERS = CLASSES.map((name, i) => ({ id: 'cls' + i, name, c: '#' + new THREE.Color(...CLASS_STYLE[i][0]).getHexString(), on: true, sub: true }));

const DWARFS = [ // SBDB label, display name, radius km, colour, fact
  ['1 Ceres', 'Ceres', 469.7, '#c9c2b8', 'The largest object in the asteroid belt; NASA\'s Dawn orbited it 2015–2018.'],
  ['134340 Pluto', 'Pluto', 1188.3, '#e8cfb0', 'Visited by New Horizons in July 2015: a heart-shaped nitrogen glacier and mountains of water ice.'],
  ['136199 Eris', 'Eris', 1163, '#e6e6ea', 'Almost exactly Pluto\'s size; its discovery in 2005 is why Pluto was reclassified.'],
  ['136108 Haumea', 'Haumea', 780, '#e0e0e0', 'Spins every 4 hours, stretched into an egg shape, and has a ring.'],
  ['136472 Makemake', 'Makemake', 715, '#e3b38f', 'A reddish dwarf planet in the Kuiper belt.'],
  ['90377 Sedna', 'Sedna', 500, '#d06a4f', 'Its 11,400-year orbit reaches about 940 AU from the Sun.'],
  ['486958 Arrokoth', 'Arrokoth', 18, '#c46d57', 'The most distant object ever visited (New Horizons, 2019): two lobes gently stuck together.'],
  ['4 Vesta', 'Vesta', 262.7, '#bdb6aa', 'Second-largest asteroid; Dawn orbited it in 2011–2012.'],
  ['101955 Bennu', 'Bennu', 0.245, '#8f8a84', 'OSIRIS-REx collected 121 g of it and brought it to Earth in 2023.'],
  ['433 Eros', 'Eros', 8.4, '#b09a80', 'The first asteroid a spacecraft landed on (NEAR Shoemaker, 2001).'],
];
// designations, not names: dozens of comets are called "NEOWISE" after the survey that found them
const FAMOUS_COMETS = ['1P/Halley', '2P/Encke', '67P/Churyumov-Gerasimenko', 'C/1995 O1', 'C/2020 F3', '109P/Swift-Tuttle', '55P/Tempel-Tuttle'];

const VERT = LOGDEPTH_V + `
  attribute float a; attribute float e; attribute float inc; attribute float node; attribute float peri; attribute float m0; attribute float cls;
  uniform float uDays; uniform float uShow[7]; uniform vec3 uCol[7]; uniform float uSize; uniform float uPR; varying vec3 vC;
  void main() {
    int c = int(cls + 0.5);
    if (uShow[c] < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    // the same decoding and Newton iteration as src/core (kepler.js, smallbodies.js)
    float M = mod(m0 * 6.2831853 + 0.0172020990 * pow(a, -1.5) * uDays, 6.2831853);
    float E = e < 0.8 ? M + e * sin(M) : 3.1415927;
    for (int k = 0; k < 9; k++) E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
    float xv = a * (cos(E) - e), yv = a * sqrt(max(1.0 - e * e, 0.0)) * sin(E);
    float O = node * 6.2831853, w = peri * 6.2831853, i = inc * 3.1415927, cO = cos(O), sO = sin(O), cw = cos(w), sw = sin(w), ci = cos(i), si = sin(i);
    vec3 p = vec3((cO * cw - sO * sw * ci) * xv + (-cO * sw - sO * cw * ci) * yv, (sO * cw + cO * sw * ci) * xv + (-sO * sw + cO * cw * ci) * yv, sw * si * xv + cw * si * yv);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); gl_PointSize = uSize * uPR * (c == 1 ? 1.4 : 1.0); vC = uCol[c];
    #include <logdepthbuf_vertex>
  }`;
const FRAG = LOGDEPTH_F + `uniform float uFade; varying vec3 vC;
  void main() {
    #include <logdepthbuf_fragment>
    float a = smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vC * a * uFade, 1.0);
    #include <colorspace_fragment>
  }`;

export function createSmallBodies({ scene, renderer }) {
  const S = { epoch: DEFAULT_EPOCH, named: [], comets: [], files: [], points: [], cometPoints: null, loadingAll: false, full: !PHONE };
  const uniforms = {
    uDays: { value: 0 }, uFade: { value: 1 }, uShow: { value: CLASS_STYLE.map(() => 1) }, uSize: { value: PHONE ? 1.6 : 1.5 }, uPR: { value: renderer.getPixelRatio() },
    uCol: { value: CLASS_STYLE.map(([c, k]) => new THREE.Vector3(...c).multiplyScalar(k)) },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

  function pointsFor(buffer) {
    const v = viewSmallBodies(buffer), g = new THREE.BufferGeometry(), u16 = arr => new THREE.BufferAttribute(arr, 1, true);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v.N * 3), 3)); // unused: sizes the draw call
    g.setAttribute('a', new THREE.BufferAttribute(v.a, 1));
    g.setAttribute('e', u16(v.e)); g.setAttribute('inc', u16(v.i)); g.setAttribute('node', u16(v.node)); g.setAttribute('peri', u16(v.peri)); g.setAttribute('m0', u16(v.M0));
    g.setAttribute('cls', new THREE.BufferAttribute(v.cls, 1));
    const p = new THREE.Points(g, material); p.frustumCulled = false; scene.add(p);
    return { points: p, view: v };
  }
  const elementsOf = (file, idx) => { const f = S.files[file === 'b' ? 1 : 0]; return f ? decodeElements(f.view, idx, S.epoch) : null; };
  const count = () => S.files.reduce((n, f) => n + (f ? f.view.N : 0), 0);

  async function load() {
    const meta = await fetchAsset('data/solar/small_bodies.json', 'json');
    S.epoch = meta.epoch_jd; S.named = meta.named; S.comets = meta.comets;
    S.files[0] = pointsFor(await fetchAsset('data/solar/asteroids_a.bin'));
    layer('asteroids').n = count();
    addNamedWorlds(); addComets();
    if (S.full) loadAll();
  }
  async function loadAll() { // the other 1.27M (19 MB): only on the higher quality levels (quality.js)
    if (S.loadingAll || S.files[1]) return; S.loadingAll = true;
    try { S.files[1] = pointsFor(await fetchAsset('data/solar/asteroids_b.bin')); S.files[1].points.visible = layerOn('asteroids') && S.full; layer('asteroids').n = count(); onChange(); }
    catch (e) { console.warn('asteroids_b', e); } finally { S.loadingAll = false; }
  }
  let onChange = () => {};

  function addNamedWorlds() {
    for (const [label, name, rkm, color, fact] of DWARFS) {
      const hit = S.named.find(n => n[2] === label); if (!hit) continue;
      const el = elementsOf(hit[0], hit[1]); if (!el) continue;
      const R = rkm * KM_AU, group = new THREE.Group(); scene.add(group);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshLambertMaterial({ color })); mesh.scale.setScalar(R); group.add(mesh);
      const orbit = orbitLine(el, color, 0.25);
      const b = addBody({ key: name.toLowerCase(), name, kind: rkm > 400 ? 'dwarf planet' : 'asteroid', color, radius: R, pos: new THREE.Vector3(), group, el, fact, small: true, layer: 'dwarfs', orbit,
        update(jd) { positionAt(el, jd, b.pos); group.position.copy(b.pos); },
        info: () => [['Distance from Sun', distance(b.pos.length())], ['From Earth', distance(b.pos.distanceTo(byKey.earth.pos))], ['Year', period(periodDays(el.a))],
          ['Radius', rkm < 10 ? rkm + ' km' : Math.round(rkm).toLocaleString('en-US') + ' km'], ['Orbit', 'a ' + el.a.toFixed(2) + ' AU · e ' + el.e.toFixed(3)]] });
    }
  }
  function orbitLine(el, color, opacity, n = 720) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(orbitPath(el, n), 3));
    const l = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })); l.userData.opacity = opacity; scene.add(l); return l;
  }

  function addComets() {
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const elliptic = [];
    for (const row of S.comets) {
      const el = cometElements(row, S.epoch); if (!el) continue; elliptic.push(el);
      const full = row[0]; if (!FAMOUS_COMETS.some(f => full.startsWith(f))) continue;
      const name = full.replace(/^.*\(([^)]+)\)$/, '$1').replace(/^\d+P\//, ''), group = new THREE.Group(); scene.add(group);
      const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      const tail = new THREE.Mesh(tg, tailMat); tail.frustumCulled = false; scene.add(tail);
      const b = addBody({ key: 'comet:' + full, name, full, kind: 'comet', color: '#bfe3ff', radius: 5 * KM_AU, pos: new THREE.Vector3(), group, el, tail, small: true, layer: 'comets', orbit: orbitLine(el, '#7fb6d9', 0.3, 1440),
        update(jd) { positionAt(el, jd, b.pos); group.position.copy(b.pos); },
        info: () => [['Distance from Sun', distance(b.pos.length())], ['Orbit', period(periodDays(el.a))], ['Closest to Sun', row[1].toFixed(3) + ' AU'], ['Farthest', (el.a * (1 + el.e)).toFixed(1) + ' AU']] });
    }
    S.cometPoints = pointsFor(packSmallBodies(elliptic, 6)).points;
  }

  // a picked or searched asteroid becomes a temporary body with its orbit drawn
  const picked = orbitLine({ a: 1, e: 0, i: 0, node: 0, peri: 0 }, '#ffffff', 0.6); picked.visible = false;
  function asteroidBody(n) {
    const [file, idx, label, H, diam, cls] = n, key = 'ast:' + label; if (byKey[key]) return byKey[key];
    const el = elementsOf(file, idx); if (!el) return null;
    for (const old of bodies.filter(x => x.transient)) { removeBody(old); scene.remove(old.group); }
    const group = new THREE.Group(); scene.add(group);
    const kind = cls === 0 ? 'main-belt asteroid' : (CLASSES[cls] || 'asteroid').replace(/s$/, '').replace(/ & beyond$/, ' object').toLowerCase();
    const b = addBody({ key, name: label, kind, color: '#e6d6b8', radius: (diam || 1) / 2 * KM_AU, pos: positionAt(el, uniforms.uDays.value + S.epoch, new THREE.Vector3()), group, el, small: true, transient: true, layer: 'asteroids',
      update(jd) { positionAt(el, jd, b.pos); },
      info: () => [['Distance from Sun', distance(b.pos.length())], ['From Earth', distance(b.pos.distanceTo(byKey.earth.pos))], ['Year', period(periodDays(el.a))],
        ['Size', diam ? diam + ' km across' : 'unknown (H ' + H + ')'], ['Orbit', 'a ' + el.a.toFixed(2) + ' AU · e ' + el.e.toFixed(3) + ' · i ' + (el.i / DEG).toFixed(1) + '°']] });
    picked.geometry.attributes.position.array.set(orbitPath(el)); picked.geometry.attributes.position.needsUpdate = true; picked.visible = true;
    return b;
  }
  function pickAsteroid(x, y, jd, screenOf) {
    let best = null, bd = 8; const p = new THREE.Vector3();
    for (const n of S.named) {
      const el = elementsOf(n[0], n[1]); if (!el) continue;
      const s = screenOf(positionAt(el, jd, p)); if (!s) continue;
      const d = Math.hypot(s[0] - x, s[1] - y); if (d < bd) { bd = d; best = n; }
    }
    return best ? asteroidBody(best) : null;
  }
  function search(q, limit) {
    const out = [];
    for (const n of S.named) if (n[2].toLowerCase().includes(q)) { out.push(n); if (out.length >= limit) break; }
    return out;
  }

  onLayers(() => {
    S.files.forEach((f, i) => { if (f) f.points.visible = layerOn('asteroids') && (i === 0 || S.full); });
    if (S.cometPoints) S.cometPoints.visible = layerOn('comets');
    CLASSES.forEach((_, i) => { uniforms.uShow.value[i] = layerOn('cls' + i) ? 1 : 0; });
    for (const b of bodies) {
      if (b.layer === 'dwarfs' || b.layer === 'comets') { b.group.visible = layerOn(b.layer); if (b.orbit) b.orbit.visible = layerOn(b.layer); if (b.tail) b.tail.visible = layerOn('comets'); }
    }
    if (layerOn('asteroids') && S.full && S.files[0]) loadAll();
  });

  return {
    /** All 1.57M asteroids (true) or the brightest 300k (false); the second file loads on first use. */
    setFull(on) {
      S.full = on; if (S.files[1]) S.files[1].points.visible = on && layerOn('asteroids'); else if (on && S.files[0] && layerOn('asteroids')) loadAll();
      layer('asteroids').n = S.files[0] ? S.files[0].view.N + (on && S.files[1] ? S.files[1].view.N : 0) : 0; onChange();
    },
    S, load, asteroidBody, pickAsteroid, search, set onChange(fn) { onChange = fn; },
    update(jd) { uniforms.uDays.value = jd - S.epoch; },
    frame({ camera, camSun, fade }) {
      uniforms.uPR.value = renderer.getPixelRatio();
      uniforms.uFade.value = (1 - fade(600, 6000, camSun)) * (1 - 0.88 * fade(12, 120, camSun)); // the belt piles into a blob from far out
      for (const b of bodies) {
        if (b.orbit) b.orbit.material.opacity = b.orbit.userData.opacity * (1 - fade(2000, 3e4, camSun));
        if (b.kind !== 'comet') continue;
        const r = b.pos.length(), on = r < 6 && layerOn('comets'); b.tail.visible = on; if (!on) continue;
        const dir = b.pos.clone().normalize(), len = Math.min(0.6, 0.25 / (r * r) + 0.02);      // tails point away from the Sun
        const side = new THREE.Vector3().crossVectors(dir, camera.position.clone().sub(b.pos)).normalize().multiplyScalar(len * 0.12);
        const end = b.pos.clone().addScaledVector(dir, len), a = b.tail.geometry.attributes.position;
        a.setXYZ(0, b.pos.x, b.pos.y, b.pos.z); a.setXYZ(1, end.x + side.x, end.y + side.y, end.z + side.z); a.setXYZ(2, end.x - side.x, end.y - side.y, end.z - side.z); a.needsUpdate = true;
      }
    },
  };
}
