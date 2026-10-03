// Beyond the planets: the heliopause, the Oort cloud, 109,400 HYG stars in 3D, the Milky Way and the Local Group.
import * as THREE from 'three';
import { LY_AU, PC_AU, radecToEcl, GALACTIC, SUN_TO_GALACTIC_CENTRE_LY } from '../core/units.js';
import { fetchAsset } from '../core/assets.js';
import { bigNumber } from '../core/format.js';
import { LOGDEPTH_V, LOGDEPTH_F, PHONE, STAR_TEXTURE, surfaceMaterial, loadTexture, planetTexture, sharpTexture, Sharpen, toVector3 } from './util.js';
import { addBody, bodies, ORIGIN, layer, layerOn, onLayers } from './world.js';

export function createDeepSpace({ scene, camera, renderer }) {
  // ---- heliopause: where the solar wind meets interstellar space (~120 AU; squashed, it isn't really a sphere)
  const helio = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), surfaceMaterial({
    uniforms: { k: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    frag: { decl: 'uniform float k;', body: 'col = vec3(0.35, 0.55, 1.0) * pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 7.0) * k;' },
  }));
  helio.scale.set(121, 121, 105); scene.add(helio);

  // ---- Oort cloud: illustrative only (never observed directly), 2,000-100,000 AU, flatter inner part
  const oort = (() => {
    const N = PHONE ? 15000 : 40000, pos = new Float32Array(N * 3);
    for (let k = 0; k < N; k++) {
      const r = 2000 * Math.pow(50, Math.pow(Math.random(), 0.7)), u = Math.random() * 2 - 1, t = Math.random() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(t), r * s * Math.sin(t), r * u * (r < 20000 ? 0.35 : 1)], k * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fb8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    p.frustumCulled = false; scene.add(p); return p;
  })();

  // ---- HYG stars: brightness and size from the apparent magnitude as seen from wherever the camera is
  const starUniforms = { uFade: { value: 0 }, uPR: { value: renderer.getPixelRatio() }, uBubble: { value: 0 }, uBubbleOn: { value: 1 } };
  let starPoints = null;
  let starsAsked = false, onStars = () => {};
  const needStars = () => { if (starsAsked) return; starsAsked = true; loadStars().then(() => onStars(), e => console.warn('stars', e)); };
  async function loadStars() {
    const meta = await fetchAsset('data/solar/stars.json', 'json'), buf = await fetchAsset('data/solar/stars.bin');
    const N = buf.byteLength / 20, F = new Float32Array(buf), pos = new Float32Array(N * 3);
    for (let k = 0; k < N; k++) { pos[k * 3] = F[k] * LY_AU; pos[k * 3 + 1] = F[N + k] * LY_AU; pos[k * 3 + 2] = F[2 * N + k] * LY_AU; }
    const g = new THREE.BufferGeometry(), absmag = F.subarray(3 * N, 4 * N);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('absmag', new THREE.BufferAttribute(absmag, 1));
    g.setAttribute('ci', new THREE.BufferAttribute(F.subarray(4 * N, 5 * N), 1));
    starPoints = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: starUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: LOGDEPTH_V + `attribute float absmag; attribute float ci; uniform float uPR; uniform float uBubble; uniform float uBubbleOn; varying vec3 vC; varying float vA;
        vec3 bv(float c) { c = clamp(c, -0.4, 2.0); return c < 0.4 ? mix(vec3(0.62, 0.72, 1.0), vec3(1.0, 0.98, 0.95), (c + 0.4) / 0.8) : mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.62, 0.35), (c - 0.4) / 1.6); }
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); float dpc = max(length(mv.xyz) / ${PC_AU.toFixed(3)}, 1e-6);
          float m = absmag + 5.0 * (log(dpc) / 2.302585 - 1.0), f = pow(10.0, -0.4 * (m - 6.5));   // apparent magnitude; f = 1 at mag 6.5
          gl_PointSize = clamp(1.6 + 2.2 * log(1.0 + f), 1.0, 14.0) * uPR; vA = clamp(f * 1.5, 0.0, 1.0); vC = bv(ci); gl_Position = projectionMatrix * mv;
          if (length(position) < uBubble) { vC = mix(vC, vec3(0.49, 1.0, 0.65), 0.6 * uBubbleOn); vA = max(vA, 0.35 * uBubbleOn); }   // reached by our radio
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: LOGDEPTH_F + `uniform float uFade; varying vec3 vC; varying float vA;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(vC * smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * vA * uFade, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    starPoints.frustumCulled = false; starPoints.visible = layerOn('stars'); scene.add(starPoints);
    for (const [idx, name, ly, spectral] of meta.named || []) {
      const p = new THREE.Vector3(pos[idx * 3], pos[idx * 3 + 1], pos[idx * 3 + 2]);
      addBody({ key: 'star:' + name, name, kind: 'star', color: '#fff3d6', radius: 0, pos: p, fixed: true, star: true, ly, absmag: absmag[idx], layer: 'stars',
        info: () => [['Distance', ly.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' light-years'], ['= AU', bigNumber(ly * LY_AU) + ' AU'], ['Spectral type', spectral || '—'], ['Light left it', lightLeft(ly)], ['Our radio', radioReach(ly)]] });
    }
    layer('stars').n = N;
  }
  // ---- humanity's radio bubble: broadcasts since 1920 (KDKA) have travelled outward at the speed of light
  const RADIO_YEAR = 1920;
  const yearOf = jd => 2000 + (jd - 2451545.0) / 365.25;
  let simYear = new Date().getUTCFullYear();
  const radioReach = ly => { const y = Math.round(RADIO_YEAR + ly); return y <= simYear ? `reached it around ${y}` : `reaches it around ${y}`; };
  const bubble = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), surfaceMaterial({
    uniforms: { k: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    frag: { decl: 'uniform float k;', body: 'float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 4.0); col = vec3(0.49, 1.0, 0.65) * (0.006 + 0.8 * f) * k; alpha = 1.0;' },
  }));
  bubble.visible = false; scene.add(bubble);
  const bubbleBody = addBody({ key: 'radio', name: 'Our radio bubble', kind: 'radio bubble', color: '#7dffa6', radius: 0, pos: new THREE.Vector3(), fixed: true, bubble: true, layer: 'radio',
    fact: 'Everything we have broadcast since the first radio stations of the 1920s is still travelling outward at the speed of light. Stars inside this sphere (tinted green) could have received it by now; the rest of the galaxy has no idea we are here.',
    info: () => { const r = simYear - RADIO_YEAR; return [['Radius', `${Math.round(r)} light-years`], ['Started', `${RADIO_YEAR} (first commercial radio broadcasts)`], ['Share of the Milky Way', `${(r * 2 / 100000 * 100).toFixed(2)}% of its width`]]; } });
  const lightLeft = ly => {
    if (ly < 1.5) return Math.round(ly * 365.25) + ' days ago';
    const year = new Date().getUTCFullYear() - Math.round(ly);
    return year > 0 ? 'around ' + year + ' AD' : 'about ' + Math.round(ly).toLocaleString('en-US') + ' years ago';
  };

  // ---- the Milky Way: NASA/JPL-Caltech (R. Hurt) top-down artwork on the galactic plane, centre 26,000 ly away
  const GC = toVector3(GALACTIC.x).multiplyScalar(SUN_TO_GALACTIC_CENTRE_LY * LY_AU);
  // the Milky Way artwork (also the Local Group spirals) loads once you head out past ~300 light-years
  let milkyTex = null, milkyUsers = [];
  const milkyNeeded = () => milkyTex || (milkyTex = loadTexture(planetTexture('milkyway')).then(t => { if (t) for (const m of milkyUsers) if (!m.map) { m.map = t; m.needsUpdate = true; } return t; }));
  const milky = new THREE.Mesh(new THREE.PlaneGeometry(115000 * LY_AU, 115000 * LY_AU), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  // image: centre = galactic centre, the Sun straight below it, longitude 90 deg to the left (seen from the north galactic pole)
  milky.position.copy(GC); milky.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(toVector3(GALACTIC.y).negate(), toVector3(GALACTIC.x), toVector3(GALACTIC.z)));
  scene.add(milky);
  addBody({ key: 'here', name: 'You are here · the Sun', kind: 'star', color: '#7dffa6', radius: 0, pos: ORIGIN, fixed: true, big: true, here: true,
    info: () => [['Distance to galactic centre', '26,000 light-years'], ['Speed round the galaxy', 'about 230 km/s']] });
  addBody({ key: 'gc', name: 'Galactic centre', kind: 'galaxy core', color: '#ffe0a8', radius: 0, pos: GC, fixed: true, far: true, layer: 'galaxy',
    info: () => [['Distance', '26,000 light-years'], ['What', 'Sagittarius A*, a black hole of 4 million Suns'], ['Our orbit', 'about 230 million years per lap']] });

  // ---- the Local Group (the spirals reuse the Milky Way artwork; the Magellanic Clouds are soft glows)
  const galaxies = [];
  function addGalaxy(key, name, ra, dec, dMly, diaKly, incl, pa, spiral, fact, tint) {
    const los = radecToEcl(ra, dec, new THREE.Vector3()), p = los.clone().multiplyScalar(dMly * 1e6 * LY_AU);
    const ncp = radecToEcl(0, 90, new THREE.Vector3()), n = ncp.clone().addScaledVector(los, -ncp.dot(los)).normalize(), e = new THREE.Vector3().crossVectors(n, los).normalize();
    const major = n.clone().multiplyScalar(Math.cos(pa * Math.PI / 180)).addScaledVector(e, Math.sin(pa * Math.PI / 180));     // position angle from north through east
    const axis = new THREE.Vector3().crossVectors(major, los).normalize(), normal = los.clone().multiplyScalar(Math.cos(incl * Math.PI / 180)).addScaledVector(axis, Math.sin(incl * Math.PI / 180)).normalize();
    const size = diaKly * 1000 * LY_AU, mat = new THREE.MeshBasicMaterial({ map: spiral ? null : STAR_TEXTURE, color: tint, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size * (spiral ? 1 : 0.7)), mat);
    mesh.position.copy(p); mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(major, new THREE.Vector3().crossVectors(normal, major).normalize(), normal));
    scene.add(mesh); galaxies.push(mesh); if (spiral) milkyUsers.push(mat);
    addBody({ key, name, kind: 'galaxy', color: '#cdd8ff', radius: 0, pos: p, fixed: true, far: true, fact, layer: 'galaxy',
      info: () => [['Distance', dMly < 1 ? Math.round(dMly * 1e3) + ',000 light-years' : dMly.toFixed(2) + ' million light-years'], ['Size', Math.round(diaKly) + ',000 light-years across'],
        ['Light left it', dMly < 1 ? Math.round(dMly * 1e3) + ',000 years ago' : dMly.toFixed(1) + ' million years ago']] });
  }
  milkyUsers.push(milky.material);
  Sharpen.add(() => camera.position.length() > 5000 * LY_AU, sharpTexture('milkyway'), t => {   // the 4k artwork once out among it
    const old = milky.material.map;
    for (const m of [milky.material, ...galaxies.filter(g => g.material.map === old).map(g => g.material)]) { m.map = t; m.needsUpdate = true; }
    old?.dispose();
  });
  addGalaxy('m31', 'Andromeda Galaxy', 10.6847, 41.2690, 2.537, 152, 77, 38, true, 'Our big neighbour, about a trillion stars. It is heading our way and will merge with the Milky Way in roughly 4.5 billion years.', 0xd9e2ff);
  addGalaxy('m33', 'Triangulum Galaxy', 23.4621, 30.6599, 2.73, 61, 54, 23, true, 'Third-largest member of the Local Group, around 40 billion stars.', 0xc9e6ff);
  addGalaxy('lmc', 'Large Magellanic Cloud', 80.894, -69.756, 0.163, 32, 35, 170, false, 'A satellite galaxy of the Milky Way, visible to the naked eye from the southern hemisphere.', 0xbfd3ff);
  addGalaxy('smc', 'Small Magellanic Cloud', 13.187, -72.829, 0.203, 19, 60, 45, false, 'A dwarf galaxy orbiting the Milky Way, about 7,000 light-years across.', 0xc8d6ff);

  onLayers(() => { if (starPoints) starPoints.visible = layerOn('stars'); milky.visible = layerOn('galaxy'); for (const g of galaxies) g.visible = layerOn('galaxy'); });

  return {
    GC, needStars, set onStars(fn) { onStars = fn; },
    /** Which named stars get a label: the brightest ~28 as seen from the camera (+ the very nearest when close in). */
    rankStars(camSun) {
      const list = bodies.filter(b => b.star); if (!list.length) return;
      for (const b of list) { b.m = b.absmag + 5 * (Math.log10(Math.max(camera.position.distanceTo(b.pos) / PC_AU, 1e-6)) - 1); b.vis = false; }
      list.sort((a, b) => a.m - b.m).slice(0, PHONE ? 16 : 28).forEach(b => { b.vis = true; });
      if (camSun < 80 * LY_AU) list.filter(b => b.ly < 12).forEach(b => { b.vis = true; });
    },
    frame({ camSun, fade, jd }) {
      if (camSun > 300 * LY_AU) milkyNeeded();
      if (camSun > 400) needStars();   // 2.2 MB: once past the planets (or on a search, or idle on desktops)
      starUniforms.uPR.value = renderer.getPixelRatio();
      if (jd != null) simYear = yearOf(jd);
      const rLy = Math.max(0, simYear - RADIO_YEAR), rAU = rLy * LY_AU, radioOn = layerOn('radio');
      starUniforms.uBubble.value = rAU; starUniforms.uBubbleOn.value = radioOn ? fade(8, 40, camSun, 'ly') : 0;
      bubble.scale.setScalar(Math.max(rAU, 1)); bubbleBody.pos.set(0, 0, rAU);
      const outside = THREE.MathUtils.smoothstep(camera.position.length(), rAU * 1.05, rAU * 1.6);   // only seen from outside it
      bubble.material.uniforms.k.value = radioOn ? 0.38 * outside * (1 - fade(3000, 2e4, camSun, 'ly')) : 0;
      bubble.visible = bubble.material.uniforms.k.value > 0.002;
      starUniforms.uFade.value = fade(0.02, 0.4, camSun, 'ly') * (1 - fade(2e4, 8e4, camSun, 'ly'));
      if (starPoints) starPoints.visible = layerOn('stars') && starUniforms.uFade.value > 0.002;
      oort.material.opacity = 0.55 * fade(1500, 2e4, camSun) * (1 - fade(3, 30, camSun, 'ly')); oort.visible = oort.material.opacity > 0.002;
      helio.material.uniforms.k.value = 0.22 * fade(40, 250, camSun) * (1 - fade(3000, 3e4, camSun));
      milky.material.opacity = 0.95 * fade(1500, 3e4, camSun, 'ly');
      for (const g of galaxies) g.material.opacity = fade(1e5, 6e5, camSun, 'ly');
    },
  };
}
