// The Solar System as the far half of one continuous zoom: globe.html loads this page in an iframe (?embed=1) and hands
// the camera over past the Moon; zooming back into Earth hands it back. Cameras cross as Earth-centred vectors in the
// ecliptic frame (metres) plus the vertical field of view, so both renderers show the same picture at the switch.
import * as THREE from 'three';
import { AU_KM } from '../core/units.js';
import { byKey } from './world.js';

export const EMBED = new URLSearchParams(location.search).has('embed');
const AU_M = AU_KM * 1000;
export const EXIT_M = 2.2e8;   // zooming into Earth below this hands back to the globe (the globe hands over at 3.0e8: hysteresis)

const Z = new THREE.Vector3(0, 0, 1), v = new THREE.Vector3();

/**
 * camera/controls/nav/clock: the view's objects. loop: { pause(), resume() } for the render loop.
 * Returns { api (exposed as OOSS.embed), frame(view) -> true while a hand-over animation owns the camera }.
 */
export function createEmbed({ camera, controls, nav, clock, loop, update }) {
  let anim = null, active = false;
  const parentSpace = () => { try { return window.parent !== window && window.parent.OO3D && window.parent.OO3D.space; } catch (e) { return null; } };

  const api = {
    ready: false,
    get active() { return active; },
    /** From the globe: { offset, dir, up } (ecliptic, metres from Earth's centre), fovy (radians). */
    enterFromGlobe(s) {
      if (s.live) clock.goLive(); else { clock.setJd(s.jd); clock.setRate(s.rate); }
      update(clock.jd);
      const earth = byKey.earth, off = new THREE.Vector3(s.offset.x, s.offset.y, s.offset.z).divideScalar(AU_M);
      nav.focus = earth; nav.fly = null; nav.free = false;
      camera.fov = THREE.MathUtils.radToDeg(s.fovy); camera.updateProjectionMatrix();
      camera.position.copy(earth.pos).add(off);
      camera.up.set(s.up.x, s.up.y, s.up.z).normalize();
      const aim = camera.position.clone().addScaledVector(new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z).normalize(), off.length());
      controls.target.copy(aim); camera.lookAt(aim); controls.minDistance = earth.radius * 1.15;
      // then, over 1.6 s: aim at Earth's centre and roll "up" to the ecliptic north, the frame the solar view orbits in
      anim = { t0: performance.now(), dur: 1600, up0: camera.up.clone(), aim0: aim };
      controls.enabled = false; active = true; loop.resume();
    },
    pause() { active = false; loop.pause(); },
    /** Fly down to Earth; crossing EXIT_M hands back to the globe (the "3D globe" link, the Earth card). */
    goToEarth() { nav.focusOn(byKey.earth, EXIT_M * 0.8 / AU_M, 2.5, false); },
  };

  function frame() {
    if (anim) {
      const k = Math.min(1, (performance.now() - anim.t0) / anim.dur), e = k * k * (3 - 2 * k);
      controls.target.lerpVectors(anim.aim0, byKey.earth.pos, e);
      camera.up.copy(anim.up0).lerp(Z, e).normalize();
      if (k >= 1) { camera.up.copy(Z); anim = null; controls.enabled = true; }
      return true;
    }
    const space = parentSpace();
    // hand Earth back to the globe: measured to Earth itself, and not mid-flight (a flight's target is still moving)
    if (active && space && !nav.fly && nav.focus === byKey.earth && camera.position.distanceTo(byKey.earth.pos) * AU_M < EXIT_M) {
      const earth = byKey.earth.pos;
      active = false;
      space.leave({
        offset: v.copy(camera.position).sub(earth).multiplyScalar(AU_M).clone(),
        dir: camera.getWorldDirection(new THREE.Vector3()),
        up: new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
        live: clock.live, jd: clock.jd, rate: clock.rate,
      });
    }
    return false;
  }
  return { api, frame };
}
