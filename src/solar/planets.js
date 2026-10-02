// The Sun, the eight planets and the Moon (other moons: moons.js): real-size textured globes, lit by the Sun, spinning by the IAU models.
import * as THREE from 'three';
import { KM_AU, DEG } from '../core/units.js';
import { PLANET_KEYS, PHYSICAL, planetElements, planetPosition, earthPosition, moonGeocentric } from '../core/planets.js';
import { bodyAxes } from '../core/rotation.js';
import { orbitPath, periodDays } from '../core/kepler.js';
import { distance, lightTime, period } from '../core/format.js';
import { surfaceMaterial, loadTexture, planetTexture, sharpTexture, swapTexture, Sharpen, glowTexture, STAR_TEXTURE, toVector3 } from './util.js';

const HAS_4K = new Set(['earth', 'venus', 'mars', 'jupiter', 'saturn', 'moon']);
const SHARP = 0.22;   // a body gets its 4k map once its radius covers this share of the window height
/** The first (2k) texture, unless a sharper one already arrived. */
const firstTexture = (u, t) => { if (!t) return; if (u.value) t.dispose(); else u.value = t; };
import { addBody, byKey, ORIGIN, layerOn, onLayers } from './world.js';

const STYLE = { // label/orbit colour, atmosphere [rgb, strength], gas giant (soft terminator)
  mercury: ['#b9a99a'], venus: ['#f2d7a0', [1, .85, .55], .5], earth: ['#5fa8ff', [.35, .6, 1], 1.2], mars: ['#ff7a4d', [1, .55, .35], .35],
  jupiter: ['#e2c49c', [1, .9, .75], .35, true], saturn: ['#f0dba2', [1, .92, .7], .3, true], uranus: ['#9fe3ec', [.6, .95, 1], .45, true], neptune: ['#5b7dff', [.45, .6, 1], .5, true],
};
export const FACTS = {
  sun: 'A middle-aged G-type star, 4.6 billion years old. It holds 99.86% of all the mass in the Solar System.',
  mercury: 'Smallest planet. A year lasts 88 days, but a solar day (sunrise to sunrise) lasts 176.',
  venus: 'The hottest planet (465 °C) under a crushing CO₂ atmosphere. It spins backwards, slower than it orbits.',
  earth: 'The only known world with life. You are here.',
  mars: 'Home to Olympus Mons, the tallest volcano in the Solar System, and several rovers still at work.',
  jupiter: 'More than twice the mass of all the other planets combined. The Great Red Spot is a storm wider than Earth.',
  saturn: 'Its rings are 280,000 km wide but mostly just 10–100 m thick.',
  uranus: 'Tipped on its side (98°), so each pole gets 42 years of sunlight, then 42 years of darkness.',
  neptune: 'The windiest planet: up to 2,100 km/h. Found by maths before it was seen through a telescope (1846).',
  moon: 'The only other world people have walked on (1969–1972). It drifts 3.8 cm further from Earth every year.',
};

const axes = { x: {}, y: {}, z: {} }, _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
function orient(key, jd, q) { bodyAxes(key, jd, axes); return q.setFromRotationMatrix(_m.makeBasis(toVector3(axes.x, _x), toVector3(axes.y, _y), toVector3(axes.z, _z))); }

/** Lit globe: day map (+ optional night lights), soft atmosphere rim, optional ring shadow (Saturn). */
export function globeMaterial(sunView, { atm = [0, 0, 0], atmK = 0, wrap = 0, ring = false }) {
  return surfaceMaterial({
    uniforms: { map: { value: null }, night: { value: null }, hasNight: { value: 0 }, uSun: { value: sunView }, atm: { value: new THREE.Vector3(...atm) }, atmK: { value: atmK }, wrap: { value: wrap },
      hasRing: { value: 0 }, ringN: { value: new THREE.Vector3() }, ringC: { value: new THREE.Vector3() }, ringIn: { value: 0 }, ringOut: { value: 0 }, ringTex: { value: null } },
    frag: {
      decl: `uniform sampler2D map; uniform sampler2D night; uniform float hasNight; uniform vec3 uSun; uniform vec3 atm; uniform float atmK; uniform float wrap;
             uniform float hasRing; uniform vec3 ringN; uniform vec3 ringC; uniform float ringIn; uniform float ringOut; uniform sampler2D ringTex;`,
      body: `vec3 N = normalize(vN), V = normalize(-vP), L = normalize(uSun - vP);
        float ndl = dot(N, L), lit = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
        if (hasRing > 0.5) {                                   // the rings' shadow on the cloud tops
          float den = dot(L, ringN);
          if (abs(den) > 1e-5) { float t = dot(ringC - vP, ringN) / den; if (t > 0.0) { float r = length(vP + L * t - ringC);
            if (r > ringIn && r < ringOut) lit *= 1.0 - 0.85 * texture2D(ringTex, vec2((r - ringIn) / (ringOut - ringIn), 0.5)).a; } }
        }
        col = texture2D(map, vUv).rgb * lit;
        if (hasNight > 0.5) col += texture2D(night, vUv).rgb * smoothstep(0.08, -0.12, ndl) * 1.4;
        col += atm * pow(1.0 - max(dot(N, V), 0.0), 3.0) * atmK * smoothstep(-0.25, 0.35, ndl);`,
    },
  });
}

