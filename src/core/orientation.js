// Phone orientation (W3C DeviceOrientation: alpha about up, beta about east, gamma about north, applied Z-X'-Y'') to
// where the back camera looks and which way is up on the screen, in east-north-up components. DOM-free so it is tested.

const D = Math.PI / 180;

/** alpha, beta, gamma in degrees (alpha absolute: 0 = top of the phone toward north); screenAngle 0/90/180/270. */
export function deviceVectors(alpha, beta, gamma, screenAngle = 0) {
  const a = alpha * D, b = beta * D, g = gamma * D, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  const R = [[ca * cg - sa * sb * sg, -cb * sa, ca * sg + cg * sa * sb], [cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb], [-cb * sg, sb, cb * cg]];
  const th = screenAngle * D, ux = Math.sin(th), uy = Math.cos(th);
  return {
    dir: [-R[0][2], -R[1][2], -R[2][2]],                                                            // out of the back of the phone
    up: [R[0][0] * ux + R[0][1] * uy, R[1][0] * ux + R[1][1] * uy, R[2][0] * ux + R[2][1] * uy],    // top of the screen
  };
}

/** iOS gives a relative alpha plus webkitCompassHeading (clockwise from north): the absolute alpha. */
export const alphaFromCompass = heading => (360 - heading) % 360;

/** Azimuth (deg from north, clockwise) and elevation (deg) of an east-north-up direction. */
export const azEl = d => ({ az: (Math.atan2(d[0], d[1]) / D + 360) % 360, el: Math.asin(Math.max(-1, Math.min(1, d[2]))) / D });
