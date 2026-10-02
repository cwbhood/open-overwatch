// The registry of things you can focus, label, search and click. A body:
//   { key, name, kind, color, radius (AU), pos: Vector3 (heliocentric ecliptic AU), info?: () => [[label, value]],
//     fact?, layer?: layer id that hides it, update?: jd => void, group?: Object3D,
//     big? (display-font label), star?, far?, fixed? (pos never changes), transient? (a picked asteroid) }
import * as THREE from 'three';

export const bodies = [];
export const byKey = Object.create(null);
export const ORIGIN = new THREE.Vector3();

export function addBody(b) { bodies.push(b); byKey[b.key] = b; return b; }
export function removeBody(b) { const i = bodies.indexOf(b); if (i >= 0) bodies.splice(i, 1); delete byKey[b.key]; }

// layer switches; modules register what they show/hide through onLayers()
export const layers = [];
const layerById = Object.create(null), listeners = [];
export function defineLayer(l) { layers.push(l); layerById[l.id] = l; return l; }
export const layer = id => layerById[id];
export const layerOn = id => !!(layerById[id] && layerById[id].on);
export function onLayers(fn) { listeners.push(fn); }
export function applyLayers() { for (const fn of listeners) fn(); }
export const bodyVisible = b => !b.layer || layerOn(b.layer);
