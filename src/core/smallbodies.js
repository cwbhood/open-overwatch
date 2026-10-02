// The packed small-body format written by brand/tools/make_small_bodies.py (asteroids_a.bin / asteroids_b.bin).
// Column-major, little-endian, N records of 15 bytes:
//   Float32 a[N] (AU) | Uint16 e[N] (e*65535) | Uint16 i[N] (i/pi) | Uint16 node[N], peri[N], M0[N] (angle/2pi) | Uint8 cls[N]
// Mean anomalies are propagated to one common epoch (small_bodies.json epoch_jd), so a position is two-body Kepler.

import { DEG } from './units.js';
import { TWO_PI, meanMotion, wrap2pi } from './kepler.js';

export const RECORD_BYTES = 15;
export const DEFAULT_EPOCH = 2461041.5;  // 2026-01-01.0 TT
export const CLASSES = Object.freeze(['Main belt', 'Near-Earth asteroids', 'Jupiter Trojans', 'Centaurs', 'Kuiper belt & beyond', 'Mars-crossers', 'Other']);

/** Typed-array views over one packed file (no copies). */
export function viewSmallBodies(buffer) {
  const N = buffer.byteLength / RECORD_BYTES;
  if (!Number.isInteger(N)) throw new Error(`small-body file is ${buffer.byteLength} bytes, not a multiple of ${RECORD_BYTES}`);
  const u16 = k => new Uint16Array(buffer, k * N, N);
  return { N, a: new Float32Array(buffer, 0, N), e: u16(4), i: u16(6), node: u16(8), peri: u16(10), M0: u16(12), cls: new Uint8Array(buffer, 14 * N, N) };
}

/** Elements of record idx, decoded exactly as the GPU shader decodes them. */
export function decodeElements(view, idx, epoch = DEFAULT_EPOCH) {
  return {
    a: view.a[idx], e: view.e[idx] / 65535, i: view.i[idx] / 65535 * Math.PI,
    node: view.node[idx] / 65535 * TWO_PI, peri: view.peri[idx] / 65535 * TWO_PI, M0: view.M0[idx] / 65535 * TWO_PI,
    epoch, cls: view.cls[idx],
  };
}

/** Comet row from small_bodies.json [name, q, e, i, node, peri, tp] (degrees, jd) -> elements at epoch. Elliptic only. */
export function cometElements(row, epoch = DEFAULT_EPOCH) {
  const [, q, e, i, node, peri, tp] = row;
  if (!(e < 1)) return null;
  const a = q / (1 - e);
  return { a, e, i: i * DEG, node: node * DEG, peri: peri * DEG, M0: wrap2pi(meanMotion(a) * (epoch - tp)), epoch };
}

/** Pack element objects into the same 15-byte format (used to put comets through the asteroid shader). */
export function packSmallBodies(list, cls = 6) {
  const N = list.length, buf = new ArrayBuffer(N * RECORD_BYTES), v = viewSmallBodies(buf);
  const ang = x => Math.round(wrap2pi(x) / TWO_PI * 65535) % 65536;
  list.forEach((el, k) => {
    v.a[k] = el.a; v.e[k] = Math.round(el.e * 65535); v.i[k] = Math.round(el.i / Math.PI * 65535);
    v.node[k] = ang(el.node); v.peri[k] = ang(el.peri); v.M0[k] = ang(el.M0); v.cls[k] = el.cls ?? cls;
  });
  return buf;
}
