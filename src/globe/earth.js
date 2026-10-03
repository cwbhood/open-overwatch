/* The photoreal Earth.
   From space: NASA Blue Marble NG (day) and VIIRS Black Marble (night lights, 500 m) streamed from NASA GIBS, real sun
   lighting with Cesium's ground atmosphere, and three shader shells. Two read brand/textures/earth_fx_*.jpg
   (make_earth_fx.py: R clouds, G water, B soft clouds): the surface shell (1.5 km: sun glint, cloud shadows, deep-water
   blue over the close-in map's seafloor) and a lit cloud layer 9 km up (fractal detail and relief shading up close,
   golden at the terminator, dissolving as you zoom in). The limb shell (115 km) draws the edge-on atmosphere: blue by
   day, red-gold bands at sunrise/sunset, green airglow at night.
   Close in, Earth.update() (every frame) fades the realism into a fully lit, readable satellite map: below ~20 km there
   is no day/night, no clouds and no night layer.
   Lessons: the ground atmosphere replaces the night side with its own (black) colour unless nightFade* puts its "far"
   mix at 1 (both nightFade distances are measured from the Earth's centre, like lightingFade*); a single 8k imagery
   tile broke globe rendering, so imagery stays tiled; shells need compressVertices:false (quantised normals streak the
   light); OIT and Appearance.getRenderState both override custom blending (see viewer.js and earthShell). */
import { C, PHONE, store, loadImage } from './env.js';
import { viewer, scene, globe } from './viewer.js';
import { L } from './layers.js';
import { state } from './state.js';

export const R_EQ = 6378137, R_PO = 6356752.3142;
globe.baseColor = C.Color.fromCssColorString('#0b1622');
globe.enableLighting = true;
globe.dynamicAtmosphereLighting = true;
globe.dynamicAtmosphereLightingFromSun = true;
globe.showGroundAtmosphere = true;
globe.lightingFadeOutDistance = R_EQ + 2.0e4; // fully lit, no night, below ~20 km
globe.lightingFadeInDistance = R_EQ + 2.0e5;  // real day/night above ~200 km
globe.nightFadeOutDistance = 1.0;             // => the night side keeps its surface (city lights) under the atmosphere
globe.nightFadeInDistance = 0.0;
scene.fog.enabled = true;
scene.skyAtmosphere.perFragmentAtmosphere = true;

// ---- imagery
const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/';
const esriCredit = new C.Credit('Imagery © Esri, Maxar, Earthstar Geographics · Esri, HERE, Garmin, © OpenStreetMap contributors');
const nasaCredit = new C.Credit('Blue Marble Next Generation & VIIRS Black Marble: NASA Earth Observatory, via NASA GIBS');
// GIBS's geographic (EPSG:4326) set runs pole to pole (web-mercator stops at 85.05 deg and left holes over the poles).
// Its 512 px tiles start at 288 deg wide (2x1) and halve from there, so a geographic tiling scheme over a 576 x 288 deg
// rectangle lines up with every level.
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/';
const gibs = (layer, ext) => new C.UrlTemplateImageryProvider({ url: GIBS + layer + '/default/default/500m/{z}/{y}/{x}.' + ext,
  tilingScheme: new C.GeographicTilingScheme({ rectangle: C.Rectangle.fromDegrees(-180, -198, 396, 90), numberOfLevelZeroTilesX: 2, numberOfLevelZeroTilesY: 1 }),
  rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90), tileWidth: 512, tileHeight: 512, maximumLevel: 7, credit: nasaCredit });
export const BASES = {
  imagery: { name: 'Satellite imagery', url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, look: { brightness: 0.9, saturation: 0.85, contrast: 1.05 }, labels: ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}' },
  dark: { name: 'Dark map', url: ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', max: 16, look: { brightness: 1.1, saturation: 1, contrast: 1 }, labels: ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}' },
};
let baseLayer = null, labelLayer = null, baseId = 'imagery';
// the NASA day (far) and night layers are created once and stay between the base map and the labels
export const marbleLayer = viewer.imageryLayers.addImageryProvider(gibs('BlueMarble_NextGeneration', 'jpeg'));
Object.assign(marbleLayer, { saturation: 1.2, contrast: 1.1, brightness: 1.12, gamma: 1.06 }); // without HDR (it washes the night purple) the day needs a little lift
export const nightLayer = viewer.imageryLayers.addImageryProvider(gibs('VIIRS_Black_Marble', 'png'));
nightLayer.dayAlpha = 0.0; nightLayer.nightAlpha = 1.0;
// gamma is applied before brightness: x^2.5 pushes Black Marble's dim blue land to near-black, then x3.4 restores the
// cities (the lit-globe shader keeps ~30% on the night side)
Object.assign(nightLayer, { gamma: 0.4, brightness: 3.4, contrast: 1.0 });

