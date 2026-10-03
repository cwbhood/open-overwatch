// Other solar systems: every confirmed exoplanet (NASA Exoplanet Archive, data/solar/exoplanets.json made by
// brand/tools/make_exoplanets.py) at its host star in the 3D star map. Fly into a system and it is built on the spot:
// the star at its real size and colour, the habitable zone, the orbits and the planets at real size, lit by their own
// star and moving with the clock. Planets that transit have a measured transit time, so they are where they really are
// (circular orbits; the tilt of each orbit on our sky is unknown, so the line of nodes is arbitrary); the others get an
// arbitrary phase, and their cards say so.
import * as THREE from 'three';
import { LY_AU, KM_AU, DEG, radecToEcl } from '../core/units.js';
import { fetchAsset } from '../core/assets.js';
import { STAR_TEXTURE, LOGDEPTH_V, LOGDEPTH_F, PHONE } from './util.js';
import { globeMaterial } from './planets.js';
import { addBody, removeBody, byKey, layerOn, onLayers } from './world.js';

const R_SUN = 695700 * KM_AU, R_EARTH = 6371 * KM_AU;
// systems that get a label from the start (host, RA, Dec, light-years, fact); all others are found by search or flying
export const FAMOUS = [
  ['TRAPPIST-1', 346.6223, -5.0414, 40.5, 'Seven Earth-sized planets around a small red star, three of them in the habitable zone. A "year" on the closest one lasts 36 hours.'],
  ['Proxima Cen', 217.4289, -62.6795, 4.24, 'The nearest star to the Sun, with a planet in its habitable zone: about 4.2 light-years away.'],
  ['TOI-700', 97.0969, -65.5786, 101.5, 'An Earth-sized planet, TOI-700 d, in the habitable zone, found by NASA\'s TESS.'],
  ['Kepler-186', 298.6545, 43.9545, 579, 'Kepler-186 f was the first Earth-sized planet found in a habitable zone (2014).'],
  ['Kepler-452', 296.0119, 44.2778, 1799, 'Kepler-452 b: a "cousin" of Earth, around a Sun-like star, with a year of 385 days.'],
  ['51 Peg', 344.3668, 20.7688, 50.4, 'The first planet found around a Sun-like star (1995, Nobel Prize 2019): a hot Jupiter with a 4-day year.'],
  ['HD 209458', 330.7948, 18.8843, 157, 'The first planet seen passing in front of its star (2000), and the first with a detected atmosphere.'],
  ['Kepler-90', 284.4334, 49.3071, 2790, 'Eight planets, as many as our own Solar System.'],
  ['HR 8799', 346.8696, 21.1342, 133, 'Four giant planets photographed directly, orbiting far from their young star.'],
  ['K2-18', 172.5602, 7.5884, 124, 'A sub-Neptune in the habitable zone where JWST found methane and carbon dioxide.'],
  ['TOI-178', 7.2994, -30.4544, 205, 'Six planets locked in a chain of orbital resonances.'],
  ['PSR B1257+12', 195.0149, 12.6825, 2300, 'The very first exoplanets found (1992), orbiting a dead star: a pulsar.'],
  ['LHS 1140', 11.2471, -15.2714, 48.8, 'A dense super-Earth in the habitable zone of a quiet red dwarf.'],
  ['Teegarden\'s Star', 43.2521, 16.8828, 12.5, 'One of the nearest systems, with two Earth-mass planets in the habitable zone.'],
];
const SYSTEM_NEAR = 300;   // AU: build a system when the camera is this close to its star

// planet look from radius (Earth radii) and equilibrium temperature
function planetLook(R, T) {
  if (R > 6) return T > 1000 ? '#c8643c' : '#d8c09a';            // hot Jupiter / giant
  if (R > 1.7) return T > 900 ? '#b88a6a' : '#7fa6d9';            // sub-Neptune
  if (T > 900) return '#e2662a';                                  // lava world
  if (T > 0 && T < 200) return '#dfe8ef';                         // icy
  return T >= 200 && T <= 320 ? '#6f9a6a' : '#a88f78';            // temperate-ish / rocky
}
// star colour from Teff (rough blackbody)
function starColour(T = 5772) {
  const t = Math.max(2400, Math.min(12000, T)) / 100;
  const r = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332), g = t <= 66 ? 99.47 * Math.log(t) - 161.1 : 288.1 * Math.pow(t - 60, -0.0755), b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5 * Math.log(t - 10) - 305.0;
  return new THREE.Color(Math.min(255, r) / 255, Math.min(255, Math.max(0, g)) / 255, Math.min(255, Math.max(0, b)) / 255);
}
const hash = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };

