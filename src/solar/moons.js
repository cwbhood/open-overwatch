// The major moons of Mars, Jupiter, Saturn, Uranus, Neptune and Pluto: real-size lit spheres, orbit lines and labels
// that appear as you near their planet. Orbits: core/moons.js (fitted to JPL Horizons, data/solar/moons.json).
import * as THREE from 'three';
import { KM_AU, DEG } from '../core/units.js';
import { orbitPath } from '../core/kepler.js';
import { moonOffset, moonPeriod } from '../core/moons.js';
import { fetchAsset } from '../core/assets.js';
import { distance } from '../core/format.js';
import { STAR_TEXTURE, swapTexture, Sharpen } from './util.js';
import { globeMaterial } from './planets.js';
import { addBody, byKey, layer, layerOn, onLayers } from './world.js';

const LOOK = { // surface colour, fact
  Phobos: ['#7a6a5e', 'The larger of Mars\' two moons, 22 km across. It creeps about 2 m closer to Mars every century and will break up in tens of millions of years.'],
  Deimos: ['#9c8b7a', 'Mars\' smaller moon, just 12 km across. From the Martian surface it looks like a bright star.'],
  Io: ['#e8d27a', 'The most volcanic world known: hundreds of active volcanoes, heated by Jupiter\'s tides.'],
  Europa: ['#d9cbb0', 'An ice shell over a global salt-water ocean with more water than all of Earth\'s. Europa Clipper arrives in 2030.'],
  Ganymede: ['#a89f94', 'The largest moon in the Solar System, bigger than Mercury, and the only moon with its own magnetic field.'],
  Callisto: ['#6f665c', 'The most heavily cratered surface known: it has barely changed in four billion years.'],
  Mimas: ['#c9c9c9', 'Its crater Herschel is a third as wide as the whole moon.'],
  Enceladus: ['#f4f7fa', 'Geysers at its south pole spray its underground ocean into space and feed Saturn\'s E ring.'],
  Tethys: ['#e6e3dc', 'Almost pure water ice, with a canyon running three-quarters of the way around it.'],
  Dione: ['#d6d3cc', 'Bright ice cliffs hundreds of kilometres long streak its trailing side.'],
  Rhea: ['#c8c4bc', 'Saturn\'s second-largest moon: an icy, cratered ball 1,500 km across.'],
  Titan: ['#e0a84e', 'The only moon with a thick atmosphere, and lakes of liquid methane. The Dragonfly drone is due there in 2034.'],
  Iapetus: ['#9b8a74', 'Two-toned: one hemisphere as dark as coal, the other bright as snow, with a ridge around its equator.'],
  Miranda: ['#b9b9b9', 'A patchwork world with Verona Rupes, the tallest known cliff in the Solar System (about 20 km).'],
  Ariel: ['#c4c1bc', 'The brightest of Uranus\' moons, with the youngest surface.'],
  Umbriel: ['#6e6e6e', 'The darkest of Uranus\' large moons.'],
  Titania: ['#b5aaa0', 'Uranus\' largest moon, cut by canyons up to 1,500 km long.'],
  Oberon: ['#a0948a', 'The outermost of Uranus\' large moons, old and heavily cratered.'],
  Triton: ['#d8c7c0', 'It orbits backwards, so it was probably captured from the Kuiper belt. Voyager 2 saw nitrogen geysers there in 1989.'],
  Charon: ['#a7a19a', 'Half Pluto\'s size: the pair circle a point between them, each always showing the other the same face.'],
};
// Surfaces: real global maps (brand/textures/moons, USGS / NASA / ESA, see maps.json) where they exist, swapped in once
// loaded. Until then, and for the five Uranian moons Voyager 2 saw only half of, a procedural surface in the moon's
// colour (craters, Io's spots, Europa's cracks, haze, Iapetus' two faces) seeded by its id. Titan keeps the haze: its
// map is the surface under it, which no visible-light camera sees.
const SURFACE = { Io: 'io', Europa: 'lined', Enceladus: 'lined', Titan: 'haze', Triton: 'haze', Iapetus: 'twoface' };
function surfaceTexture(seed, hex, style) {
  const W = 512, H = 256, c = document.createElement('canvas'), g = c.getContext('2d'); c.width = W; c.height = H;
  let s = seed * 2654435761 >>> 0;
  const rnd = () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const blob = (x, y, r, fill) => {        // a round spot on the sphere: wider towards the poles in the equirectangular map
    const k = 1 / Math.max(Math.cos((0.5 - y / H) * Math.PI), 0.08); g.fillStyle = fill;
    for (const dx of [-W, 0, W]) { g.beginPath(); g.ellipse(x + dx, y, Math.min(r * k, W / 2), r, 0, 0, 2 * Math.PI); g.fill(); }
  };
  const lat = () => H / 2 + Math.asin(2 * rnd() - 1) / Math.PI * H;      // uniform over the sphere
  g.fillStyle = hex; g.fillRect(0, 0, W, H);
  for (let k = 0; k < 260; k++) blob(rnd() * W, lat(), 6 + rnd() * 34, `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${0.03 + rnd() * 0.06})`);
  g.filter = 'blur(6px)'; g.drawImage(c, 0, 0); g.filter = 'none';     // soft albedo patches, not discs
  if (style === 'twoface') {               // leading hemisphere (90°W, u = 0.25) dark
    const grd = g.createLinearGradient(0, 0, W, 0);
    [[0, 0], [0.08, 0.75], [0.25, 0.82], [0.42, 0.75], [0.55, 0], [1, 0]].forEach(([o, a]) => grd.addColorStop(o, `rgba(25,18,12,${a})`));
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
  }
  if (style === 'io') for (let k = 0; k < 90; k++) blob(rnd() * W, lat(), 1.5 + rnd() * 5, rnd() < 0.6 ? 'rgba(60,30,10,.7)' : 'rgba(230,120,40,.55)');
  if (style === 'lined') { g.lineWidth = 1.2; for (let k = 0; k < 70; k++) { g.strokeStyle = `rgba(120,60,30,${0.15 + rnd() * 0.25})`; g.beginPath(); let x = rnd() * W, y = lat(); g.moveTo(x, y); for (let j = 0; j < 6; j++) { x += (rnd() - 0.3) * 60; y += (rnd() - 0.5) * 30; g.lineTo(x, y); } g.stroke(); } }
  if (style !== 'io' && style !== 'haze') {
    const n = style === 'lined' ? 25 : 420;
    for (let k = 0; k < n; k++) { const x = rnd() * W, y = lat(), r = 1 + Math.pow(rnd(), 3) * 14; blob(x, y, r * 1.25, 'rgba(255,255,255,.07)'); blob(x, y, r, 'rgba(0,0,0,.16)'); }
  }
  if (style === 'haze') { const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, 'rgba(255,255,255,.12)'); grd.addColorStop(0.5, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(255,255,255,.12)'); g.fillStyle = grd; g.fillRect(0, 0, W, H); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const NO_MAP = new Set(['Titan']);
function flatTexture(hex) {
  const n = parseInt(hex.slice(1), 16), t = new THREE.DataTexture(new Uint8Array([n >> 16, n >> 8 & 255, n & 255, 255]), 1, 1);   // sRGB bytes
  t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
}
/** Iapetus' map has its brightness evened out; darken the leading hemisphere (Cassini Regio) as it really looks. */
function darkenLeading(tex) {
  const img = tex.image, c = document.createElement('canvas'), g = c.getContext('2d'); c.width = img.width; c.height = img.height;
  g.drawImage(img, 0, 0); g.globalCompositeOperation = 'multiply';
  const grd = g.createLinearGradient(0, 0, c.width, 0);
  [[0, 1], [0.1, 0.35], [0.25, 0.18], [0.4, 0.35], [0.5, 1], [1, 1]].forEach(([o, v]) => grd.addColorStop(o, `rgb(${v * 255},${v * 240},${v * 225})`));
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const span = p => p < 2 ? (p * 24).toFixed(1) + ' hours' : p.toFixed(1) + ' days';

export function createMoons({ scene, sunView, renderer }) {
  const list = [], off = {}, white = new THREE.Color('#fff');
  const orbits = new THREE.Group(); scene.add(orbits);
  let orbitsJd = null;
  const dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: { map: { value: STAR_TEXTURE } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: '#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute vec3 color; attribute float size; varying vec3 vC;\nvoid main(){ vC = color; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n#include <logdepthbuf_vertex>\n}',
    fragmentShader: '#include <logdepthbuf_pars_fragment>\nuniform sampler2D map; varying vec3 vC;\nvoid main(){\n#include <logdepthbuf_fragment>\nfloat a = texture2D(map, gl_PointCoord).a; gl_FragColor = vec4(vC * a, a);\n#include <colorspace_fragment>\n}',
  }));
  dots.frustumCulled = false; scene.add(dots);
  onLayers(() => { const on = layerOn('moons'); orbits.visible = on && layerOn('orbits'); dots.visible = on; for (const b of list) b.group.visible = on; });

  function rebuildOrbits(jd) {
    orbitsJd = jd;
    for (const b of list) {
      const m = b.m, node = (m.node + m.node_rate * (jd - m.epoch_jd)) * DEG, varpi = (m.varpi + m.varpi_rate * (jd - m.epoch_jd)) * DEG;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(orbitPath({ a: m.a_km * KM_AU, e: m.e, i: m.i * DEG, node, peri: varpi - node }, 360), 3));
      b.path.geometry.dispose(); b.path.geometry = g;          // a new geometry, so the bounds are computed afresh
      b.normal.set(Math.sin(m.i * DEG) * Math.sin(node), -Math.sin(m.i * DEG) * Math.cos(node), Math.cos(m.i * DEG));
    }
  }

  return {
    async load() {
      const { moons } = await fetchAsset('data/solar/moons.json', 'json');
      const maps = (await fetchAsset('brand/textures/moons/maps.json', 'json').catch(() => null))?.maps || {};
      for (const m of moons) {
        const [surface, fact] = LOOK[m.name] || ['#bbbbbb', ''], R = m.radius_km * KM_AU;
        const group = new THREE.Group(); scene.add(group);
        const map = maps[m.name], real = map && !NO_MAP.has(m.name);
        // a real map is coming: a plain 1-pixel placeholder in the moon's colour (painting a procedural one cost start-up time)
        const mat = globeMaterial(sunView, {}); mat.uniforms.map.value = real ? flatTexture(surface) : surfaceTexture(m.id, surface, SURFACE[m.name]);
        // texture longitude 0 (u = 0.5) faces the planet, 90°W (u = 0.25) leads: matches the lookAt below
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32).rotateY(-Math.PI / 2), mat); mesh.scale.setScalar(R); group.add(mesh);
        let sharp = false;   // 1k first, 2k close up (a late 1k never replaces the 2k)
        const useMap = (t, is2k) => { if (sharp && !is2k) { t.dispose(); return; } sharp ||= is2k; swapTexture(mat.uniforms.map, m.name === 'Iapetus' ? darkenLeading(t) : t); };
        const label = '#' + new THREE.Color(surface).lerp(white, 0.35).getHexString();
        const orbit = new THREE.LineLoop(undefined, new THREE.LineBasicMaterial({ color: label, transparent: true, opacity: 0.45, depthWrite: false })); orbits.add(orbit);
        const planetName = () => byKey[m.planet]?.name || m.planet;
        const b = addBody({ key: m.name.toLowerCase(), name: m.name, kind: 'moon', color: label, radius: R, pos: new THREE.Vector3(), group, mesh, path: orbit, m, fact, layer: 'moons',
          parent: m.planet, near: m.a_km * KM_AU * 40, normal: new THREE.Vector3(0, 0, 1),
          posAt(jd, out) { const P = byKey[m.planet]; if (!P?.posAt) return out.copy(P ? P.pos : out); P.posAt(jd, out); const o = moonOffset(m, jd, {}); out.x += o.x; out.y += o.y; out.z += o.z; return out; },
          info: () => [['Orbits', planetName()], ['From ' + planetName(), Math.round(m.a_km).toLocaleString('en-US') + ' km'], ['Once around', span(moonPeriod(m)) + (m.i > 90 ? ' (backwards)' : '')],
            ['Radius', m.radius_km.toLocaleString('en-US') + ' km'], ['From Earth', distance(b.pos.distanceTo(byKey.earth.pos))]] });
        if (real) {   // 1k once you are near the planet, 2k close up (desktops)
          Sharpen.need(() => byKey[b.parent] && Sharpen.camera.position.distanceTo(byKey[b.parent].pos) < b.near, map.file_1k, t => useMap(t, false));
          Sharpen.add(() => Sharpen.px(b) > innerHeight * 0.18, map.file, t => useMap(t, true));
        }
        list.push(b);
      }
      dots.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(list.length * 3), 3));
      dots.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(list.flatMap(b => new THREE.Color(b.color).toArray())), 3));
      dots.geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(list.length), 1));
      layer('moons').n = list.length; orbitsJd = null;
    },
    /** After the planets (and Pluto) have moved. */
    update(jd) {
      if (!list.length) return;
      if (orbitsJd === null || Math.abs(jd - orbitsJd) > 365) rebuildOrbits(jd);
      for (const b of list) {
        const P = byKey[b.parent]; if (!P) continue;
        moonOffset(b.m, jd, off); b.pos.set(P.pos.x + off.x, P.pos.y + off.y, P.pos.z + off.z);
        b.group.position.copy(b.pos); b.path.position.copy(P.pos);
        // tidally locked: +z to the planet. Map north is the IAU pole, on the north side of the invariable plane, so a
        // retrograde moon (Triton) has north against its orbit normal and its leading side at 90°E instead of 90°W
        b.mesh.up.copy(b.normal); if (b.m.i > 90) b.mesh.up.negate(); b.mesh.lookAt(P.pos);
      }
    },
    frame({ camera }) {
      if (!list.length) return;
      const sizes = dots.geometry.attributes.size, pos = dots.geometry.attributes.position, pxPerRad = innerHeight / (2 * Math.tan(camera.fov * DEG / 2));
      list.forEach((b, i) => {
        const P = byKey[b.parent], dP = P ? camera.position.distanceTo(P.pos) : Infinity, near = dP < b.near;
        b.path.visible = b.mesh.visible = near; b.path.material.opacity = 0.45 * Math.min(1, 3 - 3 * dP / b.near);   // fades out on the way out
        pos.setXYZ(i, b.pos.x, b.pos.y, b.pos.z);
        const px = b.radius / Math.max(camera.position.distanceTo(b.pos), 1e-12) * pxPerRad;
        sizes.setX(i, near && px < 3 ? 5 * renderer.getPixelRatio() : 0);
      });
      sizes.needsUpdate = true; pos.needsUpdate = true;
    },
  };
}
