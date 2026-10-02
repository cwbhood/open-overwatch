// Ten deep-space missions from JPL Horizons trajectories (data/solar/spacecraft.json, fixed time steps).
import * as THREE from 'three';
import { AU_KM, KM_AU } from '../core/units.js';
import { fetchAsset } from '../core/assets.js';
import { distance, lightTime } from '../core/format.js';
import { formatUtc } from '../core/time.js';
import { addBody, byKey, layer, layerOn, onLayers } from './world.js';

/** Position at jd from evenly spaced samples; past the last sample the craft coasts in a straight line. null before launch. */
export function samplePosition(c, jd, out) {
  const f = (jd - c.t0_jd) / c.step_days, x = c.xyz, n = c.xyz.length / 3; if (f < 0) return null;
  const k = Math.min(Math.floor(f), n - 2), t = f - k;   // t > 1 extrapolates along the last segment
  return out.set(x[k * 3] + (x[k * 3 + 3] - x[k * 3]) * t, x[k * 3 + 1] + (x[k * 3 + 4] - x[k * 3 + 1]) * t, x[k * 3 + 2] + (x[k * 3 + 5] - x[k * 3 + 2]) * t);
}

export function createSpacecraft({ scene }) {
  const craft = [], tmp = new THREE.Vector3();
  async function load() {
    for (const s of await fetchAsset('data/solar/spacecraft.json', 'json')) {
      if (s.xyz.length < 6) continue;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(s.xyz), 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffb44d, transparent: true, opacity: 0.55, depthWrite: false }));
      line.visible = layerOn('craft'); scene.add(line);
      const group = new THREE.Group(); scene.add(group);
      const c = addBody({ key: 'craft:' + s.name, name: s.name, kind: 'spacecraft', color: '#ffb44d', radius: 0.01 * KM_AU, pos: new THREE.Vector3(), group, line, vel: 0, fact: s.desc, layer: 'craft', small: true,
        update(jd) {
          const p = samplePosition(s, jd, c.pos); c.launched = !!p; group.visible = !!p && layerOn('craft');
          if (p) c.vel = samplePosition(s, jd + 1, tmp).distanceTo(c.pos) * AU_KM / 86400;
          line.geometry.setDrawRange(0, Math.max(0, Math.floor((jd - s.t0_jd) / s.step_days) + 1));   // only the path flown so far
          c.jd = jd;
        },
        info() {
          const dE = c.pos.distanceTo(byKey.earth.pos), events = (s.events || []).filter(e => e[0] <= c.jd).slice(-2).map(e => [formatUtc(e[0]).slice(0, 10), e[1]]);
          return [['Launched', formatUtc(s.launch_jd).slice(0, 10)], ['From the Sun', distance(c.pos.length())], ['From Earth', distance(dE)], ['Signal time', lightTime(dE)], ['Speed (Sun)', c.vel.toFixed(1) + ' km/s'], ...events];
        } });
      craft.push(c);
    }
    layer('craft').n = craft.length;
  }
  onLayers(() => { for (const c of craft) c.line.visible = layerOn('craft'); });
  return { load, craft, frame({ camSun, fade }) { for (const c of craft) c.line.material.opacity = 0.55 * (1 - fade(2000, 3e4, camSun)); } };
}
