// Light delay: what you'd actually see from Earth. Light from the focused body takes d/c to reach us, so Earth sees it
// where it was that long ago: a "ghost" there, joined to where it really is now. Jupiter (~43 min): about 34,000 km back
// along its orbit; Io moves ~44,000 km in that time; Neptune (~4 h) about three Neptune-widths.
import * as THREE from 'three';
import { C_AU_DAY, AU_KM } from '../core/units.js';
import { lightTime } from '../core/format.js';
import { surfaceMaterial } from './util.js';
import { addBody, byKey, layerOn } from './world.js';

const MIN_SHOW = 0.15;   // hide the ghost when it is closer than this many radii to the body (the Moon: 1 km)

export function createLightDelay({ scene, nav }) {
  const ghostMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), surfaceMaterial({
    uniforms: {}, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    frag: { decl: '', body: 'float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 2.2); col = vec3(0.49, 1.0, 0.65) * (0.08 + 0.9 * f); alpha = 1.0;' },
  }));
  ghostMesh.visible = false; scene.add(ghostMesh);
  const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: 0x7dffa6, dashSize: 1, gapSize: 1, transparent: true, opacity: 0.7, depthWrite: false }));
  line.frustumCulled = false; line.visible = false; scene.add(line);
  const at = new THREE.Vector3(), state = { body: null, tau: 0, moved: 0 };
  const ghost = addBody({ key: 'ghost', name: 'As seen from Earth', kind: 'light delay', color: '#7dffa6', radius: 0, pos: new THREE.Vector3(), layer: 'lightdelay', launched: false,
    fact: 'Light is fast but not instant. From Earth you see this body where it was when its light left, not where it is now.',
    info: () => state.body ? [['Body', state.body.name], ['Its light left', lightTime(state.tau * C_AU_DAY) + ' ago'],
      ['Moved since then', Math.round(state.moved * AU_KM).toLocaleString('en-US') + ' km'], ['Which is', (state.moved / state.body.radius).toFixed(1) + ' × its own radius']] : [] });

  return {
    frame({ jd }) {
      const f = nav.focus, E = byKey.earth;
      const on = layerOn('lightdelay') && f && f !== E && f !== ghost && f.posAt && E && jd != null;
      if (on) {
        const tau = f.pos.distanceTo(E.pos) / C_AU_DAY;   // days
        f.posAt(jd - tau, at); const moved = at.distanceTo(f.pos);
        if (moved > MIN_SHOW * f.radius) {
          Object.assign(state, { body: f, tau, moved });
          ghostMesh.position.copy(at); ghostMesh.scale.setScalar(f.radius * 1.002); ghostMesh.visible = true;
          const a = lineGeo.attributes.position; a.setXYZ(0, at.x, at.y, at.z); a.setXYZ(1, f.pos.x, f.pos.y, f.pos.z); a.needsUpdate = true;
          line.material.dashSize = line.material.gapSize = f.radius * 0.12; line.computeLineDistances(); line.visible = true;
          ghost.pos.copy(at); ghost.radius = f.radius; ghost.name = `${f.name} as seen from Earth · ${lightTime(tau * C_AU_DAY)} ago`; ghost.launched = true;
          return;
        }
      }
      ghostMesh.visible = line.visible = false; ghost.launched = false; state.body = null;
    },
  };
}