/** Atmosphere halo: a slightly larger back-faced sphere, additive, brighter on the day side. */
function halo(sunView, color, k) {
  return new THREE.Mesh(new THREE.SphereGeometry(1.035, 64, 32), surfaceMaterial({
    uniforms: { c: { value: new THREE.Color(...color) }, k: { value: k }, uSun: { value: sunView } }, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    frag: { decl: 'uniform vec3 c; uniform float k; uniform vec3 uSun;',
      body: `vec3 N = normalize(vN); float f = pow(clamp(1.0 + dot(N, normalize(-vP)) * 1.15, 0.0, 1.0), 2.5);
        col = c * f * k * (0.15 + 0.85 * smoothstep(-0.35, 0.4, dot(-N, normalize(uSun - vP))));` },
  }));
}

export function createPlanets({ scene, sunView, renderer }) {
  const ringTex = loadTexture('brand/textures/planets/saturn_ring.png');

  // ---- the Sun: textured sphere, corona, and a star-like point that keeps it visible from light-years away
  const sunR = PHYSICAL.sun.radiusKm * KM_AU, sun = new THREE.Group(); scene.add(sun);
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  sunMesh.scale.setScalar(sunR); sun.add(sunMesh);
  loadTexture(planetTexture('sun')).then(t => { if (t) { sunMesh.material.map = t; sunMesh.material.color.setRGB(1.6, 1.4, 1.1); sunMesh.material.needsUpdate = true; } });
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture([[0, 'rgba(255,240,210,1)'], [0.12, 'rgba(255,214,140,.55)'], [0.35, 'rgba(255,170,80,.14)'], [1, 'rgba(255,140,40,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  corona.scale.setScalar(sunR * 14); sun.add(corona);
  const sunStar = new THREE.Sprite(new THREE.SpriteMaterial({ map: STAR_TEXTURE, color: 0xfff1d6, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false }));
  sun.add(sunStar);
  addBody({ key: 'sun', name: 'Sun', kind: 'star', color: '#ffd27a', radius: sunR, pos: ORIGIN, group: sun, big: true, fixed: true, fact: FACTS.sun,
    info: () => [['Type', 'G2V star'], ['Radius', '695,700 km (109 × Earth)'], ['Surface', '5,500 °C'], ['Light to Earth', lightTime(byKey.earth.pos.length())]] });

  // ---- planets
  for (const key of PLANET_KEYS) {
    const { name, radiusKm, flattening } = PHYSICAL[key], [color, atm, atmK = 0, gas] = STYLE[key];
    const R = radiusKm * KM_AU, group = new THREE.Group(), spin = new THREE.Group(); scene.add(group); group.add(spin);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, key === 'earth' ? 128 : 96, key === 'earth' ? 64 : 48), globeMaterial(sunView, { atm: atm || [0, 0, 0], atmK, wrap: gas ? 0.05 : 0 }));
    const flat = key === 'earth' ? 0 : flattening; // Earth's 0.3% would only matter to its clouds; skip it
    mesh.scale.set(R, R * (1 - flat), R); mesh.visible = false; spin.add(mesh);
    loadTexture(planetTexture(key)).then(t => { firstTexture(mesh.material.uniforms.map, t); mesh.visible = !!mesh.material.uniforms.map.value; });
    if (atm) { const h = halo(sunView, atm, key === 'earth' ? 1.1 : 0.6); h.scale.set(R, R * (1 - flat), R); spin.add(h); }
    const b = addBody({ key, name, kind: 'planet', color, radius: R, pos: new THREE.Vector3(), group, spin, mesh, big: true, fact: FACTS[key],
      update(jd) { (key === 'earth' ? earthPosition : (j, o) => planetPosition(key, j, o))(jd, b.pos); group.position.copy(b.pos); orient(key, jd, spin.quaternion); },
      info() {
        const el = planetElements(key, b.jd ?? 0), dE = b.pos.distanceTo(byKey.earth.pos);
        return [['Distance from Sun', distance(b.pos.length())], ['From Earth', key === 'earth' ? '—' : distance(dE) + ' · light ' + lightTime(dE)],
          ['Year', period(periodDays(el.a))], ['Radius', Math.round(radiusKm).toLocaleString('en-US') + ' km'], ['Orbit tilt', (el.i / DEG).toFixed(2) + '°']];
      } });
    if (HAS_4K.has(key)) Sharpen.add(() => Sharpen.px(b) > innerHeight * SHARP, sharpTexture(key), t => swapTexture(mesh.material.uniforms.map, t));
    if (key === 'earth') addEarthExtras(b, sunView, R);
    if (key === 'saturn') addRings(b, sunView, R, ringTex);
  }

  // ---- the Moon (geocentric + Earth)
  {
    const R = PHYSICAL.moon.radiusKm * KM_AU, group = new THREE.Group(), spin = new THREE.Group(); scene.add(group); group.add(spin);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), globeMaterial(sunView, {})); mesh.scale.setScalar(R); mesh.visible = false; spin.add(mesh);
    loadTexture(planetTexture('moon')).then(t => { firstTexture(mesh.material.uniforms.map, t); mesh.visible = !!mesh.material.uniforms.map.value; });
    const geo = new THREE.Vector3();
    const b = addBody({ key: 'moon', name: 'Moon', kind: 'moon', color: '#cfd3da', radius: R, pos: new THREE.Vector3(), geo, group, spin, mesh, fact: FACTS.moon,
      update(jd) { moonGeocentric(jd, geo); b.pos.copy(byKey.earth.pos).add(geo); group.position.copy(b.pos); orient('moon', jd, spin.quaternion); },
      info: () => [['From Earth', Math.round(geo.length() / KM_AU).toLocaleString('en-US') + ' km'], ['Light from Earth', lightTime(geo.length())], ['Radius', '1,737 km']] });
    Sharpen.add(() => Sharpen.px(b) > innerHeight * SHARP, sharpTexture('moon'), t => swapTexture(mesh.material.uniforms.map, t));
  }

  // ---- orbits (rebuilt every ten simulated years: the elements drift slowly)
  const orbits = new THREE.Group(); scene.add(orbits);
  let orbitsJd = null;
  function rebuildOrbits(jd) {
    orbitsJd = jd;
    for (const c of [...orbits.children]) { orbits.remove(c); c.geometry.dispose(); }
    for (const key of PLANET_KEYS) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(orbitPath(planetElements(key, jd)), 3));
      orbits.add(new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: STYLE[key][0], transparent: true, opacity: 0.4, depthWrite: false })));
    }
  }
  onLayers(() => { orbits.visible = layerOn('orbits'); });

  // ---- dots, so planets stay visible when their real disc is under a few pixels
  const dotKeys = [...PLANET_KEYS, 'moon'];
  const dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: { map: { value: STAR_TEXTURE } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: '#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute vec3 color; attribute float size; varying vec3 vC;\nvoid main(){ vC = color; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n#include <logdepthbuf_vertex>\n}',
    fragmentShader: '#include <logdepthbuf_pars_fragment>\nuniform sampler2D map; varying vec3 vC;\nvoid main(){\n#include <logdepthbuf_fragment>\nfloat a = texture2D(map, gl_PointCoord).a; gl_FragColor = vec4(vC * a, a);\n#include <colorspace_fragment>\n}',
  }));
  dots.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dotKeys.length * 3), 3));
  dots.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(dotKeys.flatMap(k => new THREE.Color(byKey[k].color).toArray())), 3));
  dots.geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(dotKeys.length), 1));
  dots.frustumCulled = false; scene.add(dots);

  const ringN = new THREE.Vector3();
  return {
    update(jd) {
      if (orbitsJd === null || Math.abs(jd - orbitsJd) > 3650) rebuildOrbits(jd);
      for (const k of PLANET_KEYS) byKey[k].jd = jd;
      orient('sun', jd, sunMesh.quaternion);
    },
    frame({ camera, camSun, fade }) {
      sunStar.scale.setScalar(0.035 + 0.02 * (1 - fade(50, 5e4, camSun)));
      sunStar.material.opacity = Math.max(0.15, 1 - fade(30, 3000, camSun, 'ly'));
      orbits.children.forEach(c => { c.material.opacity = 0.42 * (1 - fade(2000, 3e4, camSun)); });
      const sizes = dots.geometry.attributes.size, P = dots.geometry.attributes.position, pxPerRad = innerHeight / (2 * Math.tan(camera.fov * DEG / 2));
      dotKeys.forEach((k, i) => {
        const b = byKey[k]; P.setXYZ(i, b.pos.x, b.pos.y, b.pos.z);
        const px = b.radius / Math.max(camera.position.distanceTo(b.pos), 1e-12) * pxPerRad;
        const show = px < 3 && camSun < 3000 && !(k === 'moon' && camera.position.distanceTo(byKey.earth.pos) > 0.3);
        sizes.setX(i, show ? 7 * renderer.getPixelRatio() : 0);
      });
      sizes.needsUpdate = true; P.needsUpdate = true;
      const sat = byKey.saturn, m = sat.mesh.material.uniforms;      // ring geometry for both shadow directions, in view space
      ringN.set(0, 1, 0).applyQuaternion(sat.spin.quaternion).transformDirection(camera.matrixWorldInverse);
      m.ringN.value.copy(ringN); m.ringC.value.copy(sat.pos).applyMatrix4(camera.matrixWorldInverse);
      if (sat.ring) sat.ring.material.uniforms.pC.value.copy(m.ringC.value);
    },
  };
}

