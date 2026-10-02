// The Cesium viewer, camera limits, shared primitive collections and the star background.
import { C, $, PHONE, loadImage } from './env.js';

export const viewer = new C.Viewer('globe', {
  baseLayer: false, animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
  shouldAnimate: true,
  skyBox: false,                        // ours loads below; the default one was 0.9 MB downloaded only to be replaced
  msaaSamples: 1,                       // 4x MSAA blanked the globe and sky in testing; FXAA instead
  orderIndependentTranslucency: false,  // OIT ignores custom blending: the premultiplied glint/cloud-shadow shell vanished under it
  contextOptions: { webgl: { powerPreference: 'high-performance' } },
});
viewer.clock.clockStep = C.ClockStep.SYSTEM_CLOCK;
export const scene = viewer.scene, globe = scene.globe, camera = viewer.camera, ctrl = scene.screenSpaceCameraController;
$('#credits').appendChild(viewer.cesiumWidget.creditContainer);
scene.backgroundColor = C.Color.fromCssColorString('#04060a');
scene.postProcessStages.fxaa.enabled = true;
if (!scene.moon) scene.moon = new C.Moon();
if (!scene.sun) scene.sun = new C.Sun();   // Cesium only makes the Sun (and Moon) along with its default sky box, which we skip
scene.moon.show = true; scene.sun.show = true; scene.sun.glowFactor = 1.6;   // a brilliant star from orbit, not a dull disc
ctrl.maximumZoomDistance = 6.0e8;   // past the Moon (~384,000 km)
ctrl.minimumZoomDistance = 150;

// stars: NASA SVS Deep Star Maps 2020 as cube faces in ICRF axes (brand/tools/make_skybox.py; 1024 px faces on phones).
// Cesium.SkyBox reads each face vertically flipped vs the OpenGL convention; make_skybox.py writes them that way.
{
  const dir = PHONE ? 'brand/textures/sky_1k/' : 'brand/textures/sky/';
  const faces = { positiveX: 'px', negativeX: 'nx', positiveY: 'py', negativeY: 'ny', positiveZ: 'pz', negativeZ: 'nz' };
  Promise.all(Object.entries(faces).map(([k, f]) => loadImage(dir + f + '.jpg').then(img => [k, img])))
    .then(list => { scene.skyBox = new C.SkyBox({ sources: Object.fromEntries(list) }); })
    .catch(e => { console.warn('Star map unavailable, using the default sky:', e.message); scene.skyBox = C.SkyBox.createEarthSkyBox(); });
}
viewer.creditDisplay.addStaticCredit(new C.Credit('Stars: NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC'));

export const satPts = scene.primitives.add(new C.PointPrimitiveCollection({ blendOption: C.BlendOption.TRANSLUCENT }));
export const airPts = scene.primitives.add(new C.PointPrimitiveCollection());
export const airIcons = scene.primitives.add(new C.BillboardCollection({ scene }));
export const qkPts = scene.primitives.add(new C.PointPrimitiveCollection());
export const orbitLines = scene.primitives.add(new C.PolylineCollection());

/** Camera height above the ellipsoid (a sphere radius would go negative near the poles). */
export function camHeight() { const c = camera.positionCartographic; return c ? c.height : C.Cartesian3.magnitude(camera.positionWC) - 6371000; }
