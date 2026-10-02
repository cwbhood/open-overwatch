// GPU checks shared by the 3D views (no DOM: the caller passes the WebGL context).

/** True when the browser draws WebGL in software (hardware acceleration off, or a blocklisted driver): every 3D view
 *  then crawls whatever the quality level, and the user can fix it in the browser settings. */
export const isSoftwareRenderer = name => /swiftshader|llvmpipe|softpipe|basic render|software/i.test(name || '');

/** The GPU's name from a WebGL context ('' when the browser hides it). */
export function rendererName(gl) {
  try { const e = gl.getExtension('WEBGL_debug_renderer_info'); return String(gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || ''); }
  catch (e) { return ''; }
}

export const SOFTWARE_HINT = 'This browser is drawing 3D without the graphics card, so it will be slow. Turn on hardware acceleration in the browser settings (Chrome/Edge: Settings › System) and reload.';
