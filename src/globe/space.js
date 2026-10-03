// One continuous zoom: past the Moon the globe hands its camera to the Solar System view (solar.html?embed=1, in an
// iframe loaded in the background as you climb), and takes it back when you zoom into Earth there. Cameras cross as
// Earth-centred vectors in the ecliptic J2000 frame: Cesium ECEF -> ICRF (Cesium's IAU 2006 matrices) -> ecliptic.
import { C, toast, PHONE } from './env.js';
import { viewer, scene, camera, camHeight } from './viewer.js';
import { state } from './state.js';
import { Follow } from './follow.js';
import { eqToEcl, eclToEq } from '../core/units.js';
import { Time } from './time.js';

const PRELOAD_M = PHONE ? 8.0e7 : 4.0e7;   // start loading the Solar System view in the background (earlier on desktops)
const ENTER_M = 3.0e8;     // hand over beyond this (the Moon is at ~3.8e8 m); solar hands back below 2.2e8
const FADE_MS = 700;

let frame = null, active = false, busy = false, wantEnter = false;
const solar = () => { try { return frame && frame.contentWindow.OOSS; } catch (e) { return null; } };
const fixedMatrix = time => C.Transforms.computeIcrfToFixedMatrix(time) || C.Transforms.computeTemeToPseudoFixedMatrix(time);
// ICRF <-> Earth-fixed needs IERS data; load it for the session (falls back to TEME, ~0.4 deg off, until it arrives)
C.Transforms.preloadIcrfFixed(new C.TimeInterval({ start: C.JulianDate.addDays(C.JulianDate.now(), -1, new C.JulianDate()), stop: C.JulianDate.addDays(C.JulianDate.now(), 2, new C.JulianDate()) })).catch(() => {});

function ensureFrame() {
  if (frame) return;
  frame = document.createElement('iframe');
  frame.src = 'solar.html?embed=1'; frame.title = 'Solar System';
  Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', border: '0', zIndex: 60, opacity: '0', pointerEvents: 'none', transition: `opacity ${FADE_MS}ms ease`, background: 'transparent' });
  document.body.appendChild(frame);
}

function toEcliptic(v, M) { const q = C.Matrix3.multiplyByVector(C.Matrix3.transpose(M, new C.Matrix3()), v, new C.Cartesian3()); return eqToEcl(q.x, q.y, q.z); }
function toFixed(v, M) { const q = eclToEq(v.x, v.y, v.z); return C.Matrix3.multiplyByVector(M, new C.Cartesian3(q.x, q.y, q.z), new C.Cartesian3()); }

function enter() {
  // wait until the view has drawn once and compiled its shaders (S.embed.warm): a moment's delay instead of a freeze
  const S = solar(); if (!S || !S.embed || !S.embed.ready || S.embed.warm === false || busy) return false;
  busy = true; active = true; wantEnter = false;
  const M = fixedMatrix(viewer.clock.currentTime);
  S.embed.enterFromGlobe({ offset: toEcliptic(camera.positionWC, M), dir: toEcliptic(camera.directionWC, M), up: toEcliptic(camera.upWC, M), fovy: camera.frustum.fovy,
    live: Time.live, jd: Time.jd(), rate: Time.rate / 86400 });   // the Solar System's clock runs in days per second
  frame.style.pointerEvents = 'auto'; frame.style.opacity = '1'; frame.focus();
  setTimeout(() => { viewer.useDefaultRenderLoop = false; busy = false; }, FADE_MS);   // only one renderer draws at a time
  return true;
}

/** Called by the Solar System view when you zoom into Earth: { offset, dir, up } ecliptic (m), and its clock. */
function leave(s) {
  if (!active) return;
  busy = true; active = false;
  if (s.live) Time.goLive(); else Time.setJd(s.jd, Math.round(s.rate * 86400));   // carry the time back
  viewer.useDefaultRenderLoop = true;
  const M = fixedMatrix(viewer.clock.currentTime);
  camera.setView({ destination: toFixed(s.offset, M), orientation: { direction: toFixed(s.dir, M), up: toFixed(s.up, M) } });
  scene.requestRender();
  frame.style.opacity = '0'; frame.style.pointerEvents = 'none';
  setTimeout(() => { solar()?.embed.pause(); busy = false; }, FADE_MS);
}

/** Every frame: preload when climbing, hand over when past the Moon and looking back at Earth. */
function update() {
  if (active || busy || state.noHandoff) return;
  const h = camHeight();
  if (h > PRELOAD_M) ensureFrame();
  if (Follow.obj || state.lookingAtMoon || camera._currentFlight) return;   // not mid-flight: go() hands over on arrival
  if (h > ENTER_M || wantEnter) {
    const toEarth = C.Cartesian3.normalize(C.Cartesian3.negate(camera.positionWC, new C.Cartesian3()), new C.Cartesian3());
    if (C.Cartesian3.dot(toEarth, camera.directionWC) > 0.7 || wantEnter) enter();
  }
}

/** The "Solar system" button: climb past the Moon, looking back at Earth; the hand-over happens on the way. */
function go() {
  ensureFrame(); wantEnter = false;
  const out = C.Cartesian3.normalize(camera.positionWC, new C.Cartesian3());
  camera.flyTo({ destination: C.Cartesian3.multiplyByScalar(out, 6378137 + ENTER_M * 1.15, new C.Cartesian3()),
    orientation: { direction: C.Cartesian3.negate(out, new C.Cartesian3()), up: C.Cartesian3.UNIT_Z }, duration: 3.5,
    complete: () => { if (!active && !enter()) { wantEnter = true; toast('Loading the Solar System…', 2500); } } });
}

/** Load the Solar System view in the background ahead of time (desktops, once the globe has settled). */
function preload() { ensureFrame(); }

export const Space = { update, leave, go, preload, get active() { return active; } };