export const currentBase = () => baseId;
export function setBase(id) {
  const b = BASES[id] || BASES.imagery; store.set('base', id); baseId = BASES[id] ? id : 'imagery';
  if (baseLayer) viewer.imageryLayers.remove(baseLayer, true);
  if (labelLayer) viewer.imageryLayers.remove(labelLayer, true);
  baseLayer = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: b.url, maximumLevel: b.max, credit: esriCredit }), 0);
  Object.assign(baseLayer, b.look);
  labelLayer = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: b.labels, maximumLevel: Math.min(b.max, 16) }));
  labelLayer.alpha = 0.7; labelLayer.show = false;
  labelLayer.dayAlpha = 1.0; labelLayer.nightAlpha = 0.3; // names and borders fade on the night side, so the city lights read
  Earth.apply();
}
export function showPlaceNames(on) { if (labelLayer) labelLayer.show = on; }

// ---- shader shells (equirectangular earth_fx texture on an ellipsoid; EllipsoidGeometry's st = lon/lat)
const FX_TEX = PHONE ? 'brand/textures/earth_fx_2k.jpg' : 'brand/textures/earth_fx_8k.jpg';   // phones: 0.9 MB instead of 2.6
const FX_GLSL = `
uniform sampler2D fx; uniform float fade; uniform float ocean; uniform float cshadow;
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  vec4 t = texture(fx, mi.st);
  vec3 N = normalize(mi.normalEC), V = normalize(mi.positionToEyeEC), L = normalize(czm_lightDirectionEC);
  float ndl = dot(N, L), day = smoothstep(-0.02, 0.12, ndl);
  // sun glint on water (sharp core + wider sheen), suppressed under cloud, boosted at grazing angles
  float nh = max(dot(N, normalize(L + V)), 0.0);
  float glint = (pow(nh, 700.0) * 0.75 + pow(nh, 90.0) * 0.32 + pow(nh, 16.0) * 0.07) * t.g * (1.0 - 0.85 * t.r * min(cshadow * 4.0, 1.0)) * day;
  glint *= 1.0 + 1.5 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  // cloud shadow: the soft cloud density sampled toward the sun, for clouds ~9 km up
  vec3 nW = normalize(czm_inverseViewRotation * N), lW = normalize(czm_inverseViewRotation * L);
  vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), nW)), north = cross(nW, east);
  float cosz = max(dot(lW, nW), 0.12);
  vec2 off = vec2(dot(lW, east), dot(lW, north)) / cosz * 9000.0;
  float coslat = max(sqrt(1.0 - nW.z * nW.z), 0.05);
  float shadow = texture(fx, mi.st + vec2(off.x / (6.2832 * 6378137.0 * coslat), off.y / (3.1416 * 6378137.0))).b * 0.45 * day * cshadow;
  vec3 sheen = mix(vec3(0.62, 0.74, 0.92), vec3(1.0, 0.95, 0.86), clamp(glint * 1.5, 0.0, 1.0)) * glint; // silvery sheen, warm core
  // open ocean (> ~25 km from any coast) in deep-water blue over the close-in map, whose seafloor relief reads as a chart
  vec2 r = vec2(25000.0 / (6.2832 * 6378137.0 * coslat), 25000.0 / (3.1416 * 6378137.0));
  float open = min(min(t.g, min(texture(fx, mi.st + vec2(r.x, 0.0)).g, texture(fx, mi.st - vec2(r.x, 0.0)).g)),
                   min(texture(fx, mi.st + vec2(0.0, r.y)).g, texture(fx, mi.st - vec2(0.0, r.y)).g));
  float sea = smoothstep(0.6, 0.95, open) * ocean;
  vec3 seaCol = vec3(0.035, 0.075, 0.17) * clamp(5.0 * ndl + 0.3, 0.0, 1.0) * clamp(5.0 * ndl, 0.0, 1.0); // GlobeFS diffuse x day blend
  sheen += vec3(0.008, 0.024, 0.05) * t.g * clamp(5.0 * max(ndl, 0.0), 0.0, 1.0); // deep water reads near-black from low orbit: lift it to blue
  m.diffuse = sheen * fade + seaCol * sea;                    // premultiplied: added on top
  m.alpha = clamp(sea + shadow * (1.0 - sea), 0.0, 1.0);      // the cloud shadow darkens the surface, the sea replaces it
  return m;
}`;
const CLOUD_GLSL = `
uniform sampler2D fx; uniform float fade; uniform float octaves;
float hash3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); } // float-safe at Earth-scale coordinates
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  vec4 t = texture(fx, mi.st);
  vec3 N = normalize(mi.normalEC), V = normalize(mi.positionToEyeEC), L = normalize(czm_lightDirectionEC);
  float ndl = dot(N, L), ndv = max(dot(N, V), 0.0);
  vec3 nW = normalize(czm_inverseViewRotation * N), lW = normalize(czm_inverseViewRotation * L);
  // fractal detail below the texture's ~5 km texels: each octave fades in once it is bigger than a few pixels (no shimmer from orbit)
  vec3 pW = (czm_inverseView * vec4(-mi.positionToEyeEC, 1.0)).xyz;
  float px = length(fwidth(pW)), n = 0.0, wsum = 0.0, lam = 16000.0, k = 0.0;
  for (int o = 0; o < 4; o++) {
    if (float(o) >= octaves) break;                             // fewer octaves on the lower quality levels
    float w = (1.0 - smoothstep(lam * 0.12, lam * 0.4, px)) / float(o + 1);
    n += (vnoise(pW / lam + float(o) * 7.31) - 0.5) * w; wsum += 1.0 / float(o + 1); k = max(k, w * float(o + 1) * step(0.5, float(o)));
    lam *= 0.42;
  }
  n /= wsum;
  float d = mix(t.r, t.b, 0.35 + 0.35 * k);                    // the blurred density kills speckle (and jpeg ringing up close)
  d = clamp(d + n * 4.0 * d * (1.0 - d), 0.0, 1.0);            // erodes soft edges into ragged ones; thick cores stay whole
  // relief: dense cores stand taller, so slopes facing the sun are brighter and the far side darker
  vec2 tx = vec2(5.0 / 8192.0, 5.0 / 4096.0);
  float gx = texture(fx, mi.st + vec2(tx.x, 0.0)).b - texture(fx, mi.st - vec2(tx.x, 0.0)).b;
  float gy = texture(fx, mi.st + vec2(0.0, tx.y)).b - texture(fx, mi.st - vec2(0.0, tx.y)).b;
  vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), nW)), north = cross(nW, east);
  float relief = clamp(1.0 + 1.7 * (gx * dot(lW, east) + gy * dot(lW, north)), 0.6, 1.35);
  float day = smoothstep(-0.05, 0.10, ndl), lit = 0.42 + 0.56 * clamp(ndl * 1.6, 0.0, 1.0), puff = 1.0 + n * 0.9 * k;
  vec3 dayCol = vec3(1.0, 0.99, 0.97) * lit * relief * puff * (0.9 + 0.3 * (1.0 - k) * clamp(t.r - t.b, -0.15, 0.35));
  dayCol *= mix(vec3(1.0), vec3(1.0, 0.64, 0.40), exp(-pow((ndl - 0.015) / 0.05, 2.0)) * 0.85);   // the last minutes of sun
  vec3 col = mix(vec3(0.016, 0.02, 0.032), dayCol, day);
  float thin = 1.0 - fade;                                     // zooming in, the thin cloud dissolves first instead of fogging
  float a = smoothstep(mix(0.10 + 0.12 * k, 0.92, thin), mix(0.80 - 0.15 * k, 1.0, thin), d) * min(1.0, fade * 4.0);
  a = clamp(a * (1.0 + 1.6 * pow(1.0 - ndv, 3.0)), 0.0, 1.0);  // thicker toward the limb
  a *= mix(0.7, 1.0, day);                                     // thinner at night: city glow shows through
  a *= 1.0 - smoothstep(1.43, 1.48, abs(asin(clamp(nW.z, -1.0, 1.0)))); // none past ~84 deg, where the texture pinches into streaks
  m.diffuse = min(col, vec3(1.0)); m.alpha = a * 0.95;
  return m;
}`;
// limb: the atmosphere seen edge-on from orbit. For each pixel the view ray's lowest point (tangent height, worked out in
// ellipsoid-normalised space) picks the layer: blue day limb, red-orange-gold bands where the tangent point is at
// sunrise/sunset, and the faint green airglow ~95 km up over the night side. Additive; the globe hides the rest.
const LIMB_GLSL = `
uniform sampler2D fx; uniform float fade; uniform float ocean; uniform float cshadow;
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  vec3 S = vec3(1.0 / 6378137.0, 1.0 / 6378137.0, 1.0 / 6356752.3);
  vec3 pW = (czm_inverseView * vec4(-mi.positionToEyeEC, 1.0)).xyz;
  vec3 c = czm_viewerPositionWC * S, dir = normalize(pW * S - c);
  vec3 q = c - dir * dot(c, dir);                                   // the ray's closest approach to the centre
  float h = (length(q) - 1.0) * 6371000.0;                          // tangent height, m
  float sun = dot(normalize(q / S), czm_lightDirectionWC);          // sun elevation (sine) at the tangent point
  float tw = exp(-pow((sun + 0.03) / 0.11, 2.0)), dayL = smoothstep(0.0, 0.25, sun);
  vec3 col = vec3(0.32, 0.58, 1.0) * exp(-h / 9000.0) * 0.32 * dayL;
  col += (vec3(1.0, 0.30, 0.06) * exp(-h / 4500.0) * 0.9 + vec3(1.0, 0.78, 0.42) * exp(-pow((h - 11000.0) / 6000.0, 2.0)) * 0.55
        + vec3(0.30, 0.50, 1.0) * exp(-h / 22000.0) * 0.25) * tw;
  col += vec3(0.30, 0.95, 0.45) * exp(-pow((h - 95000.0) / 5000.0, 2.0)) * 0.10 * (1.0 - smoothstep(-0.25, -0.05, sun));
  m.diffuse = col * smoothstep(-1500.0, 500.0, h) * fade; m.alpha = 0.0;
  return m;
}`;
function earthShell(lift, source, blending, extra = {}) {
  const material = new C.Material({ fabric: { uniforms: { fx: C.Material.DefaultImageId, fade: 1.0, ocean: 0.0, cshadow: 1.0, ...extra }, source }, translucent: true });
  const appearance = new C.MaterialAppearance({ material, flat: true, translucent: true, closed: true, faceForward: false,
    materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED,
    renderState: { depthTest: { enabled: true }, depthMask: false, cull: { enabled: true, face: C.CullFace.BACK }, blending } });
  // Appearance.getRenderState() forces ALPHA_BLEND on anything translucent; keep the requested blending
  appearance.getRenderState = function () { const rs = C.clone(this.renderState, false); rs.depthMask = false; rs.blending = blending; return rs; };
  const geometry = new C.EllipsoidGeometry({ radii: new C.Cartesian3(R_EQ + lift, R_EQ + lift, R_PO + lift), stackPartitions: PHONE ? 128 : 256, slicePartitions: PHONE ? 256 : 512,
    vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat });
  const primitive = scene.primitives.add(new C.Primitive({ geometryInstances: new C.GeometryInstance({ geometry }), appearance, asynchronous: false, compressVertices: false, allowPicking: false }));   // taps go through to the satellites
  return { primitive, material };
}
const PREMULTIPLIED = { enabled: true, equationRgb: C.BlendEquation.ADD, equationAlpha: C.BlendEquation.ADD,
  functionSourceRgb: C.BlendFunction.ONE, functionSourceAlpha: C.BlendFunction.ONE,
  functionDestinationRgb: C.BlendFunction.ONE_MINUS_SOURCE_ALPHA, functionDestinationAlpha: C.BlendFunction.ONE_MINUS_SOURCE_ALPHA };
