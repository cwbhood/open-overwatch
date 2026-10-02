#!/usr/bin/env python3
"""make_textures.py - equirectangular Earth textures for the Open Overwatch 3D globe renders.

Reproducible and offline: reads only the public-domain sources in brand/source and needs nothing but
Python 3.12 + numpy + Pillow.

    python make_textures.py                      # everything, 8192x4096, into the default --out folder
    python make_textures.py --only land,coast    # a subset (landdots also builds the land mask it needs)
    python make_textures.py --checks             # also write zoomed QA crops into <out>/check/

All maps are plate carree (equirectangular), pixel-is-area: column x covers lon -180 + 360*x/W .. +360/W,
row y covers lat 90 - 180*y/H downward, so lon 0 is the image centre and the seam sits on the antimeridian.
That is what Blender's sphere UVs / Environment-style equirect lookups expect.

Outputs (in --out, "8k" = the --width/1024 suffix):
  lights_8k.png    16-bit grey night lights from NASA Black Marble 2016. The blue moonlit-terrain/ice background
                   of the composite is removed (luminance minus a blue-channel background estimate), the result
                   is area-averaged to the output size, then a 0.6 gamma lifts faint rural light while keeping
                   suburbs below the cores (cores that are already saturated in the source stay at 1.0).
  land_8k.png      8-bit land mask, white land. Exact even-odd scanline fill with analytic horizontal coverage
                   and 8 vertical sub-samples (better AA than 2x supersampling, and it never builds a 2x canvas).
  coast_8k.png     coastlines, ~3 px; antimeridian cut edges and the south-pole closing edge are dropped.
  borders_8k.png   internal country borders (TopoJSON mesh a != b), ~2 px.
  grid_8k.png      15 degree graticule; equator + prime meridian stronger; minor meridians stop at +-75 deg,
                   0/90/180 run to the poles.
  landdots_8k.png  dot-matrix land: hex-staggered lattice with ~0.9 deg ground spacing, dot count per row
                   proportional to cos(lat); each dot is a true spherical cap, i.e. it is drawn wider by
                   1/cos(lat) in the flat map so it is round on the globe.
  preview/<name>.png 1024x512 previews and preview/sheet.png (2x3 contact sheet).

Line widths ("--line-mode sphere", the default) are measured on the sphere: a 3 px coastline is 3 px tall
everywhere and 3 px wide at the equator, but 3/cos(lat) px wide at high latitude, so it renders as an even
3 px-at-equator-scale stroke on the globe instead of thinning to ~1 px around Greenland/Antarctica.
Use "--line-mode flat" for constant pixel widths (better for flat 2D map use).

TopoJSON decoding is done here (no topojson lib): arcs are delta-decoded, the transform applied, a negative
arc index ~i means arc i reversed. world-atlas@2 data is "stitched" for spherical use: rings may cross the
antimeridian and Antarctica's outer ring winds all the way round the pole (plus a degenerate -89.999 ring).
For the fill, rings are longitude-unwrapped, drawn at +-360 deg copies, and rings that wind round a pole are
closed through that pole (pole picked from ring orientation: d3 exteriors are clockwise, holes anticlockwise).
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
DEFAULT_SRC = HERE.parent / "source"
DEFAULT_OUT = HERE.parent / "textures"

ALL = ["lights", "land", "coast", "borders", "grid", "landdots"]
DEFAULT_SRC_JPG = [DEFAULT_SRC / "BlackMarble_2016_3km.jpg"]   # set from --src in main()

# ---- tunables ---------------------------------------------------------------------------------------------
LIGHTS = dict(
    bg_blue=0.62,    # background (moonlit terrain / ice / ocean) luminance ~= 0.62 * blue channel in the composite
    bg_cap=56.0,     # ...but never more than the brightest background (ice sheet Y ~ 52); keeps white cores monotonic
    floor=4.0,       # JPEG noise floor left after background removal (99.9th pct over desert/ice/taiga < 4)
    gamma=0.6,       # out = v**gamma: v=0.03 -> 0.12, 0.1 -> 0.25, 0.3 -> 0.49, 0.6 -> 0.74, 0.8 -> 0.87, 1 -> 1
                     # (a log curve lifted lows the same but squashed suburbs into the cores: ~50% more near-white area)
)
COAST_HALF_WIDTH = 1.5      # px (=> ~3 px line)
BORDER_HALF_WIDTH = 1.0     # px (=> ~2 px line)
GRID = dict(step=15.0, minor=(0.75, 0.62), major=(1.25, 1.0), meridian_cut=75.0)  # (half width px, value)
DOTS = dict(spacing=0.9, radius_frac=0.28, stagger=True)


def log(*a):
    print(*a, flush=True)


# ---- TopoJSON -----------------------------------------------------------------------------------------------
def load_topology(path):
    with open(path, "r", encoding="utf-8") as f:
        topo = json.load(f)
    tr = topo.get("transform")
    arcs = []
    for arc in topo["arcs"]:
        a = np.asarray(arc, dtype=np.float64)[:, :2]
        if tr:
            a = np.cumsum(a, axis=0) * np.asarray(tr["scale"], float) + np.asarray(tr["translate"], float)
        # snap the data's dateline / pole values exactly onto the map edges
        lon, lat = a[:, 0], a[:, 1]
        e = np.abs(np.abs(lon) - 180.0) < 1e-6
        lon[e] = np.sign(lon[e]) * 180.0
        lat[lat <= -89.99] = -90.0
        lat[lat >= 89.99] = 90.0
        arcs.append(a)
    return topo, arcs


def arc_coords(arcs, i):
    return arcs[i] if i >= 0 else arcs[~i][::-1]


def ring_coords(arcs, idx):
    parts = []
    for i in idx:
        a = arc_coords(arcs, i)
        parts.append(a if not parts else a[1:])
    return np.concatenate(parts)


def polygons(geom):
    t = geom.get("type")
    if t == "Polygon":
        return [geom["arcs"]]
    if t == "MultiPolygon":
        return list(geom["arcs"])
    if t == "GeometryCollection":
        return [p for g in geom["geometries"] for p in polygons(g)]
    return []


def unwrap_lon(lon):
    d = np.diff(lon)
    d = d - 360.0 * (d > 180.0) + 360.0 * (d < -180.0)
    return np.concatenate([[lon[0]], lon[0] + np.cumsum(d)])


def to_px(lon, lat, W, H):
    return (lon + 180.0) * (W / 360.0), (90.0 - lat) * (H / 180.0)


# ---- polygon fill: even-odd, exact horizontal coverage, `ss` vertical sub-rows ---------------------------------
def fill_edges(arcs, polys, W, H):
    """Closed, unwrapped, pole-closed rings -> edge arrays in pixel space (with +-360 deg copies)."""
    ex0, ey0, ex1, ey1 = [], [], [], []
    polar = 0
    for poly in polys:
        for k, idx in enumerate(poly):
            R = ring_coords(arcs, idx)
            lon, lat = unwrap_lon(R[:, 0]), R[:, 1].copy()
            net = lon[-1] - lon[0]
            if abs(net) > 180.0:               # winds round a pole: close it through that pole
                polar += 1
                south = (net > 0) == (k == 0)  # exterior CW -> interior on the right; hole CCW -> on the left
                if (lat.mean() < 0) != south:
                    log(f"  WARNING: polar ring orientation disagrees with its hemisphere (mean lat {lat.mean():.1f})")
                plat = -90.0 if south else 90.0
                lon = np.concatenate([lon, [lon[-1], lon[0], lon[0]]])
                lat = np.concatenate([lat, [plat, plat, lat[0]]])
            lo, hi = lon.min(), lon.max()
            for s in (-720.0, -360.0, 0.0, 360.0, 720.0):
                if lo + s < 180.0 and hi + s > -180.0:
                    x, y = to_px(lon + s, lat, W, H)
                    ex0.append(x[:-1]); ey0.append(y[:-1]); ex1.append(x[1:]); ey1.append(y[1:])
    return [np.concatenate(v) for v in (ex0, ey0, ex1, ey1)], polar


def raster_fill(edges, W, H, ss=8, strip=128):
    x0, y0, x1, y1 = edges
    m = y0 != y1
    x0, y0, x1, y1 = x0[m], y0[m], x1[m], y1[m]
    ya, yb = np.minimum(y0, y1) * ss, np.maximum(y0, y1) * ss
    r0 = np.clip(np.ceil(ya - 0.5), 0, H * ss).astype(np.int64)   # sub-rows whose centre lies in [ya, yb)
    r1 = np.clip(np.ceil(yb - 0.5), 0, H * ss).astype(np.int64)
    n = r1 - r0
    e = np.repeat(np.arange(n.size), n)
    r = np.repeat(r0, n) + (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n))
    yc = (r + 0.5) / ss
    xc = x0[e] + (yc - y0[e]) * (x1[e] - x0[e]) / (y1[e] - y0[e])
    del e, yc
    xc = np.clip(xc, 0.0, float(W))           # anything left of the map toggles from column 0
    order = np.lexsort((xc, r))
    r, xc = r[order], xc[order]
    rank = np.arange(r.size) - np.searchsorted(r, r, side="left")
    sign = np.where(rank & 1, -1.0, 1.0)
    odd = np.count_nonzero(np.bincount(r, minlength=H * ss) & 1)
    if odd:
        log(f"  WARNING: {odd} sub-rows with an odd number of crossings")
    out = np.empty((H, W), np.float32)
    stride = W + 1
    for oy in range(0, H, strip):
        oy1 = min(H, oy + strip)
        s0, s1 = oy * ss, oy1 * ss
        i0, i1 = np.searchsorted(r, s0), np.searchsorted(r, s1)
        rr, xx, sg = r[i0:i1] - s0, xc[i0:i1], sign[i0:i1]
        kk = np.floor(xx).astype(np.int64)
        keep = kk < W                           # a crossing at x == W covers nothing
        rr, xx, sg, kk = rr[keep], xx[keep], sg[keep], kk[keep]
        fr = xx - kk
        nsub = s1 - s0
        acc = np.bincount(rr * stride + kk, weights=sg * (1.0 - fr), minlength=nsub * stride)
        acc += np.bincount(rr * stride + kk + 1, weights=sg * fr, minlength=nsub * stride)
        cov = np.cumsum(acc.reshape(nsub, stride), axis=1)[:, :W]
        out[oy:oy1] = cov.reshape(oy1 - oy, ss, W).mean(axis=1)
    return np.clip(out, 0.0, 1.0)


# ---- antialiased capsule lines, width measured on the sphere -------------------------------------------------
def line_segments(coord_list, drop_artificial):
    """Polylines (lon/lat arrays) -> segment arrays; lon1 is unwrapped relative to lon0."""
    L0, A0, L1, A1 = [], [], [], []
    for R in coord_list:
        lon0, lat0, lon1, lat1 = R[:-1, 0], R[:-1, 1], R[1:, 0], R[1:, 1]
        keep = (lon0 != lon1) | (lat0 != lat1)
        if drop_artificial:
            cut = (np.abs(lon0) == 180.0) & (np.abs(lon1) == 180.0)           # dateline cut edges
            pole = ((lat0 <= -90.0) & (lat1 <= -90.0)) | ((lat0 >= 90.0) & (lat1 >= 90.0))
            keep &= ~cut & ~pole
        d = lon1 - lon0
        lon1 = lon1 - 360.0 * (d > 180.0) + 360.0 * (d < -180.0)
        L0.append(lon0[keep]); A0.append(lat0[keep]); L1.append(lon1[keep]); A1.append(lat1[keep])
    return [np.concatenate(v) for v in (L0, A0, L1, A1)]


def raster_lines(segs, W, H, hw, sphere=True, max_len=6.0, budget=3_000_000):
    lon0, lat0, lon1, lat1 = segs
    x0, y0 = to_px(lon0, lat0, W, H)
    x1, y1 = to_px(lon1, lat1, W, H)
    # subdivide so each piece's bounding box stays small and its latitude scale is ~constant
    n = np.maximum(1, np.ceil(np.hypot(x1 - x0, y1 - y0) / max_len)).astype(np.int64)
    e = np.repeat(np.arange(n.size), n)
    j = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
    t0, t1 = j / n[e], (j + 1) / n[e]
    dx, dy = (x1 - x0)[e], (y1 - y0)[e]
    xa, ya = x0[e] + dx * t0, y0[e] + dy * t0
    xb, yb = x0[e] + dx * t1, y0[e] + dy * t1
    if sphere:
        c = np.maximum(np.cos(np.radians(90.0 - 0.5 * (ya + yb) * (180.0 / H))), 0.05)
    else:
        c = np.ones_like(xa)
    hwx = hw / c
    bx0 = np.floor(np.minimum(xa, xb) - hwx - 1).astype(np.int64)
    bx1 = np.ceil(np.maximum(xa, xb) + hwx + 1).astype(np.int64)
    by0 = np.floor(np.minimum(ya, yb) - hw - 1).astype(np.int64)
    by1 = np.ceil(np.maximum(ya, yb) + hw + 1).astype(np.int64)
    bw, cnt = bx1 - bx0, (bx1 - bx0) * (by1 - by0)
    csum = np.cumsum(cnt)
    out = np.zeros(H * W, np.float32)
    start = 0
    while start < cnt.size:
        base = csum[start - 1] if start else 0
        end = max(start + 1, int(np.searchsorted(csum, base + budget, side="right")))
        cn = cnt[start:end]
        ee = np.repeat(np.arange(start, end), cn)
        loc = np.arange(cn.sum()) - np.repeat(np.cumsum(cn) - cn, cn)
        py = by0[ee] + loc // bw[ee]
        px = bx0[ee] + loc % bw[ee]
        ok = (py >= 0) & (py < H)
        ee, px, py = ee[ok], px[ok], py[ok]
        ce = c[ee]
        qx, qy = (px + 0.5 - xa[ee]) * ce, py + 0.5 - ya[ee]       # metric: arc-length in equator pixels
        ux, uy = (xb - xa)[ee] * ce, (yb - ya)[ee]
        uu = np.maximum(ux * ux + uy * uy, 1e-12)
        t = np.clip((qx * ux + qy * uy) / uu, 0.0, 1.0)
        rx, ry = qx - t * ux, qy - t * uy
        d = np.hypot(rx, ry)
        g = np.where(d > 1e-9, np.hypot(rx * ce, ry) / np.maximum(d, 1e-9), 1.0)   # |grad d| per screen px
        cov = np.clip((hw - d) / g + 0.5, 0.0, 1.0)
        m = cov > 0
        np.maximum.at(out, py[m] * W + np.mod(px[m], W), cov[m].astype(np.float32))
        start = end
    return out.reshape(H, W)


# ---- graticule ------------------------------------------------------------------------------------------------
def make_grid(W, H, sphere=True, strip=256, step=15.0, minor=(0.75, 0.62), major=(1.25, 1.0), meridian_cut=75.0):
    p = 180.0 / H
    lon = (np.arange(W) + 0.5) * (360.0 / W) - 180.0
    near = np.round(lon / step) * step
    d_minor = np.where(np.mod(near, 90.0) == 0, 1e9, np.abs(lon - near))   # 15-deg family minus 0/90/180
    d_0 = np.abs(lon)
    d_90 = np.abs(np.abs(lon) - 90.0)
    d_180 = 180.0 - np.abs(lon)
    out = np.empty((H, W), np.float32)
    for y0 in range(0, H, strip):
        ys = np.arange(y0, min(H, y0 + strip))
        lat = 90.0 - (ys + 0.5) * p
        c = (np.maximum(np.cos(np.radians(lat)), 1e-6) if sphere else np.ones_like(lat))[:, None]

        def mer(d, hw, val):
            return val * np.clip(hw / c + 0.5 - d[None, :] / p, 0.0, 1.0)

        g = mer(d_0, *major)
        g = np.maximum(g, mer(d_90, *minor))
        g = np.maximum(g, mer(d_180, *minor))
        cut = np.clip((meridian_cut - np.abs(lat)) / p + 0.5, 0.0, 1.0)[:, None]
        g = np.maximum(g, mer(d_minor, *minor) * cut)
        nearp = np.round(lat / step) * step
        dp = np.abs(lat - nearp) / p
        hw = np.where(nearp == 0, major[0], minor[0])
        val = np.where(nearp == 0, major[1], minor[1])
        par = np.where(np.abs(nearp) < 90.0, val * np.clip(hw + 0.5 - dp, 0.0, 1.0), 0.0)
        out[y0:y0 + ys.size] = np.maximum(g, par[:, None])
    return out


# ---- dot-matrix land --------------------------------------------------------------------------------------------
def make_landdots(land, W, H, spacing=0.9, radius_frac=0.28, stagger=True, strip=256):
    nrows = int(round(180.0 / (spacing * math.sqrt(3.0) / 2.0)))     # hex rows: spacing*sqrt(3)/2 apart
    dlat = 180.0 / nrows
    rlat = -90.0 + dlat * (np.arange(nrows) + 0.5)
    n = np.maximum(1, np.round(360.0 * np.cos(np.radians(rlat)) / spacing)).astype(np.int64)
    off = np.where(stagger & (np.arange(nrows) % 2 == 1), 0.5, 0.0)
    first = np.concatenate([[0], np.cumsum(n)[:-1]])
    ri = np.repeat(np.arange(nrows), n)
    jj = np.arange(n.sum()) - first[ri]
    clon = -180.0 + (jj + 0.5 + off[ri]) * (360.0 / n[ri])
    clon = np.mod(clon + 180.0, 360.0) - 180.0
    clat = rlat[ri]
    ix = np.mod(np.floor((clon + 180.0) * (W / 360.0)).astype(np.int64), W)
    iy = np.clip(np.floor((90.0 - clat) * (H / 180.0)).astype(np.int64), 0, H - 1)
    is_land = land[iy, ix] >= 0.5
    r = radius_frac * spacing
    p = 180.0 / H
    lonp = (np.arange(W) + 0.5) * (360.0 / W) - 180.0
    out = np.empty((H, W), np.float32)
    for y0 in range(0, H, strip):
        ys = np.arange(y0, min(H, y0 + strip))
        latp = 90.0 - (ys + 0.5) * p
        fp = np.radians(latp)[:, None]
        cp = np.cos(fp)
        below = np.floor((latp - rlat[0]) / dlat).astype(np.int64)
        acc = np.zeros((ys.size, W), np.float32)
        for i in (np.clip(below, 0, nrows - 1), np.clip(below + 1, 0, nrows - 1)):   # the two bracketing rows
            ni, offi, latc = n[i][:, None], off[i][:, None], rlat[i][:, None]
            dl = 360.0 / ni
            jn = np.round((lonp[None, :] + 180.0) / dl - 0.5 - offi)        # nearest dot in that row
            lonc = -180.0 + (jn + 0.5 + offi) * dl
            dlon = np.mod(lonp[None, :] - lonc + 180.0, 360.0) - 180.0
            jn = np.mod(jn, ni).astype(np.int64)
            fc = np.radians(latc)
            hav = np.sin((fp - fc) / 2) ** 2 + cp * np.cos(fc) * np.sin(np.radians(dlon) / 2) ** 2
            d = np.degrees(2.0 * np.arcsin(np.sqrt(np.clip(hav, 0.0, 1.0))))   # great-circle distance, deg
            ex, ey = dlon * cp, latp[:, None] - latc
            dd = np.hypot(ex, ey)
            g = np.where(dd > 1e-12, p * np.hypot(ex * cp, ey) / np.maximum(dd, 1e-12), p)  # |grad d| per px
            cov = np.clip((r - d) / g + 0.5, 0.0, 1.0) * is_land[first[i][:, None] + jn]
            np.maximum(acc, cov, out=acc, casting="unsafe")
        out[y0:y0 + ys.size] = acc
    return out, int(is_land.sum()), int(n.sum())


# ---- night lights ---------------------------------------------------------------------------------------------
def make_lights(src, W, H, bg_blue, bg_cap, floor, gamma):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im)
    H0, W0 = a.shape[:2]
    L = np.empty((H0, W0), np.float32)
    for y0 in range(0, H0, 1024):
        s = a[y0:y0 + 1024].astype(np.float32)
        Y = 0.2126 * s[..., 0] + 0.7152 * s[..., 1] + 0.0722 * s[..., 2]
        L[y0:y0 + 1024] = np.maximum(Y - np.minimum(bg_blue * s[..., 2], bg_cap) - floor, 0.0)
    del a
    # area-average (BOX) downsample: conserves light and, unlike Lanczos, leaves no ringing halo round cities
    small = np.asarray(Image.fromarray(L).resize((W, H), Image.Resampling.BOX), dtype=np.float32)
    v = np.clip(small / (255.0 - bg_cap - floor), 0.0, 1.0)
    return (v ** gamma).astype(np.float32), (W0, H0)


# ---- io ---------------------------------------------------------------------------------------------------------
def save(arr, path, bits=8):
    path.parent.mkdir(parents=True, exist_ok=True)
    a = np.clip(arr, 0.0, 1.0)
    if bits == 16:
        Image.fromarray(np.round(a * 65535.0).astype(np.uint16)).save(path, compress_level=6)
    else:
        Image.fromarray(np.round(a * 255.0).astype(np.uint8)).save(path, compress_level=6)


def preview(arr, W, H, pool_max=False):
    """1024x512 preview. pool_max: mean over f/2 then max over 2x2, so sparse point lights stay readable."""
    f = W // 1024
    m = f // 2 if pool_max and f >= 2 else f
    a = arr[: (H // f) * f, : (W // f) * f].reshape(H // m, m, W // m, m).mean(axis=(1, 3))
    if m != f:
        k = f // m
        a = a.reshape(H // f, k, W // f, k).max(axis=(1, 3))
    return Image.fromarray(np.round(np.clip(a, 0, 1) * 255).astype(np.uint8))


def get_font(size):
    for name in ("arial.ttf", "segoeui.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def contact_sheet(items, path):
    cw, ch, lab, gap = 1024, 512, 34, 8
    sheet = Image.new("RGB", (2 * cw + 3 * gap, 3 * (ch + lab) + 4 * gap), (4, 6, 10))
    d = ImageDraw.Draw(sheet)
    font = get_font(20)
    for k, (title, im) in enumerate(items):
        col, row = k % 2, k // 2
        x = gap + col * (cw + gap)
        y = gap + row * (ch + lab + gap)
        d.text((x + 4, y + 6), title, fill=(125, 255, 166), font=font)
        sheet.paste(im.convert("RGB"), (x, y + lab))
        d.rectangle([x - 1, y + lab - 1, x + cw, y + lab + ch], outline=(24, 34, 48))
    sheet.save(path)


def write_checks(maps, W, H, out):
    """Zoomed QA crops: Mediterranean overlay, both dateline edges, Antarctica strip, polar grid, dot close-up."""
    ck = out / "check"
    ck.mkdir(parents=True, exist_ok=True)

    def px(lon, lat):
        x, y = to_px(np.float64(lon), np.float64(lat), W, H)
        return int(round(x)), int(round(y))

    def overlay(ys, xs, m=maps):
        z = lambda k: m[k][ys][:, xs] if k in m else 0.0
        land, li, co, bo = z("land"), z("lights"), z("coast"), z("borders")
        r = 0.09 * land + 1.00 * li
        g = 0.13 * land + 0.85 * li
        b = 0.19 * land + 0.55 * li
        for k, (cr, cg, cb) in (("borders", (0.71, 0.55, 1.0)), ("coast", (0.49, 1.0, 0.65))):
            a = z(k)
            r, g, b = r * (1 - a) + cr * a, g * (1 - a) + cg * a, b * (1 - a) + cb * a
        rgb = np.stack(np.broadcast_arrays(r, g, b), -1)
        return Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8))

    x0, y0 = px(-7, 47); x1, y1 = px(37, 29)
    overlay(slice(y0, y1), np.arange(x0, x1)).save(ck / "med_overlay.png")
    x0, y0 = px(9, 46); x1, y1 = px(20, 36)
    overlay(slice(y0, y1), np.arange(x0, x1)).resize(((x1 - x0) * 2, (y1 - y0) * 2), Image.NEAREST).save(ck / "italy_overlay_2x.png")
    # dateline: right edge then left edge, so the seam is in the middle of the crop
    for name, (la, lb, w) in {"dateline_chukotka": (75, 62, 14), "dateline_fiji": (-15.5, -19.5, 3)}.items():
        _, ya = px(0, la); _, yb = px(0, lb)
        cols = np.concatenate([np.arange(W - int(w / 360 * W), W), np.arange(0, int(w / 360 * W))])
        im = overlay(slice(ya, yb), cols)
        if "fiji" in name:
            im = im.resize((im.width * 3, im.height * 3), Image.NEAREST)
        im.save(ck / f"{name}.png")
    _, ya = px(0, -60)
    overlay(slice(ya, H), np.arange(W)).reduce(4).save(ck / "antarctica_strip.png")
    if "grid" in maps:
        g = maps["grid"][: H // 12]
        Image.fromarray(np.round(g * 255).astype(np.uint8)).reduce(4).save(ck / "grid_north.png")
    if "landdots" in maps:
        for name, (lo, la, lo2, la2) in {"dots_europe": (-12, 62, 32, 36), "dots_greenland": (-75, 84, -10, 58)}.items():
            x0, y0 = px(lo, la); x1, y1 = px(lo2, la2)
            dd = maps["landdots"][y0:y1, x0:x1]
            ln = maps["land"][y0:y1, x0:x1]
            rgb = np.stack([0.15 * ln + 0.85 * dd, 0.2 * ln + dd, 0.25 * ln + 0.7 * dd], -1)
            Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(ck / f"{name}.png")
    # whole-world overlay at 2k
    f = W // 2048
    small = {k: v.reshape(H // f, f, W // f, f).mean(axis=(1, 3)) for k, v in maps.items() if k in ("land", "lights", "coast", "borders")}
    overlay(slice(0, H // f), np.arange(W // f), small).save(ck / "world_overlay_2k.png")
    # orthographic globe views: dots should look round and line widths even once wrapped on the sphere
    def ortho(lon0, lat0, size=900):
        u = (np.arange(size) + 0.5) / size * 2 - 1
        X, Y = np.meshgrid(u, -u)
        rho2 = X * X + Y * Y
        vis = rho2 <= 1
        Z = np.sqrt(np.clip(1 - rho2, 0, 1))
        p0, l0 = math.radians(lat0), math.radians(lon0)
        lat = np.arcsin(np.clip(Z * math.sin(p0) + Y * math.cos(p0), -1, 1))
        lon = l0 + np.arctan2(X, Z * math.cos(p0) - Y * math.sin(p0))
        ix = np.mod(np.floor((np.degrees(lon) + 180) / 360 * W).astype(np.int64), W)
        iy = np.clip(np.floor((90 - np.degrees(lat)) / 180 * H).astype(np.int64), 0, H - 1)
        z = lambda k: np.where(vis, maps[k][iy, ix], 0.0) if k in maps else 0.0
        land, dots, grid, coast, lit = z("land"), z("landdots"), z("grid"), z("coast"), z("lights")
        r = 0.03 * vis + 0.06 * land + 0.35 * grid + 0.49 * np.maximum(dots * 0.6, coast) + lit
        g = 0.04 * vis + 0.09 * land + 0.35 * grid + 1.00 * np.maximum(dots * 0.6, coast) + 0.85 * lit
        b = 0.07 * vis + 0.13 * land + 0.40 * grid + 0.65 * np.maximum(dots * 0.6, coast) + 0.55 * lit
        rgb = np.stack(np.broadcast_arrays(r, g, b), -1)
        return Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8))

    for name, (lo, la) in {"europe": (12, 48), "greenland": (-40, 72), "south_pole": (30, -75), "dateline": (180, 60)}.items():
        ortho(lo, la).save(ck / f"globe_{name}.png")

    if "land" in maps:
        # registration: Black Marble's own land/sea edge (ocean is ~(5,5,15)) vs our mask, 60S..75N, shifts +-2 px
        rgb = Image.open(DEFAULT_SRC_JPG[0]).convert("RGB").resize((W, H), Image.Resampling.BOX)
        bm = np.asarray(rgb)[..., 2] > 19
        ys = slice(int(15 / 180 * H), int(150 / 180 * H))
        L, B = maps["land"][ys] >= 0.5, bm[ys]
        scores = sorted(((L == np.roll(B, (dy, dx), (0, 1))).mean(), dx, dy) for dx in range(-2, 3) for dy in range(-2, 3))
        sc, dx, dy = scores[-1]
        log(f"  registration vs Black Marble land/sea: best shift dx={dx} dy={dy} px ({sc * 100:.2f}% agree, "
            f"unshifted {[s for s in scores if s[1] == 0 and s[2] == 0][0][0] * 100:.2f}%)")
    log(f"  checks -> {ck}")


# ---- main -------------------------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--width", type=int, default=8192, help="output width (height = width/2), multiple of 1024")
    ap.add_argument("--only", default=",".join(ALL), help="comma list of: " + ",".join(ALL))
    ap.add_argument("--line-mode", choices=["sphere", "flat"], default="sphere")
    ap.add_argument("--checks", action="store_true", help="also write zoomed QA crops to <out>/check")
    args = ap.parse_args(argv)

    W = args.width
    H = W // 2
    if W % 1024:
        ap.error("--width must be a multiple of 1024")
    want = [w.strip() for w in args.only.split(",") if w.strip()]
    bad = set(want) - set(ALL)
    if bad:
        ap.error(f"unknown outputs: {sorted(bad)}")
    sphere = args.line_mode == "sphere"
    DEFAULT_SRC_JPG[0] = args.src / "BlackMarble_2016_3km.jpg"
    tag = f"{W // 1024}k"
    out = args.out
    (out / "preview").mkdir(parents=True, exist_ok=True)
    log(f"open-overwatch textures {W}x{H} -> {out}  (lines: {args.line_mode})")

    maps = {}
    t_all = time.time()

    if "lights" in want:
        t = time.time()
        maps["lights"], (w0, h0) = make_lights(args.src / "BlackMarble_2016_3km.jpg", W, H, **LIGHTS)
        lit = maps["lights"]
        log(f"lights: source {w0}x{h0}; >0: {np.mean(lit > 0) * 100:.1f}% px, >=0.999: {np.mean(lit >= 0.999) * 100:.3f}% px "
            f"({time.time() - t:.1f}s)")

    need_land = "land" in want or "landdots" in want or "coast" in want
    if need_land:
        topo_land, arcs_land = load_topology(args.src / "land-50m.json")
        land_polys = polygons(topo_land["objects"]["land"])
    if "land" in want or "landdots" in want:
        t = time.time()
        edges, polar = fill_edges(arcs_land, land_polys, W, H)
        maps["land"] = raster_fill(edges, W, H)
        lat = 90.0 - (np.arange(H) + 0.5) * (180.0 / H)
        wts = np.cos(np.radians(lat))
        frac = float((maps["land"].mean(axis=1) * wts).sum() / wts.sum())
        log(f"land: {len(land_polys)} polygons, {polar} polar rings, {edges[0].size} edges; "
            f"area-weighted land fraction {frac:.4f} (Earth ~0.29); bottom row {maps['land'][-1].mean():.3f}, "
            f"top row {maps['land'][0].mean():.3f} ({time.time() - t:.1f}s)")

    if "coast" in want:
        t = time.time()
        rings = [ring_coords(arcs_land, idx) for poly in land_polys for idx in poly]
        segs = line_segments(rings, drop_artificial=True)
        maps["coast"] = raster_lines(segs, W, H, COAST_HALF_WIDTH, sphere=sphere)
        log(f"coast: {segs[0].size} segments ({time.time() - t:.1f}s)")

    if "borders" in want:
        t = time.time()
        topo_c, arcs_c = load_topology(args.src / "countries-50m.json")
        owners = {}
        for fi, geom in enumerate(topo_c["objects"]["countries"]["geometries"]):
            for poly in polygons(geom):
                for ring in poly:
                    for i in ring:
                        owners.setdefault(i if i >= 0 else ~i, set()).add(fi)
        shared = sorted(a for a, s in owners.items() if len(s) >= 2)      # mesh(a, b => a !== b)
        segs = line_segments([arcs_c[a] for a in shared], drop_artificial=True)
        maps["borders"] = raster_lines(segs, W, H, BORDER_HALF_WIDTH, sphere=sphere)
        log(f"borders: {len(shared)} shared arcs of {len(arcs_c)}, {segs[0].size} segments ({time.time() - t:.1f}s)")

    if "grid" in want:
        t = time.time()
        maps["grid"] = make_grid(W, H, sphere=sphere, **GRID)
        log(f"grid ({time.time() - t:.1f}s)")

    if "landdots" in want:
        t = time.time()
        maps["landdots"], n_on, n_all = make_landdots(maps["land"], W, H, **DOTS)
        log(f"landdots: {n_on} land dots of {n_all} lattice points ({time.time() - t:.1f}s)")

    titles = {
        "lights": "lights_{t}.png - night lights, 16-bit (Black Marble 2016; preview max-pooled)",
        "land": "land_{t}.png - land mask (Natural Earth 1:50m)",
        "coast": "coast_{t}.png - coastlines ~3 px",
        "borders": "borders_{t}.png - country borders ~2 px",
        "grid": "grid_{t}.png - 15 deg graticule",
        "landdots": "landdots_{t}.png - dot-matrix land, 0.9 deg",
    }
    sheet_items = []
    for name in ALL:
        if name in maps and name in want:
            t = time.time()
            p = out / f"{name}_{tag}.png"
            save(maps[name], p, bits=16 if name == "lights" else 8)
            pv = preview(maps[name], W, H, pool_max=(name == "lights"))
            pv.save(out / "preview" / f"{name}_{tag}.png")
            sheet_items.append((titles[name].format(t=tag), pv))
            log(f"  wrote {p.name} ({p.stat().st_size / 1e6:.1f} MB, {time.time() - t:.1f}s)")
    if sheet_items:
        contact_sheet(sheet_items, out / "preview" / "sheet.png")
        log(f"  wrote preview/sheet.png")
    if args.checks:
        write_checks(maps, W, H, out)
    log(f"done in {time.time() - t_all:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
