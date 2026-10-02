// three.js helpers shared by the Solar System view: log-depth shader chunks, textures with a site fallback, glows.
import * as THREE from 'three';
import { SITE } from '../core/assets.js';

export const PHONE = matchMedia('(max-width: 900px)').matches || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600);

// every custom shader must carry these, or it fights the logarithmic depth buffer
export const LOGDEPTH_V = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
export const LOGDEPTH_F = '#include <logdepthbuf_pars_fragment>\n';

/** A ShaderMaterial whose vertex shader passes view-space position, normal and uv; `frag` writes `col` and `alpha`. */
export function surfaceMaterial({ uniforms, frag, ...opts }) {
  return new THREE.ShaderMaterial({
    uniforms, ...opts,
    vertexShader: LOGDEPTH_V + `varying vec3 vN; varying vec3 vP; varying vec2 vUv;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vP = mv.xyz; vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: LOGDEPTH_F + `varying vec3 vN; varying vec3 vP; varying vec2 vUv;
      ${frag.decl || ''}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 col = vec3(0.0); float alpha = 1.0;
        ${frag.body}
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }`,
  });
}

const loader = new THREE.TextureLoader();
/** Load a texture from the page's folder, else from the published site; resolves null if both fail. */
export function loadTexture(path, { srgb = true } = {}) {
  return new Promise(resolve => {
    const done = t => { if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; resolve(t); };
    loader.load(path, done, undefined, () => loader.load(SITE + path, done, undefined, () => resolve(null)));
  });
}
// Everything starts on the 2k maps; the 4k ones (45 MB of GPU memory each with mipmaps) load only for what you fly
// close to, on desktops (Sharpen). Loading every 4k map up front cost ~600 MB of GPU memory and a 1.1 s upload freeze
// when the globe handed over to this view.
export const planetTexture = name => `brand/textures/planets/${name}_2k.jpg`;
export const sharpTexture = name => `brand/textures/planets/${name}.jpg`;
/** Swap a texture uniform's value, freeing the old texture. */
export function swapTexture(u, t) { const old = u.value; u.value = t; if (old && old !== t && old.dispose) old.dispose(); }
/** Sharper textures on demand: add(when, path, apply) loads `path` the first frame `when()` is true (desktop only). */
export const Sharpen = {
  camera: null, items: [],
  add(when, path, apply, opts) { if (!PHONE) this.items.push({ when, path, apply, opts }); },
  /** Same, on every device: textures that load only once they are about to be seen (phones were downloading 9 MB up front). */
  need(when, path, apply, opts) { this.items.push({ when, path, apply, opts }); },
  /** On-screen radius of a body in CSS pixels. */
  px(b) { const c = this.camera; return b.radius / Math.max(c.position.distanceTo(b.pos), 1e-12) * innerHeight / (2 * Math.tan(c.fov * Math.PI / 360)); },
  tick() {
    if (!this.camera || !this.items.length) return;
    this.items = this.items.filter(it => { if (!it.when()) return true; loadTexture(it.path, it.opts).then(t => t && it.apply(t)); return false; });
  },
};

/** Radial-gradient sprite texture. stops: [[offset, css colour], ...] */
export function glowTexture(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([o, col]) => gr.addColorStop(o, col)); g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export const STAR_TEXTURE = glowTexture([[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,255,255,.75)'], [0.5, 'rgba(255,255,255,.12)'], [1, 'rgba(255,255,255,0)']]);

/** Smoothstep on a log scale: 0 below a, 1 above b. Most fades here are by distance across many decades. */
export function smoothLog(a, b, x) {
  const t = Math.min(1, Math.max(0, (Math.log(x) - Math.log(a)) / (Math.log(b) - Math.log(a))));
  return t * t * (3 - 2 * t);
}

export const toVector3 = (o, out = new THREE.Vector3()) => out.set(o.x, o.y, o.z);
