// The Sun and the clock on the ground: a glowing marker where the Sun is straight overhead, the meridian of local solar noon, and
// the 24 time-zone meridians (every 15 degrees; they stay put while the Earth turns under the Sun). Moves every 20 s.
import { C } from './env.js';
import { scene, viewer } from './viewer.js';
import { L } from './layers.js';
import { sunSubpoint } from './earth.js';
import { Time } from './time.js';

const lines = scene.primitives.add(new C.PolylineCollection()), dots = scene.primitives.add(new C.PointPrimitiveCollection()), labels = scene.primitives.add(new C.LabelCollection());
let noon = null, sun = null, label = null, built = false;
const meridian = (lon, h = 12000) => { const pts = []; for (let la = -88; la <= 88; la += 4) pts.push(C.Cartesian3.fromDegrees(lon, la, h)); return pts; };

function build() {
  built = true;
  for (let lon = -180; lon < 180; lon += 15) lines.add({ positions: meridian(lon), width: 1, material: C.Material.fromType('Color', { color: C.Color.WHITE.withAlpha(0.16) }) });
  noon = lines.add({ positions: meridian(0), width: 3, material: C.Material.fromType('PolylineGlow', { glowPower: 0.3, color: C.Color.fromCssColorString('#ffd45c') }) });
  sun = dots.add({ position: C.Cartesian3.ZERO, pixelSize: 16, color: C.Color.fromCssColorString('#fff3b0'), outlineColor: C.Color.fromCssColorString('#ffb400').withAlpha(0.5), outlineWidth: 12, disableDepthTestDistance: Number.POSITIVE_INFINITY });
  label = labels.add({ position: C.Cartesian3.ZERO, text: 'Sun overhead · local noon', font: '600 12px "IBM Plex Mono", monospace', fillColor: C.Color.fromCssColorString('#fff3b0'), style: C.LabelStyle.FILL, pixelOffset: new C.Cartesian2(14, -18), disableDepthTestDistance: Number.POSITIVE_INFINITY });
}
function update() {
  const [lon, lat] = sunSubpoint(viewer.clock.currentTime);   // the globe's own clock: follows the time bar, live or not
  sun.position = C.Cartesian3.fromDegrees(lon, lat, 30000); label.position = sun.position; noon.positions = meridian(lon, 14000);
  label.text = `Sun overhead · ${Math.abs(lat).toFixed(0)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(0)}°${lon >= 0 ? 'E' : 'W'} · local noon`;
  scene.requestRender();
}
let started = false;
export const SunLine = {
  apply() {   // called on every visibility change: cheap unless the layer just turned on
    const on = L.sun.on; lines.show = dots.show = labels.show = on;
    if (on && !built) build();
    if (on && !started) { started = true; update(); setInterval(() => L.sun.on && update(), 5e3); Time.onChange(() => L.sun.on && update()); }
    scene.requestRender();
  },
};