function addEarthExtras(b, sunView, R) {
  const m = b.mesh.material.uniforms;
  loadTexture(planetTexture('earth_night')).then(t => { firstTexture(m.night, t); m.hasNight.value = m.night.value ? 1 : 0; });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.006, 128, 64), surfaceMaterial({
    uniforms: { map: { value: null }, uSun: { value: sunView } }, transparent: true, depthWrite: false,
    frag: { decl: 'uniform sampler2D map; uniform vec3 uSun;',
      body: 'col = vec3(clamp(dot(normalize(vN), normalize(uSun - vP)) * 1.2 + 0.05, 0.0, 1.0)); alpha = texture2D(map, vUv).r * 0.92;' },
  }));
  clouds.scale.setScalar(R); clouds.visible = false; b.spin.add(clouds); b.clouds = clouds;
  loadTexture(planetTexture('earth_clouds'), { srgb: false }).then(t => { firstTexture(clouds.material.uniforms.map, t); clouds.visible = !!clouds.material.uniforms.map.value; });
  Sharpen.add(() => Sharpen.px(b) > innerHeight * SHARP, sharpTexture('earth_night'), t => { swapTexture(m.night, t); m.hasNight.value = 1; });
  Sharpen.add(() => Sharpen.px(b) > innerHeight * SHARP, sharpTexture('earth_clouds'), t => { swapTexture(clouds.material.uniforms.map, t); clouds.visible = true; }, { srgb: false });
}

