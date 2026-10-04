// Which country is at a longitude/latitude? Plain geometry on the simplified borders in data/borders.json ([{ iso, name, poly }]:
// poly = list of polygons, each a list of rings of [lon, lat], the first the outline and the rest holes). DOM-free, so Node tests it.

/** Even-odd test: is (x, y) inside the ring? */
export function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** [west, south, east, north] of a polygon's outline. */
export function boxOf(poly) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [lo, la] of poly[0]) { if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > n) n = la; }
  return [w, s, e, n];
}

/** Add the bounding boxes the lookups use (once, after loading). */
export function prepare(borders) { for (const b of borders) b.box = b.poly.map(boxOf); return borders; }

/** Is the point in this country (any of its parts, and not in a hole)? Needs prepare() first. */
export function inCountry(b, x, y) {
  return b.poly.some((p, k) => { const bx = b.box[k]; return x >= bx[0] && x <= bx[2] && y >= bx[1] && y <= bx[3] && inRing(p[0], x, y) && !p.slice(1).some(h => inRing(h, x, y)); });
}

/** The border record at the point, or null (at sea). */
export function countryAt(borders, lon, lat) { return borders.find(b => inCountry(b, lon, lat)) || null; }

/** The biggest part's bounding box, so a far-off island does not drag a fly-to away from the mainland. */
export function mainBox(b) {
  let best = b.box[0], area = 0;
  for (const bx of b.box) { const a = (bx[2] - bx[0]) * (bx[3] - bx[1]); if (a > area) { area = a; best = bx; } }
  return best;
}
