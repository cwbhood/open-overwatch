/* Follow camera for satellites and aircraft, and the glTF conventions both kinds of model share.
   Runs before every frame (scene.preUpdate): re-centres the camera on the object's exact position for this frame and
   keeps the user's orbit offset, so you can drag around it and zoom while it moves. (Cesium's trackedEntity lags one
   tick behind its target, ~115 m at orbital speed.) The start glides in from wherever the camera is. */
import { C, $, toast } from './env.js';
import { viewer, camera, ctrl } from './viewer.js';
import { state, hooks } from './state.js';

// Blender exports Y-up glTF and Cesium turns it back to Z-up, so Blender axes == model axes (+X nose/ram, +Z up/zenith);
// MODEL_FIX undoes Cesium's glTF forward-axis turn (+90 deg about Z), measured with brand/models/test/axes.glb.
export const MODEL_FIX = C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_Z, -Math.PI / 2);
export const SOLAR_AXIS = new C.Cartesian3(0, 0, -1);   // Blender +Y expressed in glTF node space (node transforms apply there)

/** Stop following and leave any Moon lookAt, before a new camera move. */
export function release() {
  if (Follow.obj) Follow.stop();
  if (state.lookingAtMoon) { camera.lookAtTransform(C.Matrix4.IDENTITY); state.lookingAtMoon = false; }
}

export const Follow = {
  obj: null, getPos: null, ent: null, minPx: 34, glide: null, _T: new C.Matrix4(),
  start(obj, getPos, r, ent, minPx) {
    release();
    const p = getPos(viewer.clock.currentTime); if (!p) return;
    const T = C.Transforms.eastNorthUpToFixedFrame(p), inv = C.Matrix4.inverseTransformation(T, new C.Matrix4());
    const from = C.Matrix4.multiplyByPoint(inv, camera.positionWC, new C.Cartesian3());
    this.glide = { from, to: new C.Cartesian3(-r, -r, r * 0.55), t0: performance.now(), dur: 2200 };
    Object.assign(this, { obj, getPos, ent, minPx });
    if (ent.model) ent.model.minimumPixelSize = 0;   // true size while you're next to it (markers have no model)
    ctrl.minimumZoomDistance = 2;
    hooks.clearPresets();
    toast(`Following ${obj.name || obj.flight || obj.hex} · drag to orbit it, scroll to zoom, Esc to stop`, 4200);
    if (state.selected === obj) hooks.reselect(obj);
  },
  stop() {
    const o = this.obj; if (!o) return;
    if (this.ent && this.ent.model) this.ent.model.minimumPixelSize = this.minPx;
    this.obj = this.getPos = this.ent = this.glide = null;
    camera.lookAtTransform(C.Matrix4.IDENTITY); ctrl.minimumZoomDistance = 150;
    if (state.selected === o) hooks.reselect(o);
  },
  track(time) {
    if (!this.obj) return;
    const p = this.getPos(time); if (!p) return;
    const T = C.Transforms.eastNorthUpToFixedFrame(p, C.Ellipsoid.WGS84, this._T);
    let offset;
    if (this.glide) {
      const g = this.glide, k = Math.min(1, (performance.now() - g.t0) / g.dur), e = 1 - Math.pow(1 - k, 3);
      const d0 = Math.max(1, C.Cartesian3.magnitude(g.from)), d1 = C.Cartesian3.magnitude(g.to), d = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * e);
      const dir = C.Cartesian3.normalize(C.Cartesian3.lerp(C.Cartesian3.normalize(g.from, new C.Cartesian3()), C.Cartesian3.normalize(g.to, new C.Cartesian3()), e, new C.Cartesian3()), new C.Cartesian3());
      offset = C.Cartesian3.multiplyByScalar(dir, d, new C.Cartesian3());
      if (k >= 1) this.glide = null;
    } else offset = C.Cartesian3.clone(camera.position);   // camera.position is in the object's frame while following
    camera.lookAtTransform(T, offset);
  },
};