function addRings(b, sunView, R, ringTex) {
  const { innerKm, outerKm } = PHYSICAL.saturn.rings, inner = innerKm * KM_AU, outer = outerKm * KM_AU;
  const g = new THREE.RingGeometry(inner, outer, 256, 1), pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (Math.hypot(pos.getX(i), pos.getY(i)) - inner) / (outer - inner), 0.5); // u = radius
  const ring = new THREE.Mesh(g, surfaceMaterial({
    uniforms: { map: { value: null }, uSun: { value: sunView }, pC: { value: new THREE.Vector3() }, pR: { value: R } }, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    frag: { decl: 'uniform sampler2D map; uniform vec3 uSun; uniform vec3 pC; uniform float pR;',
      body: `vec4 t = texture2D(map, vUv); vec3 L = normalize(uSun - vP), oc = vP - pC;   // Saturn's shadow across the rings
        float bb = dot(oc, L), c = dot(oc, oc) - pR * pR, h = bb * bb - c; float sh = (h > 0.0 && -bb - sqrt(h) > 0.0) ? 0.08 : 1.0;
        col = t.rgb * sh * 1.05; alpha = t.a * 0.95;` },
  }));
  ring.rotation.x = -Math.PI / 2; b.spin.add(ring); b.ring = ring;
  const m = b.mesh.material.uniforms; m.ringIn.value = inner; m.ringOut.value = outer;
  ringTex.then(t => { ring.material.uniforms.map.value = t; m.ringTex.value = t; m.hasRing.value = t ? 1 : 0; });
}
