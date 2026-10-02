// Shader pre-warm. Cesium compiles a glTF model's shaders the first time it is drawn, on the main thread: ~100 ms per
// program under ANGLE/D3D11 and far more on phones and in Firefox, so the first aircraft and satellites coming into view
// froze the flight down to the ground (perf.mjs: 1.3 s stalls on desktop, 1.5 s on a phone). Here one sub-millimetre
// copy of each model type is drawn just in front of the camera for a few frames while the boot screen is up, then
// hidden. Hidden models keep their programs, and the shader cache hands the same programs to the real ones. Cesium
// builds different versions at different heights (fog and atmosphere below ~800 km), so main.js draws them twice.
import { C, NO_ENV_MAP } from './env.js';
import { viewer, camera } from './viewer.js';

const AHEAD_M = 30;   // in front of the camera, inside the near/far range of the closest frustum
const ents = [];

const pos = new C.Cartesian3();
const add = ({ uri, ...opts }) => ents.push(viewer.entities.add({
  position: new C.CallbackProperty(() => C.Cartesian3.add(camera.positionWC, C.Cartesian3.multiplyByScalar(camera.directionWC, AHEAD_M, pos), pos), false),
  model: { uri, scale: 1e-5, minimumPixelSize: 0, environmentMapOptions: NO_ENV_MAP, ...opts },
}));

/** Add one hidden copy of each { uri, ...model options }; resolves once they have all been drawn (see warmAgain). */
export function warmModels(items) { for (const it of items) add(it); return warmAgain(); }

/** The same, one model every `gapMs` while the page is in use: many short compiles instead of one long freeze
 *  (phones, after the globe is showing). */
export async function warmSlowly(items, gapMs = 700) {
  for (const it of items) {
    const n = ents.length; add(it);
    await new Promise(resolve => { let f = 0; const t0 = performance.now(); const off = viewer.scene.postRender.addEventListener(() => {
      if (!(modelOf(ents[n])?.ready && ++f >= 3) && performance.now() - t0 < 15e3) return;
      off(); ents[n].show = false; resolve();
    }); });
    await new Promise(r => setTimeout(r, gapMs));
  }
}

/** Draw every warm copy again for a few frames (at the camera's current height), then hide them. */
export function warmAgain() {
  for (const e of ents) e.show = true;
  return new Promise(resolve => {
    let frames = 0; const t0 = performance.now();
    const off = viewer.scene.postRender.addEventListener(() => {
      const ready = ents.every(e => modelOf(e)?.ready);
      if (!(ready && ++frames >= 3) && performance.now() - t0 < 20e3) return;   // give up waiting after 20 s
      off(); for (const e of ents) e.show = false; resolve(ready);
    });
  });
}

// the Model primitive behind an entity (ModelVisualizer keeps it in a private map; without it we fall back to the timeout)
function modelOf(e) {
  const vis = viewer.dataSourceDisplay.defaultDataSource._visualizers?.find(v => v._modelHash);
  return vis?._modelHash?.[e.id]?.modelPrimitive;
}
