// The cosmic web: 43,480 galaxies of the 2MASS Redshift Survey in 3D (data/solar/galaxies.bin, brand/tools/
// make_galaxies.py), out to ~700 Mpc, plus labels for the big clusters. Distances come from redshift (Hubble law), so
// clusters are stretched along our line of sight ("fingers of God"), and the band behind the Milky Way's dust is empty.
import * as THREE from 'three';
import { PC_AU, LY_AU, eqToEcl, radecToEcl } from '../core/units.js';
import { fetchAsset } from '../core/assets.js';
import { LOGDEPTH_V, LOGDEPTH_F, PHONE } from './util.js';
import { addBody, layerOn, onLayers } from './world.js';

const MPC_AU = 1e6 * PC_AU, MLY = 1e6 * LY_AU;
// name, RA, Dec (deg), rough redshift distance (Mpc), fact. The label goes on the catalogue galaxies actually found
// around that spot (median position), so it sits on the overdensity the viewer sees.
const CLUSTERS = [
  ['Virgo Cluster', 187.70, 12.39, 18, 'The nearest big cluster: over a thousand galaxies, about 54 million light-years away, at the heart of our Local Supercluster.'],
  ['Fornax Cluster', 54.62, -35.45, 19, 'The second-nearest rich cluster, in the southern sky.'],
  ['Centaurus Cluster', 192.20, -41.31, 52, 'A rich cluster in the Hydra–Centaurus supercluster.'],
  ['Hydra Cluster', 159.18, -27.53, 56, 'Abell 1060, one of the nearest rich clusters, in the Hydra–Centaurus supercluster.'],
  ['Norma Cluster · Great Attractor', 243.59, -60.91, 70, 'A huge concentration of mass pulling the Milky Way and thousands of other galaxies, partly hidden behind our galaxy\'s dust. It lies near the centre of Laniakea, our home supercluster.'],
  ['Perseus Cluster', 49.95, 41.51, 73, 'Part of the Perseus–Pisces chain; its hot gas makes it one of the brightest X-ray sources in the sky.'],
  ['Coma Cluster', 194.95, 27.98, 102, 'Over a thousand galaxies. Fritz Zwicky\'s 1933 study of it gave the first hint of dark matter.'],
  ['Hercules Supercluster', 241.10, 17.72, 158, 'A chain of clusters about 500 million light-years away.'],
  ['Shapley Supercluster', 202.00, -31.50, 205, 'The largest concentration of galaxies within about a billion light-years.'],
];

export function createCosmicWeb({ scene, renderer }) {
  const uniforms = { uFade: { value: 0 }, uPR: { value: renderer.getPixelRatio() } };
  let points = null;
  const C = { count: 0, labels: [] };

  async function load() {
    const meta = await fetchAsset('data/solar/galaxies.json', 'json'), F = new Float32Array(await fetchAsset('data/solar/galaxies.bin'));
    const N = Math.min(meta.count, F.length / 4, PHONE ? 15000 : Infinity);   // brightest first
    const pos = new Float32Array(N * 3), mag = new Float32Array(N), e = {};
    for (let k = 0; k < N; k++) {
      eqToEcl(F[4 * k], F[4 * k + 1], F[4 * k + 2], e);
      pos[3 * k] = e.x * MPC_AU; pos[3 * k + 1] = e.y * MPC_AU; pos[3 * k + 2] = e.z * MPC_AU; mag[k] = F[4 * k + 3];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('absmag', new THREE.BufferAttribute(mag, 1));
    points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: LOGDEPTH_V + `attribute float absmag; uniform float uPR; varying vec3 vC; varying float vA;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); float dpc = max(length(mv.xyz) / ${PC_AU.toFixed(3)}, 1.0);
          float m = absmag + 5.0 * (log(dpc) / 2.302585 - 1.0), f = pow(10.0, -0.4 * (m - 13.0));   // apparent K magnitude; f = 1 at 13
          gl_PointSize = clamp(1.2 + 1.6 * log(1.0 + f), 1.0, 7.0) * uPR; vA = clamp(0.14 + f, 0.0, 1.0);
          vC = mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.86, 0.66), smoothstep(-23.0, -25.5, absmag));   // giants (cluster ellipticals) warmer
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: LOGDEPTH_F + `uniform float uFade; varying vec3 vC; varying float vA;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)) * vA * uFade; if (a < 0.003) discard;
          gl_FragColor = vec4(vC * a, a);
        }`,
    }));
    points.frustumCulled = false; points.visible = layerOn('galaxy'); scene.add(points);
    C.count = N;

    // cluster labels on the median position of the catalogue galaxies within 5 deg and ±40% of the rough distance
    for (const [name, ra, dec, dMpc, fact] of CLUSTERS) {
      const dir = radecToEcl(ra, dec, new THREE.Vector3()), cos5 = Math.cos(5 * Math.PI / 180), xs = [], ys = [], zs = [];
      for (let k = 0; k < N; k++) {
        const x = pos[3 * k], y = pos[3 * k + 1], z = pos[3 * k + 2], r = Math.hypot(x, y, z), d = r / MPC_AU;
        if (d < dMpc * 0.6 || d > dMpc * 1.4 || (x * dir.x + y * dir.y + z * dir.z) / r < cos5) continue;
        xs.push(x); ys.push(y); zs.push(z);
      }
      const med = a => a.sort((p, q) => p - q)[a.length >> 1];
      const p = xs.length >= 5 ? new THREE.Vector3(med(xs), med(ys), med(zs)) : dir.multiplyScalar(dMpc * MPC_AU);
      const mly = p.length() / MLY;
      C.labels.push(addBody({ key: 'web:' + name, name, kind: 'galaxy cluster', color: '#ffd9a8', radius: 0, pos: p, fixed: true, web: true, layer: 'galaxy', fact,
        info: () => [['Distance', `about ${Math.round(mly / 10) * 10} million light-years`], ['Light left it', `about ${Math.round(mly)} million years ago`],
          ['Galaxies here in this catalogue', String(xs.length)], ['Distance from', 'redshift (Hubble law)']] }));
    }
  }
  onLayers(() => { if (points) points.visible = layerOn('galaxy'); });

  return {
    C, load,
    frame({ camSun, fade }) {
      uniforms.uPR.value = renderer.getPixelRatio();
      uniforms.uFade.value = fade(4e6, 4e7, camSun, 'ly');
      if (points) points.visible = layerOn('galaxy') && uniforms.uFade.value > 0.002;
    },
  };
}