export function createExoplanets({ scene, camera, renderer }) {
  const X = { data: null, loading: null, systems: [], hostPos: null, built: null };
  const uniforms = { uPR: { value: renderer.getPixelRatio() }, uFade: { value: 0 } };
  let markers = null;

  // ---- labelled famous systems (positions from RA/Dec until the catalogue is in)
  for (const [host, ra, dec, ly, fact] of FAMOUS) {
    addBody({ key: 'exo:' + host, name: host === 'Proxima Cen' ? 'Proxima Centauri' : host, kind: 'exoplanet system', color: '#6fe0ff', radius: R_SUN * 0.5,
      pos: radecToEcl(ra, dec, new THREE.Vector3()).multiplyScalar(ly * LY_AU), fixed: true, exo: true, layer: 'exo', fact, host,
      info: () => systemInfo(host, ly) });
  }
  function systemInfo(host, lyFallback) {
    const s = X.systems.find(x => x.host === host);
    if (!s) return [['Distance', lyFallback + ' light-years'], ['Planets', 'loading…']];
    const hz = s.hz ? `${s.hz[0].toFixed(3)}–${s.hz[1].toFixed(3)} AU` : '—';
    return [['Distance', s.ly.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' light-years'], ['Star', s.teff ? Math.round(s.teff) + ' K, ' + (s.rs ? s.rs.toFixed(2) + ' × the Sun\'s radius' : '') : '—'],
      ['Planets', String(s.pl.length) + (s.pl.some(p => p[11]) ? ` (${s.pl.filter(p => p[11]).length} in the habitable zone)` : '')], ['Habitable zone', hz],
      ['Light left it', Math.round(s.ly) + ' years ago']];
  }

  function load() {
    return X.loading || (X.loading = (async () => {
      const d = await fetchAsset('data/solar/exoplanets.json', 'json');
      X.data = d; X.systems = d.list;
      const N = X.systems.length, pos = new Float32Array(N * 3), hz = new Float32Array(N);
      X.systems.forEach((s, k) => { pos.set([s.p[0] * LY_AU, s.p[1] * LY_AU, s.p[2] * LY_AU], k * 3); hz[k] = s.pl.some(p => p[11]) ? 1 : 0; });
      X.hostPos = pos;
      for (const [host] of FAMOUS) { const s = X.systems.find(x => x.host === host), b = byKey['exo:' + host]; if (s && b) b.pos.set(s.p[0] * LY_AU, s.p[1] * LY_AU, s.p[2] * LY_AU); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('hz', new THREE.BufferAttribute(hz, 1));
      markers = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: LOGDEPTH_V + `attribute float hz; uniform float uPR; varying float vHz;
          void main() { vHz = hz; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = (hz > 0.5 ? 9.0 : 6.5) * uPR; gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          }`,
        fragmentShader: LOGDEPTH_F + `uniform float uFade; varying float vHz;
          void main() {
            #include <logdepthbuf_fragment>
            float r = length(gl_PointCoord - 0.5), ring = smoothstep(0.5, 0.42, r) * smoothstep(0.26, 0.34, r);   // a ring, not a star
            vec3 c = vHz > 0.5 ? vec3(0.49, 1.0, 0.65) : vec3(0.44, 0.88, 1.0); float a = ring * uFade * (vHz > 0.5 ? 0.95 : 0.6); if (a < 0.01) discard;
            gl_FragColor = vec4(c * a, a);
          }` }));
      markers.frustumCulled = false; markers.visible = layerOn('exo'); scene.add(markers);
      onChange();
    })().catch(e => { X.loading = null; throw e; }));
  }
  let onChange = () => {};

  // ---- the system you are in
  const lightView = new THREE.Vector3();
  function build(s) {
    const group = new THREE.Group(), hostPos = new THREE.Vector3(s.p[0] * LY_AU, s.p[1] * LY_AU, s.p[2] * LY_AU); group.position.copy(hostPos); scene.add(group);
    const rs = (s.rs || 0.5) * R_SUN, col = starColour(s.teff);
    const star = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.4) })); star.scale.setScalar(rs); group.add(star);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: STAR_TEXTURE, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); glow.scale.setScalar(rs * 16); group.add(glow);
    // the sky plane at the star: z toward us, x along the ecliptic-north cross product; orbits tilted by i about x
    const toUs = hostPos.clone().negate().normalize(), xAx = new THREE.Vector3().crossVectors(toUs, new THREE.Vector3(0, 0, 1)).normalize(), yAx = new THREE.Vector3().crossVectors(toUs, xAx);
    const bodies = [], objs = [];
    if (s.hz) {   // habitable zone: a soft green annulus in the plane of the first planet's orbit
      const i0 = (s.pl[0]?.[4] ?? 90) * DEG, n = toUs.clone().multiplyScalar(Math.cos(i0)).addScaledVector(yAx, -Math.sin(i0)).normalize();
      const ring = new THREE.Mesh(new THREE.RingGeometry(s.hz[0], s.hz[1], 128, 1), new THREE.MeshBasicMaterial({ color: 0x7dffa6, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n); group.add(ring); objs.push(ring);
    }
    for (const p of s.pl) {
      const [suffix, a, P, e, iDeg, Re, Me, Teq, tJD, year, method, inHz] = p;
      const R = (Re || (Me ? Math.pow(Me, 0.28) : 1.5)) * R_EARTH, i = (iDeg || 90) * DEG;
      const Y = yAx.clone().multiplyScalar(Math.cos(i)).addScaledVector(toUs, Math.sin(i));   // orbit basis: X = xAx, Y
      const pts = new Float32Array(257 * 3);
      for (let k = 0; k <= 256; k++) { const t = k / 256 * 2 * Math.PI, v = xAx.clone().multiplyScalar(Math.cos(t) * a).addScaledVector(Y, Math.sin(t) * a); pts.set([v.x, v.y, v.z], k * 3); }
      const og = new THREE.BufferGeometry(); og.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const orbit = new THREE.Line(og, new THREE.LineBasicMaterial({ color: inHz ? 0x7dffa6 : 0x6fe0ff, transparent: true, opacity: 0.45, depthWrite: false })); group.add(orbit); objs.push(orbit);
      const look = planetLook(Re || R / R_EARTH, Teq), tex = new THREE.DataTexture(new Uint8Array([...new THREE.Color(look).toArray().map(c => Math.round(Math.pow(c, 1 / 2.2) * 255)), 255]), 1, 1);
      tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
      const mat = globeMaterial(lightView, { atm: Re > 1.7 ? [0.6, 0.8, 1] : [0, 0, 0], atmK: Re > 1.7 ? 0.4 : 0, wrap: Re > 6 ? 0.05 : 0 }); mat.uniforms.map.value = tex;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat); mesh.scale.setScalar(R);
      const holder = new THREE.Group(); holder.add(mesh); scene.add(holder); objs.push(holder);
      const real = tJD > 0 && P > 0, phase0 = real ? 0 : hash(s.host + suffix) * 2 * Math.PI;
      const name = s.host + ' ' + suffix, key = 'exop:' + name;
      const local = new THREE.Vector3();
      const b = addBody({ key, name, kind: inHz ? 'exoplanet · habitable zone' : 'exoplanet', color: inHz ? '#7dffa6' : '#9fe8ff', radius: R, pos: new THREE.Vector3(), group: holder, mesh, transient: true, exoPlanet: true, sys: s.host,
        fact: inHz ? 'It orbits in its star\'s habitable zone, where liquid water could exist on the surface, given the right atmosphere.' : '',
        update(jd) {
          const th = (real ? Math.PI / 2 + 2 * Math.PI * (jd - tJD) / P : phase0 + (P ? 2 * Math.PI * (jd - 2451545) / P : 0));
          local.copy(xAx).multiplyScalar(Math.cos(th) * a).addScaledVector(Y, Math.sin(th) * a); b.pos.copy(hostPos).add(local); holder.position.copy(b.pos);
        },
        info: () => [['Radius', Re ? Re.toFixed(2) + ' × Earth' : '—'], ['Mass', Me ? (Me >= 318 ? (Me / 317.8).toFixed(2) + ' × Jupiter' : Me.toFixed(1) + ' × Earth') : '—'],
          ['Orbit', `${a < 0.1 ? a.toFixed(4) : a.toFixed(3)} AU · ${P ? (P < 2 ? (P * 24).toFixed(1) + ' hours' : P < 1000 ? P.toFixed(1) + ' days' : (P / 365.25).toFixed(1) + ' years') : '—'}`],
          ['Temperature', Teq ? `${Math.round(Teq - 273)} °C (equilibrium)` : '—'], ['Found', `${year || '—'} · ${{ T: 'transit', RV: 'radial velocity', M: 'microlensing', I: 'direct imaging', TTV: 'transit timing' }[method] || method}`],
          ['Position', real ? 'from its measured transit time' : 'phase unknown (illustrative)']] });
      bodies.push(b);
    }
    return { s, group, objs, bodies, hostPos, outer: Math.max(...s.pl.map(p => p[1])) };
  }
  function unbuild(B) {
    scene.remove(B.group); for (const o of B.objs) { o.parent?.remove(o); o.traverse(x => { x.geometry?.dispose(); x.material?.dispose(); }); }
    B.group.traverse(x => { x.geometry?.dispose(); x.material?.dispose(); });
    for (const b of B.bodies) removeBody(b);
  }

  let lastScan = 0;
  return {
    X, load, set onChange(fn) { onChange = fn; },
    /** Hosts matching the text (for the search box): [{ host, ly, n }] */
    search(q, limit = 8) {
      if (!X.data) { load().catch(() => {}); return []; }
      const out = []; for (const s of X.systems) if (s.host.toLowerCase().includes(q)) { out.push(s); if (out.length >= limit) break; } return out;
    },
    /** A focusable body for a host (the famous ones exist; others become a transient body). */
    hostBody(s) {
      const key = 'exo:' + s.host; if (byKey[key]) return byKey[key];
      for (const old of Object.keys(byKey).filter(k => k.startsWith('exo:') && byKey[k].transientHost)) removeBody(byKey[old]);
      return addBody({ key, name: s.host, kind: 'exoplanet system', color: '#6fe0ff', radius: (s.rs || 0.5) * R_SUN, pos: new THREE.Vector3(s.p[0] * LY_AU, s.p[1] * LY_AU, s.p[2] * LY_AU), fixed: true, exo: true, layer: 'exo', host: s.host, transientHost: true, info: () => systemInfo(s.host, s.ly) });
    },
    viewDistance: s => Math.max(...s.pl.map(p => p[1])) * 3.2,
    update(jd) { if (X.built) for (const b of X.built.bodies) b.update(jd); },
    frame({ camSun, fade, jd }) {
      uniforms.uPR.value = renderer.getPixelRatio();
      if (camSun > 0.2 * LY_AU && !X.loading) load().catch(e => console.warn('exoplanets', e));   // once out among the stars
      uniforms.uFade.value = layerOn('exo') ? fade(0.3, 3, camSun, 'ly') * (1 - fade(3e4, 1.5e5, camSun, 'ly')) : 0;
      if (markers) markers.visible = uniforms.uFade.value > 0.002;
      // build the system the camera is in (checked twice a second)
      const now = performance.now();
      if (X.hostPos && now - lastScan > 500) {
        lastScan = now; const c = camera.position, P = X.hostPos; let best = -1, bd = Infinity;
        for (let k = 0; k < X.systems.length; k++) { const dx = P[3 * k] - c.x, dy = P[3 * k + 1] - c.y, dz = P[3 * k + 2] - c.z, d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = k; } }
        const want = best >= 0 && Math.sqrt(bd) < SYSTEM_NEAR && layerOn('exo') ? X.systems[best] : null;
        if (X.built && X.built.s !== want) { unbuild(X.built); X.built = null; }
        if (want && !X.built) { X.built = build(want); if (jd != null) for (const b of X.built.bodies) b.update(jd); }
      }
      if (X.built) lightView.copy(X.built.hostPos).applyMatrix4(camera.matrixWorldInverse);
    },
  };
}