export const fxShell = earthShell(1500, FX_GLSL, PREMULTIPLIED);   // 1.5 km up: thinner shells z-fight with the coarse far-zoom globe mesh
export const limbShell = earthShell(1.15e5, LIMB_GLSL, PREMULTIPLIED);
export const cloudShell = earthShell(9000, CLOUD_GLSL, C.BlendingState.ALPHA_BLEND, { octaves: 4.0 });
export const Fx = { ok: false };   // the glint/shadow and cloud shells stay hidden until earth_fx is in
loadImage(FX_TEX).then(img => { fxShell.material.uniforms.fx = img; cloudShell.material.uniforms.fx = img; Fx.ok = true; Earth.apply(); })
  .catch(e => console.warn('Clouds and sun glint unavailable:', e.message));

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const Earth = {
  h: Infinity,
  update(h) { this.h = h; this.apply(); },
  hidden: false,   // look-up mode: no map tiles or shells, a plain dark ground (set by lookup.js)
  apply() {
    if (this.hidden) {
      for (let k = 0; k < viewer.imageryLayers.length; k++) viewer.imageryLayers.get(k).show = false;
      fxShell.primitive.show = cloudShell.primitive.show = limbShell.primitive.show = false; return;
    }
    const h = this.h, real = smooth(2.0e4, 2.0e5, h);   // 0 = readable map, 1 = real day/night
    marbleLayer.alpha = smooth(1.2e5, 4.5e5, h);          // Blue Marble from space (level 8 ~ 600 m still matches the screen at ~300 km)
    // a layer at alpha 0, or one fully under the opaque Blue Marble, still costs tile downloads, texture units and a
    // globe shader variant per combination (each new variant is a compile stall mid-flight): switch those off
    marbleLayer.show = marbleLayer.alpha > 0.001;
    if (baseLayer) { baseLayer.nightAlpha = 1 - real; baseLayer.show = marbleLayer.alpha < 0.999; }   // close in, the map stays visible on the night side
    limbShell.primitive.show = true;   // (look-up mode hides it)
    marbleLayer.nightAlpha = 1 - real;
    nightLayer.show = L.night.on && real > 0.001; nightLayer.alpha = real;
    // the globe dims its night side to 0.3 only at full lighting (linear in height between the two lighting fade
    // distances); keep the city lights at the same apparent brightness while that dimming fades in
    const f = Math.min(1, Math.max(0, (h - 2.0e4) / (2.0e5 - 2.0e4)));
    nightLayer.brightness = 3.4 * 0.3 / (1 - 0.7 * f);
    const sfx = smooth(1.2e5, 6.0e5, h), sc = smooth(7.0e4, 2.5e5, h) * (L.clouds.on && !state.weather ? 1 : 0);   // clouds stay full at ISS height
    const sea = (1 - marbleLayer.alpha) * smooth(2.5e4, 8.0e4, h) * (baseId === 'imagery' ? 1 : 0); // the dark map keeps its own sea
    Object.assign(fxShell.material.uniforms, { fade: sfx, ocean: sea, cshadow: sc });
    fxShell.primitive.show = Fx.ok && (sfx > 0.001 || sea > 0.001 || sc > 0.001);
    cloudShell.material.uniforms.fade = sc; cloudShell.primitive.show = Fx.ok && sc > 0.001;
  },
};

// ---- where the Sun and Moon are (Earth-fixed)
const icrfToFixed = time => C.Transforms.computeIcrfToFixedMatrix(time) || C.Transforms.computeTemeToPseudoFixedMatrix(time);
export function sunDirection(time, out = new C.Cartesian3()) {
  return C.Cartesian3.normalize(C.Matrix3.multiplyByVector(icrfToFixed(time), C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time), out), out);
}
export function moonPosition(time = viewer.clock.currentTime) {
  return C.Matrix3.multiplyByVector(icrfToFixed(time), C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time), new C.Cartesian3());
}
export function sunSubpoint(time = C.JulianDate.now()) {
  const c = C.Cartographic.fromCartesian(C.Cartesian3.multiplyByScalar(sunDirection(time), R_EQ, new C.Cartesian3()));
  return [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)];
}
/** A mostly sunlit Earth whatever the time: day across most of the disk, the terminator and city lights on the left. */
export function sunlitView() { const [lon, lat] = sunSubpoint(); return [((lon - 38 + 540) % 360) - 180, Math.max(-35, Math.min(35, lat + 12))]; }

setBase(store.get('base', 'imagery'));
