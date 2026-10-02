// The background star map (NASA SVS Deep Star Maps 2020) on a camera-centred sphere. The shader turns each view
// direction (ecliptic) into RA/Dec and samples the equirectangular map directly: no cube-map conventions involved.
import * as THREE from 'three';
import { OBLIQUITY_J2000 } from '../core/units.js';
import { LOGDEPTH_V, LOGDEPTH_F, loadTexture, PHONE } from './util.js';

export function createSky(scene) {
  const ce = Math.cos(OBLIQUITY_J2000).toFixed(9), se = Math.sin(OBLIQUITY_J2000).toFixed(9);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, uK: { value: 1 } }, side: THREE.BackSide, depthWrite: false, depthTest: false,
    vertexShader: LOGDEPTH_V + `varying vec3 vD;
      void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.999999;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: LOGDEPTH_F + `uniform sampler2D map; uniform float uK; varying vec3 vD;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 d = normalize(vD), q = vec3(d.x, d.y * ${ce} - d.z * ${se}, d.y * ${se} + d.z * ${ce});   // ecliptic -> equatorial
        vec2 uv = vec2(fract(0.5 - atan(q.y, q.x) / 6.2831853), 0.5 + asin(clamp(q.z, -1.0, 1.0)) / 3.1415927); // RA 0h centred, RA grows leftward
        gl_FragColor = vec4(texture2D(map, uv).rgb * uK, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  mesh.renderOrder = -1000; mesh.frustumCulled = false; scene.add(mesh);
  loadTexture(`brand/textures/sky_equirect${PHONE ? '_2k' : ''}.jpg`).then(t => {
    if (!t) return; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; mesh.material.uniforms.map.value = t;
  });
  return {
    mesh,
    /** Ride with the camera; dim as you leave the neighbourhood whose sky this is. */
    frame({ camera, camSun, fade }) {
      mesh.position.copy(camera.position); mesh.scale.setScalar(1e14);
      mesh.material.uniforms.uK.value = 1 - 0.75 * fade(2, 60, camSun, 'ly') - 0.25 * fade(8, 2e4, camSun, 'ly');
    },
  };
}
