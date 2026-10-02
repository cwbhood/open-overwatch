"""Open Overwatch satellite fleet: six real-world spacecraft models for the CesiumJS globe.

Builds starlink / gnss / geo / weather / smallsat / rocketbody and exports each as a GLB to brand/models/.

Run (headless, Blender 5.2):
    "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\blender-launcher.exe" -b --factory-startup ^
        --python brand/tools/sat_models_fleet.py -- [model ...]
No model names = all six. Log: brand/tools/_fleet_build.log. Validate + preview with sat_models_check.py.

Conventions (the web app depends on these):
  meters; +X = ram (flight direction), +Z = zenith, -Z = nadir (Earth), Y = orbit normal; origin = bus centre.
  One root empty named after the model (identity transform); a body mesh `<name>_body` parented to it;
  sun-tracking arrays are separate meshes `solar_1`, `solar_2` with identity rotation/scale, origin on the
  rotation axis (parallel to Y), cells facing +Z at rest.
  Materials are plain Principled BSDF + image textures (generated here with numpy, embedded in the GLB).

Modelling approach: every part is a small mesh object (box/cylinder/lathe/sweep) with a Bevel + WeightedNormal
stack (or smooth-by-angle), and merge() bakes the evaluated parts into one mesh per node, carrying over the
corner normals as custom normals and writing box-projected UVs in meters per material tile size.
"""
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, Matrix, Euler, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bl_common as bc
from bl_common import log

OUT_DIR = os.path.normpath(os.path.join(HERE, '..', 'models'))
TEX_DIR = os.path.join(HERE, '_fleet_tex')
LOG = os.path.join(HERE, '_fleet_build.log')

TAU = math.tau
D2R = math.pi / 180

# ----------------------------------------------------------------------------------------------------------
# textures (numpy -> PNG/JPEG on disk -> loaded, so the glTF exporter embeds the encoded file as-is)
# ----------------------------------------------------------------------------------------------------------

def _band(n, lo, hi, rng):
    """Tileable band-limited noise, unit variance. lo/hi in cycles per tile."""
    f = np.fft.fftfreq(n) * n
    fx, fy = np.meshgrid(f, f)
    k = np.hypot(fx, fy)
    mid, wid = (lo + hi) / 2, max((hi - lo) / 2, 0.5)
    filt = np.exp(-((k - mid) / wid) ** 2)
    r = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((n, n))) * filt))
    return (r - r.mean()) / (r.std() + 1e-9)


def _voronoi(n, npts, rng, stretch=1.0):
    """Tileable Voronoi cell ids (n x n) for npts random sites; stretch > 1 elongates cells along x."""
    pts = rng.uniform(0, n, (npts, 2))
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    best = np.full((n, n), 1e9, np.float32)
    cid = np.zeros((n, n), np.int32)
    for i, (px, py) in enumerate(pts):
        dx = np.abs(x - px)
        dx = np.minimum(dx, n - dx) / stretch
        dy = np.abs(y - py)
        dy = np.minimum(dy, n - dy)
        d = dx * dx + dy * dy
        m = d < best
        best[m] = d[m]
        cid[m] = i
    return cid


def _save(name, rgb, fmt='PNG', noncolor=False):
    os.makedirs(TEX_DIR, exist_ok=True)
    h, w, _ = rgb.shape
    ext = '.png' if fmt == 'PNG' else '.jpg'
    path = os.path.join(TEX_DIR, name + ext)
    img = bpy.data.images.new(name + '_gen', w, h, alpha=False)
    rgba = np.concatenate([np.clip(rgb, 0, 1), np.ones((h, w, 1))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = fmt
    img.save(filepath=path, quality=92)
    bpy.data.images.remove(img)
    out = bpy.data.images.load(path, check_existing=False)
    out.name = name
    if noncolor:
        out.colorspace_settings.name = 'Non-Color'
    return out


def make_textures():
    rng = np.random.default_rng(7)
    T = {}
    # --- crinkled MLI foil: ridged multi-band height field -> normal map + tinted colour maps
    n = 256
    tilt = np.zeros((n, n, 2))
    shade = np.zeros((n, n))
    for npts, amp, stretch in ((40, 0.15, 1.5), (140, 0.10, 1.3), (480, 0.05, 1.0)):
        cid = _voronoi(n, npts, rng, stretch)
        t = rng.normal(0, amp, (npts, 2))
        tilt += t[cid]
        shade += rng.normal(0, 1, npts)[cid] * amp
    # soften the crease edges by one pixel so the facets do not alias
    tilt = (tilt * 4 + np.roll(tilt, 1, 0) + np.roll(tilt, -1, 0) + np.roll(tilt, 1, 1) + np.roll(tilt, -1, 1)) / 8
    nrm = np.concatenate([tilt, np.ones((n, n, 1))], 2)
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    T['foil_n'] = _save('foil_n', nrm * 0.5 + 0.5, 'JPEG', noncolor=True)
    h = (shade - shade.mean()) / shade.std()
    v = np.clip(1 + 0.12 * h, 0.7, 1.3)[..., None]
    gold = np.array([200, 150, 46]) / 255
    T['foil_gold'] = _save('foil_gold', np.stack([gold[0] * v[..., 0], gold[1] * v[..., 0] ** 1.12,
                                                  gold[2] * v[..., 0] ** 1.35], 2), 'JPEG')
    silver = np.array([217, 221, 226]) / 255
    T['foil_silver'] = _save('foil_silver', silver * np.clip(1 + 0.07 * h, 0.8, 1.2)[..., None], 'JPEG')

    # --- solar cells: 8 x 8 cells per tile, deep blue, silver gaps, busbars, clipped corners
    n, cells = 512, 8
    cs = n // cells
    y, x = np.mgrid[0:n, 0:n]
    cx, cy, ix, iy = x % cs, y % cs, x // cs, y // cs
    base = np.array([13, 26, 58]) / 255
    tint = 1 + 0.07 * rng.standard_normal((cells, cells))
    img = base[None, None, :] * tint[iy, ix][..., None]
    img = img * (1 + 0.10 * ((cy % 4) == 0))[..., None]                       # fine fingers
    bus = (cx == cs // 3) | (cx == 2 * cs // 3)
    img[bus] = [0.30, 0.34, 0.42]
    m = cs - 1
    clip = (cx + cy < 8) | ((m - cx) + cy < 8) | (cx + (m - cy) < 8) | ((m - cx) + (m - cy) < 8)
    img[clip] = [0.50, 0.53, 0.58]
    gap = (cx < 2) | (cy < 2)
    img[gap] = [0.66, 0.69, 0.74]
    T['cells'] = _save('cells', img, 'PNG')

    # --- OSR radiator tiles
    n, k = 256, 8
    cs = n // k
    y, x = np.mgrid[0:n, 0:n]
    tint = 1 + 0.018 * rng.standard_normal((k, k))
    c = np.array([232, 235, 238]) / 255
    img = c[None, None, :] * tint[y // cs, x // cs][..., None]
    img[(x % cs == 0) | (y % cs == 0)] = [0.62, 0.66, 0.70]
    T['osr'] = _save('osr', img, 'PNG')

    # --- phased-array face (Starlink): light grey plate with square radiating elements
    n, k = 256, 16
    cs = n // k
    y, x = np.mgrid[0:n, 0:n]
    img = np.ones((n, n, 3)) * (np.array([206, 210, 215]) / 255)
    cx, cy = x % cs, y % cs
    el = (cx >= 4) & (cx < 12) & (cy >= 4) & (cy < 12)
    img[el] = np.array([150, 156, 165]) / 255
    img[(cx == 0) | (cy == 0)] = np.array([185, 190, 196]) / 255
    T['phased'] = _save('phased', img, 'PNG')

    # --- rocket skin (off-white, low-frequency grime) and foam insulation
    n = 256
    g = 0.6 * _band(n, 1, 4, rng) + 0.4 * _band(n, 6, 14, rng)
    streak = _band(n, 2, 8, rng)
    streak = np.repeat(streak[:, :1], n, axis=1) * 0.5 + 0.5 * streak   # longitudinal streaking
    c = np.array([224, 227, 229]) / 255
    T['skin'] = _save('skin', c * np.clip(1 + 0.018 * g - 0.015 * np.clip(streak, 0, None), 0.9, 1.05)[..., None],
                      'JPEG')
    b = _band(n, 3, 10, rng)
    fine = _band(n, 40, 90, rng)
    a = np.array([186, 104, 38]) / 255
    d = np.array([150, 80, 30]) / 255
    t = np.clip(0.5 + 0.22 * b, 0, 1)[..., None]
    T['foam'] = _save('foam', (a * (1 - t) + d * t) * np.clip(1 + 0.06 * fine, 0.85, 1.15)[..., None], 'JPEG')
    return T


# ----------------------------------------------------------------------------------------------------------
# materials
# ----------------------------------------------------------------------------------------------------------
M = {}


def pmat(name, col, metal=0.0, rough=0.5, tex=None, ntex=None, nstr=0.6, tile=1.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None) or nt.nodes.new('ShaderNodeBsdfPrincipled')
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None) or nt.nodes.new('ShaderNodeOutputMaterial')
    if not out.inputs['Surface'].is_linked:
        nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = bc.hex_rgba(col)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    m.diffuse_color = bc.hex_rgba(col)
    m.metallic, m.roughness = metal, rough
    if tex is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image, t.extension, t.interpolation = tex, 'REPEAT', 'Linear'
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if ntex is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image, t.extension, t.interpolation = ntex, 'REPEAT', 'Linear'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = nstr
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    m['tile'] = tile
    M[name] = m
    return m


def make_materials(T):
    M.clear()
    pmat('mli_gold', '#c8962e', 1.0, 0.35, T['foil_gold'], T['foil_n'], 0.55, tile=1.0)
    pmat('mli_silver', '#d9dde2', 0.9, 0.30, T['foil_silver'], T['foil_n'], 0.45, tile=1.0)
    pmat('radiator', '#e8ebee', 0.0, 0.38, T['osr'], tile=0.4)
    pmat('solar_cells', '#0d1a3a', 0.3, 0.25, T['cells'], tile=0.5)
    pmat('panel_back', '#3a3f46', 0.2, 0.6)
    pmat('structure', '#20252b', 0.5, 0.5)
    pmat('aluminium', '#b9c0c8', 1.0, 0.32)
    pmat('white_paint', '#e8ebee', 0.0, 0.55)
    pmat('black_kapton', '#0e1013', 0.0, 0.55)
    pmat('glass', '#0b1426', 0.0, 0.05)
    pmat('copper', '#c27a3c', 1.0, 0.30)
    pmat('ceramic', '#d9d3c7', 0.0, 0.7)
    pmat('dish_white', '#f1f0ea', 0.0, 0.6)
    pmat('dish_gold', '#c8962e', 1.0, 0.42, T['foil_gold'], T['foil_n'], 0.25, tile=0.9)
    pmat('dish_back', '#2c3036', 0.3, 0.55)
    pmat('nozzle', '#55585e', 1.0, 0.42)
    pmat('mli_black', '#17191d', 0.0, 0.42, None, T['foil_n'], 0.5, tile=1.0)
    pmat('niobium', '#6f7686', 1.0, 0.35)
    pmat('skin', '#e0e3e5', 0.0, 0.6, T['skin'], tile=2.4)
    pmat('skin_grey', '#8d949b', 0.2, 0.55)
    pmat('foam', '#b5651d', 0.0, 0.85, T['foam'], tile=1.2)
    pmat('phased_array', '#cfd3d8', 0.0, 0.5, T['phased'], tile=0.4)


# ----------------------------------------------------------------------------------------------------------
# part primitives (each part = one object, one material)
# ----------------------------------------------------------------------------------------------------------
PARTS = []          # parts created since the last take()


def _rot(dir=None, rot=None, spin=0.0):
    R = Matrix.Identity(3)
    if dir is not None:
        d = Vector(dir).normalized()
        R = Vector((0, 0, 1)).rotation_difference(d).to_matrix()
    if spin:
        R = R @ Matrix.Rotation(spin, 3, 'Z')
    if rot is not None:
        R = Euler(rot).to_matrix() @ R
    return R


def _obj(name, bm, mat, loc=(0, 0, 0), R=None, mode='bevel', bev=0.01, segs=2, uvl=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = Matrix.Translation(Vector(loc)) @ (R or Matrix.Identity(3)).to_4x4()
    me.materials.append(M[mat])
    if mode == 'flat':
        me.shade_flat()
    else:
        me.shade_smooth()
        if mode == 'bevel' and bev > 0:
            b = ob.modifiers.new('bevel', 'BEVEL')
            b.width, b.segments, b.limit_method, b.angle_limit = bev, segs, 'ANGLE', 30 * D2R
            w = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
            w.mode, w.weight, w.keep_sharp = 'FACE_AREA', 80, True
        else:
            me.set_sharp_from_angle(angle=40 * D2R)
    if uvl:
        ob['uvl'] = uvl
    PARTS.append(ob)
    return ob


def box(size, loc=(0, 0, 0), mat='structure', rot=None, bev=None, dir=None, spin=0.0, uvl=None, mode='bevel',
        segs=None, drop_bottom=False):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if drop_bottom:
        bm.normal_update()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z < -0.9], context='FACES_ONLY')
    if bev is None:
        bev = min(0.02, 0.12 * min(size))
    bev = min(bev, 0.3 * min(size))
    if segs is None:
        segs = 2 if min(size) > 0.15 else 1
    return _obj('box', bm, mat, loc, _rot(dir, rot, spin), mode, bev, segs, uvl=uvl)


def cyl(r, h, loc=(0, 0, 0), mat='structure', dir=(0, 0, 1), segs=24, r2=None, bev=None, rot=None, spin=0.0,
        mode='bevel'):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r,
                          radius2=r if r2 is None else r2, depth=h)
    if bev is None:
        bev = min(0.015, 0.1 * min(r, h))
    return _obj('cyl', bm, mat, loc, _rot(dir, rot, spin), mode, bev, 2 if min(r, h) > 0.15 else 1)


def lathe(profile, loc=(0, 0, 0), mat='structure', dir=(0, 0, 1), segs=32, spin=0.0, mode='auto', a0=0.0, a1=None):
    """Revolve [(r, z), ...] around local Z. Outward normal = profile direction rotated (dz, -dr)."""
    bm = bmesh.new()
    full = a1 is None
    n = segs if full else segs + 1
    rings = []
    for r, z in profile:
        if r < 1e-7:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            ring = []
            for i in range(n):
                a = (a0 + TAU * i / segs) if full else (a0 + (a1 - a0) * i / segs)
                ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
            rings.append(ring)
    for A, B in zip(rings, rings[1:]):
        if len(A) == 1 and len(B) == 1:
            continue
        rng_ = range(segs)
        for i in rng_:
            j = (i + 1) % n if full else i + 1
            if len(A) == 1:
                bm.faces.new((A[0], B[j], B[i]))
            elif len(B) == 1:
                bm.faces.new((A[i], A[j], B[0]))
            else:
                bm.faces.new((A[i], A[j], B[j], B[i]))
    return _obj('lathe', bm, mat, loc, _rot(dir, None, spin), mode)


def sweep(pts, r, mat='structure', segs=6, closed=False, caps=True):
    """Tube along a polyline (world coordinates)."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    tans = []
    for i in range(n):
        if closed:
            t = pts[(i + 1) % n] - pts[i - 1]
        else:
            t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        tans.append(t.normalized())
    ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
    nrm = (ref - ref.dot(tans[0]) * tans[0]).normalized()
    bm = bmesh.new()
    rings = []
    for i in range(n):
        t = tans[i]
        nrm = (nrm - nrm.dot(t) * t).normalized()
        b = t.cross(nrm)
        rings.append([bm.verts.new(pts[i] + r * (math.cos(TAU * k / segs) * nrm + math.sin(TAU * k / segs) * b))
                      for k in range(segs)])
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    for A, B in pairs:
        for k in range(segs):
            q = (k + 1) % segs
            bm.faces.new((A[k], A[q], B[q], B[k]))
    if caps and not closed:
        bm.faces.new(rings[0])
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _obj('sweep', bm, mat, (0, 0, 0), None, 'auto')


def tube(p1, p2, r, mat='aluminium', segs=10, bev=None):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    return cyl(r, d.length, (p1 + p2) / 2, mat, dir=d, segs=segs, bev=bev if bev is not None else 0.0)


def helix(R, pitch, turns, wire, loc, dir=(0, 0, 1), mat='copper', per_turn=12, segs=5):
    Rm = _rot(dir)
    pts = []
    N = int(turns * per_turn)
    for i in range(N + 1):
        a = TAU * turns * i / N
        pts.append(Vector(loc) + Rm @ Vector((R * math.cos(a), R * math.sin(a), pitch * turns * i / N)))
    return sweep(pts, wire, mat, segs)


def cyl_patch(r, t, a0, a1, z0, z1, mat, loc=(0, 0, 0), dir=(0, 0, 1), nseg=10):
    """Curved patch (shell segment) of thickness t outside radius r, angles a0..a1, axial z0..z1."""
    bm = bmesh.new()
    rows = []
    for rr in (r, r + t):
        row = []
        for z in (z0, z1):
            row.append([bm.verts.new((rr * math.cos(a0 + (a1 - a0) * i / nseg),
                                      rr * math.sin(a0 + (a1 - a0) * i / nseg), z)) for i in range(nseg + 1)])
        rows.append(row)
    (i0, i1), (o0, o1) = rows
    for i in range(nseg):
        bm.faces.new((o0[i], o0[i + 1], o1[i + 1], o1[i]))
        bm.faces.new((i0[i], i1[i], i1[i + 1], i0[i + 1]))
        bm.faces.new((i0[i], i0[i + 1], o0[i + 1], o0[i]))
        bm.faces.new((i1[i], o1[i], o1[i + 1], i1[i + 1]))
    for k in (0, nseg):
        bm.faces.new((i0[k], o0[k], o1[k], i1[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = _obj('patch', bm, mat, loc, _rot(dir), 'bevel', min(0.004, t * 0.3), 1)
    return ob


# ---- composite parts ----------------------------------------------------------------------------------------

def dish(D, f, loc, dir, front='dish_white', back='dish_back', segs=40, rings=8, t=0.03, rim=0.02):
    """Paraboloid reflector, concave side facing `dir`, `loc` = vertex (centre of the dish surface)."""
    R = D / 2
    rs = [R * (i / rings) ** 0.8 for i in range(rings + 1)]
    prof_front = [(r, r * r / (4 * f)) for r in reversed(rs)]
    lathe(prof_front, loc, front, dir, segs)
    zr = R * R / (4 * f)
    prof_back = [(0, -t)] + [(r, r * r / (4 * f) - t) for r in rs[2::2]] + [(R + rim, zr - t * 0.5), (R + rim, zr),
                                                                        (R, zr + 0.002)]
    lathe(prof_back, loc, back, dir, segs)
    # stiffening ring + hub on the back
    lathe([(R * 0.55, (R * 0.55) ** 2 / (4 * f) - t), (R * 0.56, (R * 0.55) ** 2 / (4 * f) - t - 0.05),
           (R * 0.62, (R * 0.62) ** 2 / (4 * f) - t - 0.05), (R * 0.63, (R * 0.62) ** 2 / (4 * f) - t)],
          loc, back, dir, segs)
    d = Vector(dir).normalized()
    cyl(R * 0.12, 0.12, Vector(loc) - d * (t + 0.05), back, dir=d, segs=16)


def horn(loc, dir, r0=0.03, r1=0.09, L=0.3, mat='mli_gold', inner='black_kapton', segs=16):
    """Conical feed horn, mouth at loc+dir*L."""
    t = max(0.004, 0.06 * r1)
    lathe([(0, -0.04), (r0 * 0.9, -0.04), (r0 + t, 0.0), (r1 + t, L), (r1, L)], loc, mat, dir, segs)
    lathe([(r1, L), (r0, 0.02), (0, 0.02)], loc, inner, dir, segs)


def nozzle(loc, dir, rt, re, L, mat='nozzle', inner='black_kapton', segs=24, chamber=None, steps=None):
    """Bell nozzle: throat at loc, exit at loc+dir*L. chamber=(radius, length) adds a combustion chamber."""
    prof = []
    if chamber:
        cr, cl = chamber
        prof += [(0, -cl - 0.02), (cr * 0.8, -cl - 0.02), (cr, -cl), (cr, -cl * 0.35)]
    st = steps or (6 if re > 0.1 else 3)
    prof += [(rt * 1.15, 0.0)]
    for i in range(1, st + 1):
        s = i / st
        prof.append((rt + (re - rt) * (s ** 0.75), L * s))
    th = max(0.004, 0.015 * re)
    prof = [(r + (th if k >= len(prof) - st - 1 else 0), z) for k, (r, z) in enumerate(prof)]
    prof += [(re, L)]
    lathe(prof, loc, mat, dir, segs)
    inn = [(re, L)]
    for i in range(st - 1, -1, -1):
        s = i / st
        inn.append((rt + (re - rt) * (s ** 0.75) - (0 if i else 0.2 * rt), L * s + 0.004))
    inn.append((0, 0.01))
    lathe(inn, loc, inner, dir, segs)


def shell(P, loc, mat, dir, segs=32, t=0.012):
    """Open cup/cone of wall thickness t from an outer profile P (r, z) running outward/upward."""
    prof = [(0, P[0][1])] + list(P) + [(P[-1][0] - t, P[-1][1])]
    prof += [(max(r - t, 0.001), z + t * 0.7) for r, z in reversed(P[1:-1])]
    prof += [(max(P[0][0] - t, 0.001), P[0][1] + t), (0, P[0][1] + t)]
    return lathe(prof, loc, mat, dir, segs)


def star_tracker(loc, dir, s=1.0, body='aluminium'):
    d = Vector(dir).normalized()
    box((0.10 * s, 0.10 * s, 0.08 * s), loc, body, dir=d)
    p = Vector(loc) + d * 0.04 * s
    lathe([(0.034 * s, -0.005), (0.048 * s, 0.11 * s), (0.044 * s, 0.112 * s), (0.03 * s, 0.0)], p, 'black_kapton', d, 20)
    lathe([(0.03 * s, 0.003), (0, 0.003)], p, 'glass', d, 20)


def omni(loc, dir=(0, 0, 1), L=0.35, mat='white_paint'):
    d = Vector(dir).normalized()
    tube(loc, Vector(loc) + d * L, 0.012, 'aluminium')
    p = Vector(loc) + d * L
    lathe([(0, 0), (0.06, 0.05), (0.06, 0.055), (0, 0.11)], p, mat, d, 16)


def panel_set(rects, z, thick=0.03, frame=0.035, cell='solar_cells', back='panel_back'):
    """Flat solar panels: rects = [(cx, cy, w_x, l_y)], cells on +Z."""
    for cx, cy, w, l in rects:
        box((w, l, thick), (cx, cy, z), back, bev=0.006)
        cw, cl = w - 2 * frame, l - 2 * frame
        nu, nv = max(1, round(cw / 0.5)), max(1, round(cl / 0.5))
        box((cw, cl, 0.004), (cx, cy, z + thick / 2 + 0.0015), cell, uvl=(nu / cw, nv / cl), mode='flat',
            drop_bottom=True)


def wing(hinge, side, yoke_len, rects, z=None, yoke_w=None, sada_r=0.11, yoke_r=0.03):
    """Generic sun-tracking wing. hinge = SADA output on the bus face; rects are panel rectangles
    [(cx, dy_from_yoke_end, w_x, l_y)] measured along the wing (dy >= 0). Returns parts list."""
    hx, hy, hz = hinge
    s = side
    cyl(sada_r, 0.10, (hx, hy + s * 0.05, hz), 'aluminium', dir=(0, 1, 0), segs=20)
    cyl(sada_r * 0.55, 0.06, (hx, hy + s * 0.13, hz), 'structure', dir=(0, 1, 0), segs=16)
    y0 = hy + s * yoke_len
    yw = yoke_w if yoke_w is not None else max(r[2] for r in rects) * 0.7
    root = Vector((hx, hy + s * 0.16, hz))
    tube(root, (hx + yw / 2, y0, hz), yoke_r, 'aluminium')
    tube(root, (hx - yw / 2, y0, hz), yoke_r, 'aluminium')
    tube((hx - yw / 2, y0, hz), (hx + yw / 2, y0, hz), yoke_r * 0.8, 'aluminium')
    tube((hx, hy + s * 0.16, hz), (hx, y0, hz), yoke_r * 0.7, 'aluminium')
    out = []
    for cx, dy, w, l in rects:
        out.append((hx + cx, y0 + s * (dy + l / 2), w, l))
    panel_set(out, hz)
    # hinge brackets between consecutive panels (along the wing)
    ys = sorted(set(round(dy, 4) for _, dy, _, _ in rects))
    for dy in ys[1:]:
        for cx in {r[0] for r in rects}:
            w = max(r[2] for r in rects if r[0] == cx)
            for xo in (-w * 0.32, w * 0.32):
                cyl(0.018, 0.10, (hx + cx + xo, y0 + s * (dy - 0.02), hz - 0.02), 'aluminium', dir=(0, 1, 0), segs=10)
    # yoke-to-panel brackets
    for xo in (-yw / 2, yw / 2):
        box((0.06, 0.08, 0.05), (hx + xo, y0 + s * 0.02, hz - 0.01), 'aluminium')


# ----------------------------------------------------------------------------------------------------------
# merge parts into one mesh node
# ----------------------------------------------------------------------------------------------------------

PSTAT = []


def take():
    global PARTS
    p, PARTS = PARTS, []
    return p


def merge(name, parts, origin=(0, 0, 0), parent=None):
    dg = bpy.context.evaluated_depsgraph_get()
    verts, faces, uvs, nors, mids, mats = [], [], [], [], [], []
    T = Matrix.Translation(-Vector(origin))
    for p in parts:
        pe = p.evaluated_get(dg)
        me = pe.to_mesh()
        Mw = T @ p.matrix_world
        N3 = Mw.to_3x3().inverted().transposed()
        base = len(verts)
        co = [Mw @ v.co for v in me.vertices]
        verts.extend(co)
        mat = p.data.materials[0]
        if mat not in mats:
            mats.append(mat)
        mi = mats.index(mat)
        tile = float(mat.get('tile', 1.0))
        cn = me.corner_normals
        uvl = p.get('uvl')
        if uvl:
            lx = [v.co.x for v in me.vertices]
            ly = [v.co.y for v in me.vertices]
            x0, y0 = min(lx), min(ly)
        loops = me.loops
        for poly in me.polygons:
            li = list(poly.loop_indices)
            vids = [loops[l].vertex_index for l in li]
            faces.append([base + v for v in vids])
            mids.append(mi)
            for l in li:
                nors.append((N3 @ cn[l].vector).normalized())
            if uvl:
                for v in vids:
                    c = me.vertices[v].co
                    uvs.append(((c.x - x0) * uvl[0], (c.y - y0) * uvl[1]))
            else:
                nw = N3 @ poly.normal
                ax = max(range(3), key=lambda k: abs(nw[k]))
                a, b = [(1, 2), (0, 2), (0, 1)][ax]
                sg = 1 if nw[ax] >= 0 else -1
                for v in vids:
                    c = co[v]
                    uvs.append((c[a] * sg / tile if ax != 2 else c[a] / tile, c[b] / tile))
        PSTAT.append((p.name.split('.')[0] + ':' + mat.name, sum(len(pp.vertices) - 2 for pp in me.polygons)))
        pe.to_mesh_clear()
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set('material_index', mids)
    uvl_ = me.uv_layers.new(name='UVMap')
    uvl_.data.foreach_set('uv', [c for uv in uvs for c in uv])
    me.shade_smooth()
    me.normals_split_custom_set([tuple(n) for n in nors])
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    ob.location = Vector(origin)
    for p in parts:
        md = p.data
        bpy.data.objects.remove(p, do_unlink=True)
        if md.users == 0:
            bpy.data.meshes.remove(md)
    ntri = sum(len(f) - 2 for f in faces)
    stats = {}
    for p_name, n in PSTAT:
        stats[p_name] = stats.get(p_name, 0) + n
    PSTAT.clear()
    log('    heavy:', sorted(stats.items(), key=lambda kv: -kv[1])[:8])
    log(f'  merged {name}: {len(parts)} parts, {len(verts)} verts, {ntri} tris, mats={[m.name for m in mats]}')
    return ob, ntri


def make_root(name):
    root = bpy.data.objects.new(name, None)
    root.empty_display_size = 1.0
    bpy.context.scene.collection.objects.link(root)
    return root


# ----------------------------------------------------------------------------------------------------------
# models
# ----------------------------------------------------------------------------------------------------------

def build_starlink():
    root = make_root('starlink')
    # chassis: dark flat-panel bus, silver top blanket, phased arrays on the nadir face
    box((2.8, 1.4, 0.20), (0, 0, 0.04), 'structure', bev=0.015)
    box((2.74, 1.34, 0.025), (0, 0, 0.152), 'mli_silver', bev=0.008)
    for x in (-1.2, 1.2):                                       # silver side-wall tape bands
        box((0.06, 1.402, 0.12), (x, 0, 0.04), 'mli_silver', bev=0.004)
    box((2.802, 0.08, 0.10), (0, 0.0, 0.04), 'mli_silver', bev=0.004)
    # 4 phased-array antennas
    for x in (-0.62, 0.62):
        for y in (-0.335, 0.335):
            box((1.0, 0.60, 0.035), (x, y, -0.077), 'structure', bev=0.006)
            box((0.96, 0.56, 0.006), (x, y, -0.097), 'phased_array', bev=0.002)
    # two gimbaled parabolic gateway antennas at the ends of the nadir face
    for x in (-1.26, 1.26):
        cyl(0.05, 0.10, (x, 0, -0.11), 'aluminium', segs=16)
        box((0.16, 0.05, 0.08), (x, 0, -0.18), 'aluminium')
        dish(0.26, 0.12, (x, 0, -0.30), (0, 0, -1), 'dish_white', 'dish_back', segs=28, rings=5, t=0.012, rim=0.006)
        tube((x, -0.1, -0.24), (x, 0, -0.38), 0.005, 'aluminium')
        tube((x, 0.1, -0.24), (x, 0, -0.38), 0.005, 'aluminium')
        cyl(0.012, 0.03, (x, 0, -0.39), 'ceramic', segs=10)
    # Krypton Hall-effect thruster on a gimbal bracket at the aft (-X) end, exhaust pointing -X
    box((0.06, 0.24, 0.16), (-1.43, 0.30, 0.03), 'aluminium')
    tx = -1.46
    d = Vector((-1, 0, 0))
    cyl(0.085, 0.09, (tx - 0.045, 0.30, 0.03), 'structure', dir=d, segs=24)
    lathe([(0.085, 0.0), (0.083, 0.012), (0.066, 0.012), (0.064, -0.006), (0.044, -0.006), (0.042, 0.012),
           (0.028, 0.012), (0.026, 0.0)], (tx - 0.09, 0.30, 0.03), 'ceramic', d, 32)
    lathe([(0.026, 0.0), (0.024, 0.016), (0, 0.018)], (tx - 0.09, 0.30, 0.03), 'nozzle', d, 24)
    tube((tx - 0.03, 0.40, 0.03), (tx - 0.13, 0.40, 0.03), 0.011, 'nozzle')
    cyl(0.016, 0.02, (tx - 0.14, 0.40, 0.03), 'ceramic', dir=d, segs=10)
    tube((-1.40, 0.42, -0.02), (tx - 0.03, 0.40, 0.0), 0.006, 'copper')
    # star trackers (navigation sensors) on top, canted off zenith
    star_tracker((1.12, -0.42, 0.20), (0.35, -0.4, 1.0), 0.9)
    star_tracker((1.12, 0.42, 0.20), (0.35, 0.4, 1.0), 0.9)
    # v1.5 optical inter-satellite link terminals
    for x, y in ((-0.9, -0.38), (-0.9, 0.38)):
        cyl(0.075, 0.05, (x, y, 0.19), 'aluminium', segs=24)
        lathe([(0.065, 0), (0.065, 0.02), (0.05, 0.06), (0.025, 0.08), (0, 0.085)], (x, y, 0.215), 'black_kapton',
              (0, 0, 1), 24)
        lathe([(0.022, 0.0), (0, 0.004)], (x + 0.035, y, 0.27), 'glass', (1, 0, 0.6), 16)
    # deployment hinge block for the array on the +Y edge
    box((0.26, 0.06, 0.16), (0, 0.70, 0.04), 'aluminium')
    body, n1 = merge('starlink_body', take(), (0, 0, 0), root)
    # single solar array on a short boom extending +Y; rotation axis = Y through (0, 0.73, 0.04)
    hinge = (0, 0.73, 0.04)
    cyl(0.07, 0.10, (0, 0.78, 0.04), 'aluminium', dir=(0, 1, 0), segs=20)
    tube((0, 0.83, 0.04), (0, 1.40, 0.04), 0.035, 'aluminium')
    box((2.2, 0.06, 0.05), (0, 1.40, 0.02), 'aluminium')
    tube((0, 0.85, 0.04), (1.0, 1.40, 0.02), 0.018, 'aluminium')
    tube((0, 0.85, 0.04), (-1.0, 1.40, 0.02), 0.018, 'aluminium')
    seg, gap, y = 1.33, 0.025, 1.43
    rects = []
    for i in range(6):
        rects.append((0, y + seg / 2, 2.8, seg))
        y += seg + gap
    panel_set(rects, 0.04, thick=0.025, frame=0.03)
    for i in range(1, 6):
        yy = 1.43 + i * (seg + gap) - gap / 2
        for x in (-0.9, 0.9):
            cyl(0.014, 0.08, (x, yy, 0.02), 'aluminium', dir=(0, 1, 0), segs=10)
    sol, n2 = merge('solar_1', take(), hinge, root)
    return root, n1 + n2


def build_gnss():
    root = make_root('gnss')
    W, Dp, H = 2.5, 2.0, 3.4
    box((W, Dp, H), (0, 0, 0), 'mli_gold', bev=0.03)
    # N/S radiators (OSR) flanking the SADA
    for s in (-1, 1):
        for zc in (-0.92, 0.92):
            box((2.3, 0.03, 1.4), (0, s * (Dp / 2 + 0.015), zc), 'radiator', bev=0.008)
        box((2.3, 0.03, 0.28), (0, s * (Dp / 2 + 0.015), 0), 'mli_silver', bev=0.006)
    # edge rails
    for x in (-W / 2, W / 2):
        for y in (-Dp / 2, Dp / 2):
            box((0.05, 0.05, H - 0.04), (x, y, 0), 'mli_silver', bev=0.01)
    # nadir (Earth) deck
    box((2.4, 1.9, 0.04), (0, 0, -H / 2 - 0.02), 'structure', bev=0.008)
    zc = -H / 2 - 0.04
    # L-band navigation antenna: ground plane + 12 helices (4 inner, 8 outer)
    lathe([(0, -0.07), (0.86, -0.07), (0.88, -0.05), (0.88, -0.02), (0.86, 0), (0, 0)], (0, 0, zc), 'aluminium',
          (0, 0, 1), 48)
    zb = zc - 0.07
    for ring_r, n, off in ((0.28, 4, 45), (0.66, 8, 22.5)):
        for k in range(n):
            a = (off + k * 360 / n) * D2R
            x, y = ring_r * math.cos(a), ring_r * math.sin(a)
            lathe([(0, -0.02), (0.085, -0.02), (0.085, -0.06), (0.095, -0.06), (0.095, 0), (0, 0)],
                  (x, y, zb), 'aluminium', (0, 0, 1), 16)
            cyl(0.03, 0.56, (x, y, zb - 0.30), 'white_paint', segs=10, bev=0.0)
            helix(0.062, 0.125, 4.0, 0.0075, (x, y, zb - 0.03), (0, 0, -1), 'copper', 10, 4)
    # UHF crosslink antenna, S-band TT&C, laser retroreflector array, Earth sensor
    cyl(0.2, 0.06, (-0.95, 0.72, zc - 0.03), 'aluminium', segs=24)
    cyl(0.17, 0.32, (-0.95, 0.72, zc - 0.22), 'white_paint', segs=24, bev=0.02)
    omni((0.95, 0.72, zc), (0, 0, -1), 0.3)
    box((0.30, 0.30, 0.05), (-0.98, -0.66, zc - 0.025), 'structure')
    for i in range(3):
        for j in range(3):
            cyl(0.035, 0.012, (-1.07 + i * 0.09, -0.75 + j * 0.09, zc - 0.055), 'glass', segs=10, bev=0.0)
    box((0.22, 0.16, 0.14), (0.98, -0.66, zc - 0.07), 'mli_silver')
    for o in (-0.04, 0.04):
        cyl(0.03, 0.04, (0.98 + o, -0.66, zc - 0.15), 'black_kapton', segs=14)
    # zenith deck: launch adapter ring, apogee engine, attitude thrusters, omni
    lathe([(0.78, 0), (0.80, 0.0), (0.80, 0.10), (0.83, 0.10), (0.83, 0.13), (0.74, 0.13), (0.74, 0.0), (0.78, 0)],
          (0, 0, H / 2), 'structure', (0, 0, 1), 48)
    nozzle((0, 0, H / 2 + 0.12), (0, 0, 1), 0.04, 0.15, 0.32, 'niobium', chamber=(0.07, 0.12))
    for x in (-1.12, 1.12):
        for y in (-0.88, 0.88):
            box((0.12, 0.12, 0.06), (x, y, H / 2 + 0.03), 'aluminium')
            for dd in ((0, 0, 1), (x, 0, 0.3)):
                nozzle(Vector((x, y, H / 2 + 0.05)) + Vector(dd).normalized() * 0.03, dd, 0.008, 0.022, 0.05,
                       'nozzle', segs=12)
    omni((-0.9, 0.0, H / 2), (0, 0, 1), 0.45)
    box((0.3, 0.3, 0.12), (0.8, 0.0, H / 2 + 0.06), 'mli_silver')
    body, n1 = merge('gnss_body', take(), (0, 0, 0), root)
    nt = n1
    for i, s in ((1, 1), (2, -1)):
        hinge = (0, s * (Dp / 2 + 0.03), 0)
        rects = [(0, k * 1.54, 2.3, 1.5) for k in range(3)]
        wing(hinge, s, 0.9, rects)
        _, n = merge(f'solar_{i}', take(), hinge, root)
        nt += n
    return root, nt


def build_geo():
    root = make_root('geo')
    W, H = 2.5, 5.0
    box((W, W, H), (0, 0, 0), 'mli_gold', bev=0.04)
    for s in (-1, 1):
        box((2.4, 0.04, 4.6), (0, s * (W / 2 + 0.02), 0), 'radiator', bev=0.01)
        for z in (-2.32, 2.32):
            box((2.5, 0.06, 0.08), (0, s * (W / 2 + 0.03), z), 'aluminium')
    # Earth deck (nadir)
    zd = -H / 2
    box((2.62, 2.62, 0.06), (0, 0, zd - 0.03), 'mli_silver', bev=0.012)
    # large deployable reflectors on +-X, offset-fed from feed clusters on deck outriggers
    f = 1.6
    for s in (-1, 1):
        n = Vector((-s * 0.55, 0, -1)).normalized()
        C = Vector((s * 2.95, 0, -1.25))
        dish(2.5, f, C, n, 'dish_white', 'dish_back', segs=48, rings=9, t=0.035)
        hub = C - n * 0.16
        hinge = Vector((s * 1.27, 0, 0.55))
        box((0.12, 0.30, 0.25), hinge, 'aluminium')
        tube(hinge, hub, 0.055, 'aluminium')
        tube(Vector((s * 1.27, 0.6, -0.6)), hub + Vector((0, 0.25, 0)), 0.035, 'aluminium')
        tube(Vector((s * 1.27, -0.6, -0.6)), hub + Vector((0, -0.25, 0)), 0.035, 'aluminium')
        for yy in (-0.6, 0.6):
            box((0.08, 0.14, 0.14), (s * 1.27, yy, -0.6), 'aluminium')
        F = C + n * f
        to_dish = (C - F).normalized()
        # feed cluster (7 horns) on an outrigger from the deck edge
        box((abs(F.x) - 1.2, 0.5, 0.08), (s * (1.2 + (abs(F.x) - 1.2) / 2), 0, zd - 0.10), 'structure')
        plate = F - to_dish * 0.42
        cyl(0.30, 0.05, plate, 'structure', dir=to_dish, segs=24)
        R3 = _rot(to_dish)
        for k in range(7):
            o = Vector((0, 0, 0)) if k == 0 else Vector((0.19 * math.cos(k * TAU / 6), 0.19 * math.sin(k * TAU / 6), 0))
            horn(plate + R3 @ o + to_dish * 0.025, to_dish, 0.03, 0.09, 0.32, 'mli_gold', segs=14)
        tube(plate - to_dish * 0.03, Vector((s * 1.3, 0, zd - 0.12)), 0.03, 'aluminium')
    # deck-mounted steerable spot-beam dish on a gimbal tower
    cyl(0.12, 0.25, (0.55, 0.65, zd - 0.18), 'aluminium', segs=20)
    box((0.30, 0.08, 0.22), (0.55, 0.65, zd - 0.38), 'aluminium')
    dish(1.1, 0.5, (0.55, 0.65, zd - 0.62), (0.15, 0.1, -1), 'dish_gold', 'dish_back', segs=36, rings=6, t=0.02)
    horn((0.55, 0.65, zd - 0.95), (-0.15, -0.1, 1), 0.02, 0.06, 0.16, 'mli_gold', segs=14)
    for a in (0, 120, 240):
        tube((0.55 + 0.5 * math.cos(a * D2R), 0.65 + 0.5 * math.sin(a * D2R), zd - 0.62),
             (0.55 - 0.08, 0.65 - 0.05, zd - 0.92), 0.008, 'aluminium')
    # Ku spot horn array on deck
    for i in range(3):
        for j in range(2):
            horn((-0.75 + i * 0.2, -0.75 + j * 0.2, zd - 0.06), (0, 0, -1), 0.025, 0.085, 0.28, 'mli_silver',
                 segs=14)
    # Earth sensors, TT&C omni
    for x in (-0.35, 0.05):
        box((0.18, 0.15, 0.14), (x, -0.25, zd - 0.13), 'mli_silver')
        cyl(0.04, 0.03, (x, -0.25, zd - 0.215), 'black_kapton', segs=14)
    omni((-1.05, 1.05, zd - 0.06), (0, 0, -1), 0.4)
    # anti-Earth deck: adapter ring, LAE, thrusters, Hall thrusters on gimbals, omni
    lathe([(0.60, 0), (0.62, 0), (0.62, 0.12), (0.66, 0.12), (0.66, 0.16), (0.56, 0.16), (0.56, 0.0), (0.60, 0)],
          (0, 0, H / 2), 'structure', (0, 0, 1), 48)
    nozzle((0, 0, H / 2 + 0.16), (0, 0, 1), 0.05, 0.20, 0.45, 'niobium', chamber=(0.09, 0.15))
    for x in (-1.1, 1.1):
        for y in (-1.1, 1.1):
            box((0.16, 0.16, 0.08), (x, y, H / 2 + 0.04), 'aluminium')
            for dd in ((0, 0, 1), (x, 0, 0.3), (0, y, 0.3)):
                nozzle(Vector((x, y, H / 2 + 0.06)) + Vector(dd).normalized() * 0.04, dd, 0.01, 0.028, 0.06,
                       'nozzle', segs=12)
    for y in (-0.75, 0.75):
        box((0.2, 0.2, 0.18), (-1.0, y, H / 2 + 0.09), 'aluminium')
        cyl(0.075, 0.08, (-1.06, y, H / 2 + 0.24), 'structure', dir=(-0.4, 0, 1), segs=24)
        lathe([(0.075, 0.0), (0.073, 0.01), (0.058, 0.01), (0.056, -0.004), (0.04, -0.004), (0.038, 0.01),
               (0.025, 0.01), (0.023, 0.0), (0, 0.004)], Vector((-1.06, y, H / 2 + 0.24)) +
              Vector((-0.4, 0, 1)).normalized() * 0.04, 'ceramic', (-0.4, 0, 1), 28)
    omni((1.0, 0, H / 2), (0, 0, 1), 0.6)
    body, n1 = merge('geo_body', take(), (0, 0, 0), root)
    nt = n1
    for i, s in ((1, 1), (2, -1)):
        hinge = (0, s * (W / 2 + 0.04), 0.0)
        rects = [(0, k * 2.29, 2.6, 2.25) for k in range(5)]
        wing(hinge, s, 2.5, rects, yoke_w=1.9, sada_r=0.16, yoke_r=0.04)
        _, n = merge(f'solar_{i}', take(), hinge, root)
        nt += n
    return root, nt


def build_weather():
    root = make_root('weather')
    L, Wd, Hh = 4.0, 2.0, 2.0
    box((L, Wd, Hh), (0, 0, 0), 'mli_black', bev=0.03)
    box((2.6, 1.7, 0.03), (-0.4, 0, Hh / 2 + 0.015), 'radiator', bev=0.008)      # zenith radiator
    for x in (-L / 2, L / 2):
        box((0.03, 1.8, 1.8), (x + (0.015 if x > 0 else -0.015), 0, 0), 'mli_gold', bev=0.008)
    box((2.6, 0.03, 1.5), (0.4, Wd / 2 + 0.015, 0.05), 'radiator', bev=0.006)     # anti-sun radiator
    box((3.0, 0.02, 1.5), (0.0, -Wd / 2 - 0.01, 0.05), 'mli_silver', bev=0.005)   # sun-side blanket
    for y in (-Wd / 2, Wd / 2):
        for z in (-Hh / 2, Hh / 2):
            box((L - 0.04, 0.05, 0.05), (0, y, z), 'mli_silver', bev=0.01)
    # nadir instrument deck
    zd = -Hh / 2
    box((3.9, 1.9, 0.05), (0, 0, zd - 0.025), 'structure', bev=0.01)
    zd -= 0.05
    # VIIRS: main box, rotating telescope assembly (scan axis = X), passive radiative cooler on +Y
    box((1.3, 1.0, 0.7), (0.5, 0.2, zd - 0.35), 'mli_gold', bev=0.025)
    box((0.5, 0.25, 0.18), (0.5, -0.45, zd - 0.09), 'aluminium')
    cyl(0.33, 0.70, (0.5, -0.62, zd - 0.45), 'mli_silver', dir=(1, 0, 0), segs=32)
    for xo in (-0.36, 0.36):
        cyl(0.35, 0.035, (0.5 + xo, -0.62, zd - 0.45), 'aluminium', dir=(1, 0, 0), segs=32)
    box((0.52, 0.13, 0.06), (0.5, -0.62, zd - 0.775), 'black_kapton', bev=0.01)
    box((0.04, 0.5, 0.5), (0.5 + 0.39, -0.62, zd - 0.45), 'structure')
    cdir = Vector((0, 1, -0.45)).normalized()
    cpos = Vector((0.5, 0.72, zd - 0.38))
    shell([(0.13, 0), (0.13, 0.05), (0.22, 0.05), (0.27, 0.18), (0.32, 0.18), (0.42, 0.32)], cpos, 'aluminium',
          cdir, 32, 0.014)
    # ATMS microwave sounder: box + two rotating scan reflectors on X shafts with drive drums
    ax = -0.75
    box((0.75, 0.65, 0.65), (ax, -0.45, zd - 0.325), 'mli_silver', bev=0.02)
    for xo, rr in ((0.47, 0.22), (-0.46, 0.16)):
        sx = ax + xo
        sg = 1 if xo > 0 else -1
        cyl(rr + 0.03, 0.06, (sx - sg * 0.07, -0.45, zd - 0.40), 'structure', dir=(1, 0, 0), segs=28)
        cyl(0.03, 0.14, (sx, -0.45, zd - 0.40), 'aluminium', dir=(1, 0, 0), segs=12)
        cyl(rr, 0.025, (sx + sg * 0.07, -0.45, zd - 0.40), 'dish_gold', dir=(sg, 0.0, -1.0), segs=32, bev=0.006)
    # CrIS IR sounder: box, nadir port with sunshade, cooler
    cx = -0.75
    box((0.85, 0.75, 0.6), (cx, 0.5, zd - 0.30), 'mli_gold', bev=0.02)
    lathe([(0, -0.02), (0.15, -0.02), (0.15, -0.12), (0.175, -0.12), (0.175, 0)], (cx + 0.05, 0.45, zd - 0.60),
          'black_kapton', (0, 0, 1), 28)
    shell([(0.07, 0), (0.07, 0.04), (0.18, 0.15)], (cx + 0.15, 0.875, zd - 0.28), 'aluminium', (0, 1, -0.3), 24)
    # OMPS (white box with slits) and CERES (rotating scanner head)
    box((0.5, 0.42, 0.35), (1.55, -0.5, zd - 0.175), 'white_paint')
    for i in range(3):
        box((0.06, 0.28, 0.02), (1.41 + i * 0.14, -0.5, zd - 0.355), 'black_kapton', bev=0.004)
    cyl(0.20, 0.18, (1.5, 0.5, zd - 0.09), 'aluminium', segs=24)
    box((0.28, 0.40, 0.36), (1.5, 0.5, zd - 0.36), 'mli_gold', rot=(0, 0, 0.5))
    box((0.04, 0.12, 0.14), (1.5 + 0.13, 0.5 + 0.07, zd - 0.42), 'black_kapton', rot=(0, 0, 0.5))
    # Ka-band high-rate dish on a gimbal, X-band horn, S-band omnis
    cyl(0.08, 0.30, (-1.6, 0.45, zd - 0.15), 'aluminium', segs=16)
    box((0.26, 0.08, 0.16), (-1.6, 0.45, zd - 0.34), 'aluminium')
    dish(0.7, 0.3, (-1.6, 0.45, zd - 0.50), (-0.25, 0, -1), 'dish_white', 'dish_back', segs=32, rings=6, t=0.02)
    horn((-1.66, 0.45, zd - 0.72), (0.25, 0, 1), 0.015, 0.04, 0.1, 'mli_gold', segs=12)
    for a in (0, 120, 240):
        tube((-1.6 + 0.33 * math.cos(a * D2R), 0.45 + 0.33 * math.sin(a * D2R), zd - 0.53),
             (-1.65, 0.45, zd - 0.70), 0.006, 'aluminium')
    cyl(0.05, 0.2, (-1.65, -0.45, zd - 0.1), 'aluminium', segs=16)
    horn((-1.65, -0.45, zd - 0.2), (0, 0, -1), 0.03, 0.09, 0.22, 'mli_gold', segs=16)
    omni((-1.5, -0.7, Hh / 2), (0, 0, 1), 0.5)
    omni((1.7, -0.7, zd), (0, 0, -1), 0.3)
    # star trackers on zenith deck, thrusters aft
    for y, dy in ((-0.6, -0.5), (0.6, 0.5)):
        star_tracker((-1.6, y, Hh / 2 + 0.05), (-0.3, dy, 1.0), 1.2)
    for y in (-0.6, 0.6):
        for z in (-0.6, 0.6):
            box((0.10, 0.12, 0.12), (-L / 2 - 0.05, y, z), 'aluminium')
            nozzle((-L / 2 - 0.1, y, z), (-1, 0, 0), 0.01, 0.03, 0.07, 'nozzle', segs=12)
    # SADA boss on -Y
    box((0.5, 0.06, 0.5), (0, -Wd / 2 - 0.03, 0.3), 'aluminium')
    body, n1 = merge('weather_body', take(), (0, 0, 0), root)
    # one large wing on a long boom on -Y: 3 panels along the wing x 2 across
    hinge = (0, -Wd / 2 - 0.06, 0.3)
    s = -1
    hx, hy, hz = hinge
    cyl(0.14, 0.12, (hx, hy - 0.06, hz), 'aluminium', dir=(0, 1, 0), segs=20)
    tube((hx, hy - 0.12, hz), (hx, hy - 1.9, hz), 0.06, 'aluminium')
    cyl(0.09, 0.1, (hx, hy - 1.0, hz), 'aluminium', dir=(0, 1, 0), segs=16)
    y0 = hy - 1.9
    box((3.0, 0.08, 0.08), (hx, y0, hz), 'aluminium')
    for xo in (-1.4, 1.4):
        tube((hx, hy - 1.2, hz), (hx + xo, y0, hz), 0.025, 'aluminium')
    rects = []
    for k in range(3):
        for xo in (-0.83, 0.83):
            rects.append((hx + xo, y0 - 0.06 - k * 2.0 - 0.98, 1.62, 1.96))
    panel_set(rects, hz)
    for k in range(1, 3):
        for xo in (-1.3, -0.35, 0.35, 1.3):
            cyl(0.018, 0.10, (hx + xo, y0 - 0.06 - k * 2.0 + 0.02, hz - 0.02), 'aluminium', dir=(0, 1, 0), segs=10)
    _, n2 = merge('solar_1', take(), hinge, root)
    return root, n1 + n2


def build_smallsat():
    root = make_root('smallsat')
    Rh, Hb = 0.78, 1.15
    ap = Rh * math.cos(30 * D2R)
    HS = 30 * D2R                                   # flats facing +-Y
    cyl(Rh, Hb, (0, 0, 0), 'mli_gold', segs=6, bev=0.03, spin=HS)
    # +-Y radiator faces; silver blankets on the oblique faces
    for s in (-1, 1):
        box((0.62, 0.02, 0.9), (0, s * (ap + 0.01), 0), 'radiator', bev=0.005)
    for ang in (30, 150, 210, 330):
        a = ang * D2R
        box((0.55, 0.012, 0.8), (ap * math.cos(a) * 1.006, ap * math.sin(a) * 1.006, 0.0), 'mli_silver',
            rot=(0, 0, a - math.pi / 2), bev=0.004)
    cyl(Rh + 0.02, 0.04, (0, 0, Hb / 2 + 0.02), 'mli_silver', segs=6, bev=0.01, spin=HS)
    cyl(Rh + 0.02, 0.04, (0, 0, -Hb / 2 - 0.02), 'structure', segs=6, bev=0.01, spin=HS)
    zt, zb = Hb / 2 + 0.04, -Hb / 2 - 0.04
    # separation ring on top, GPS patch, S-band patches
    lathe([(0.40, 0), (0.42, 0), (0.42, 0.06), (0.45, 0.06), (0.45, 0.09), (0.37, 0.09), (0.37, 0), (0.40, 0)],
          (0, 0, zt), 'aluminium', (0, 0, 1), 40)
    box((0.14, 0.14, 0.03), (0.55, 0.0, zt + 0.015), 'white_paint')
    box((0.12, 0.12, 0.025), (0.15, 0.0, zt + 0.0125), 'white_paint')
    box((0.12, 0.12, 0.025), (-0.55, 0.25, zb - 0.0125), 'white_paint')
    star_tracker((-0.45, -0.3, zt + 0.04), (-0.35, -0.5, 1), 1.0)
    star_tracker((-0.45, 0.3, zt + 0.04), (-0.35, 0.5, 1), 1.0)
    # nadir telescope barrel with an oblique sunshade cut and recessed optics
    tz = zb
    prof = [(0.0, -0.14), (0.30, -0.14), (0.30, -0.66), (0.315, -0.68), (0.33, -0.66), (0.33, 0.0)]
    ob = lathe(prof, (0, 0, tz), 'black_kapton', (0, 0, 1), 40)
    for v in ob.data.vertices:
        if v.co.z < -0.5:
            v.co.z += (v.co.x / 0.33) * 0.14
    lathe([(0.33, -0.3), (0.335, -0.3), (0.335, -0.25), (0.345, -0.24), (0.345, -0.19), (0.335, -0.18),
           (0.335, 0.0)], (0, 0, tz), 'mli_gold', (0, 0, 1), 40)
    lathe([(0.0, -0.016), (0.12, -0.012), (0.27, 0.0)], (0, 0, tz - 0.15), 'glass', (0, 0, 1), 32)
    lathe([(0.0, -0.06), (0.10, -0.06), (0.10, 0.0)], (0, 0, tz - 0.165), 'black_kapton', (0, 0, 1), 24)
    for a in (90, 210, 330):
        tube((0.09 * math.cos(a * D2R), 0.09 * math.sin(a * D2R), tz - 0.20),
             (0.29 * math.cos(a * D2R), 0.29 * math.sin(a * D2R), tz - 0.16), 0.006, 'black_kapton')
    # X-band downlink: gimballed dish on the nadir deck
    cyl(0.05, 0.12, (0.58, 0, zb - 0.06), 'aluminium', segs=16)
    box((0.14, 0.05, 0.08), (0.58, 0, zb - 0.15), 'aluminium')
    dish(0.28, 0.12, (0.58, 0, zb - 0.24), (0.2, 0, -1), 'dish_white', 'dish_back', segs=28, rings=5, t=0.012,
         rim=0.006)
    cyl(0.012, 0.03, (0.56, 0, zb - 0.36), 'ceramic', segs=10)
    for y in (-0.08, 0.08):
        tube((0.58, y, zb - 0.26), (0.56, 0, zb - 0.35), 0.004, 'aluminium')
    # propulsion: thruster on the aft face, sun sensors
    nozzle((-Rh - 0.0, 0, 0.1), (-1, 0, 0), 0.015, 0.05, 0.11, 'nozzle', chamber=(0.03, 0.05))
    box((0.07, 0.07, 0.03), (0.4, -0.3, zt + 0.015), 'black_kapton')
    box((0.07, 0.07, 0.03), (0.4, 0.3, zt + 0.015), 'black_kapton')
    body, n1 = merge('smallsat_body', take(), (0, 0, 0), root)
    nt = n1
    for i, s in ((1, 1), (2, -1)):
        hinge = (0, s * (ap + 0.02), 0.0)
        rects = [(0, k * 1.58, 1.1, 1.55) for k in range(2)]
        wing(hinge, s, 0.38, rects, sada_r=0.07, yoke_r=0.02)
        _, n = merge(f'solar_{i}', take(), hinge, root)
        nt += n
    return root, nt


def build_rocketbody():
    root = make_root('rocketbody')
    X = Vector((1, 0, 0))
    R = 1.95
    SEG = 40
    # skin sections along X (local z of the lathe = X)
    SK = 64                                         # finer facets on the big smooth skin
    lathe([(R, -2.40), (R, 0.40)], (0, 0, 0), 'skin', X, SK)
    lathe([(R, 0.40), (R, 1.60)], (0, 0, 0), 'skin_grey', X, SK)
    lathe([(R, 1.60), (R, 4.85), (R - 0.015, 4.88)], (0, 0, 0), 'skin', X, SK)
    # forward: conical payload adapter + adapter ring + closure plate
    lathe([(R - 0.015, 4.88), (1.0, 5.32), (0.98, 5.34), (0.98, 5.50), (0.90, 5.50), (0.90, 5.36), (0, 5.36)],
          (0, 0, 0), 'skin_grey', X, SK)
    # aft dome inside the interstage stub
    dome = [(R, -2.40)] + [(R * math.cos(t), -2.40 - 0.75 * math.sin(t)) for t in
                           [k * (math.pi / 2) / 7 for k in range(1, 7)]] + [(0, -3.15)]
    dome = dome[::-1]
    lathe(dome, (0, 0, 0), 'foam', X, SEG)
    # interstage stub (open thin shell) with inner frames
    lathe([(R - 0.04, -3.45), (R + 0.03, -3.45), (R + 0.03, -3.38), (R + 0.01, -3.36), (R + 0.01, -2.40),
           (R, -2.35), (R - 0.03, -2.35), (R - 0.03, -3.36), (R - 0.04, -3.38), (R - 0.04, -3.45)], (0, 0, 0),
          'skin_grey', X, SEG)
    for z in (-2.75, -3.1):
        lathe([(R - 0.03, z + 0.03), (R - 0.10, z + 0.03), (R - 0.10, z - 0.03), (R - 0.03, z - 0.03),
               (R - 0.03, z + 0.03)], (0, 0, 0),
              'structure', X, SEG)
    # ring frames (raised bands) on the tanks
    for z in (-2.30, -1.20, -0.05, 0.40, 1.60, 2.70, 3.80, 4.80):
        lathe([(R, z - 0.042), (R + 0.02, z - 0.024), (R + 0.02, z + 0.024), (R, z + 0.042)],
              (0, 0, 0), 'skin_grey' if z not in (0.40, 1.60) else 'aluminium', X, SEG)
    # stringers on the intertank and the interstage stub
    for k in range(48):
        a = TAU * (k + 0.5) / 48
        y, zz = math.cos(a), math.sin(a)
        rot = (a - math.pi / 2, 0, 0)
        box((1.12, 0.035, 0.022), (1.0, y * (R + 0.011), zz * (R + 0.011)), 'aluminium', rot=rot, mode='flat')
        box((0.85, 0.03, 0.02), (-2.88, y * (R + 0.02), zz * (R + 0.02)), 'skin_grey', rot=rot, mode='flat')
    # orange/brown insulation patches
    for a0, a1, z0, z1 in ((0.2, 1.4, -2.1, -0.4), (2.4, 3.3, -1.9, -0.2), (4.1, 5.6, -2.2, -1.35),
                           (0.9, 2.3, 1.9, 3.5), (3.6, 4.6, 2.0, 4.5), (5.3, 6.1, 2.95, 4.55)):
        cyl_patch(R, 0.012, a0, a1, z0, z1, 'foam', (0, 0, 0), X, nseg=12)
    # cable raceway + pressurisation line with standoffs
    a = 100 * D2R
    rot = (a - math.pi / 2, 0, 0)
    box((7.1, 0.16, 0.07), (1.15, math.cos(a) * (R + 0.04), math.sin(a) * (R + 0.04)), 'skin_grey', rot=rot,
        bev=0.015)
    a2 = 215 * D2R
    rr = R + 0.10
    pts = [(4.7, math.cos(a2) * rr, math.sin(a2) * rr), (-2.2, math.cos(a2) * rr, math.sin(a2) * rr)]
    sweep([(4.75, math.cos(a2) * (R + 0.02), math.sin(a2) * (R + 0.02))] +
          pts + [(-2.35, math.cos(a2) * (R + 0.02), math.sin(a2) * (R + 0.02))], 0.055, 'aluminium', 12)
    for x in (4.0, 2.7, 1.0, -0.5, -1.7):
        box((0.06, 0.10, 0.12), (x, math.cos(a2) * (R + 0.05), math.sin(a2) * (R + 0.05)), 'structure',
            rot=(a2 - math.pi / 2, 0, 0))
    # attitude-control thruster pods on the interstage stub
    for a in (90 * D2R, 270 * D2R):
        c = Vector((-3.0, math.cos(a) * (R + 0.09), math.sin(a) * (R + 0.09)))
        box((0.45, 0.30, 0.16), c, 'skin_grey', rot=(a - math.pi / 2, 0, 0), bev=0.02)
        out = Vector((0, math.cos(a), math.sin(a)))
        tang = Vector((0, -math.sin(a), math.cos(a)))
        for d in (out, tang, -tang, Vector((-1, 0, 0))):
            nozzle(c + d * (0.16 if d.x == 0 else 0.22) + (out * 0.02 if d is not out else Vector()), d,
                   0.012, 0.035, 0.08, 'nozzle', segs=8)
    # antenna blades and umbilical plate on the forward section
    for a in (30 * D2R, 210 * D2R):
        box((0.30, 0.02, 0.14), (4.3, math.cos(a) * (R + 0.07), math.sin(a) * (R + 0.07)), 'structure',
            rot=(a - math.pi / 2, 0, 0))
    box((0.5, 0.3, 0.05), (3.2, math.cos(150 * D2R) * (R + 0.02), math.sin(150 * D2R) * (R + 0.02)), 'skin_grey',
        rot=(150 * D2R - math.pi / 2, 0, 0))
    # main engine: thrust frame, turbopump, chamber + large nozzle bell (exit at x = -5.5)
    mX = Vector((-1, 0, 0))
    for k in range(6):
        a = TAU * k / 6
        tube((-2.95, math.cos(a) * 0.9, math.sin(a) * 0.9), (-3.45, math.cos(a + 0.5) * 0.28,
                                                              math.sin(a + 0.5) * 0.28), 0.035, 'structure')
    lathe([(0.32, 0), (0.32, 0.06), (0.24, 0.06), (0.24, 0.0)], (-3.40, 0, 0), 'structure', mX, 32)
    nozzle((-3.95, 0, 0), mX, 0.13, 0.95, 1.55, 'nozzle', 'black_kapton', segs=40, chamber=(0.25, 0.45))
    for zz, rr2 in ((0.5, 0.0), (1.05, 0.0)):
        rr_ = 0.13 + (0.95 - 0.13) * ((zz / 1.55) ** 0.75)
        lathe([(rr_ + 0.004, zz - 0.03), (rr_ + 0.03, zz - 0.02), (rr_ + 0.03, zz + 0.02), (rr_ + 0.004, zz + 0.03)],
              (-3.95, 0, 0), 'niobium', mX, 40)
    cyl(0.17, 0.55, (-3.55, 0.48, 0.0), 'aluminium', dir=mX, segs=20)
    cyl(0.11, 0.35, (-3.55, -0.45, 0.25), 'aluminium', dir=mX, segs=16)
    sweep([(-3.3, 0.48, 0.0), (-3.25, 0.30, 0.0), (-3.5, 0.2, 0.0)], 0.05, 'aluminium', 10)
    sweep([(-3.4, -0.45, 0.25), (-3.35, -0.25, 0.15), (-3.55, -0.22, 0.05)], 0.04, 'aluminium', 10)
    sweep([(-3.83, 0.48, 0.0), (-3.95, 0.35, -0.1), (-4.05, 0.22, 0.0)], 0.035, 'copper', 10)
    # four vernier chambers (RD-8 style) on gimbal brackets at the stub rim
    for k in range(4):
        a = TAU * (k + 0.5) / 4
        p = Vector((-3.45, math.cos(a) * 1.45, math.sin(a) * 1.45))
        box((0.18, 0.18, 0.18), p + Vector((0.05, 0, 0)), 'structure')
        nozzle(p + Vector((-0.12, 0, 0)), mX, 0.04, 0.17, 0.5, 'nozzle', 'black_kapton', segs=16, steps=4,
               chamber=(0.07, 0.15))
    body, n1 = merge('rocketbody_body', take(), (0, 0, 0), root)
    return root, n1


MODELS = {
    'starlink': (build_starlink, 15000),
    'gnss': (build_gnss, 15000),
    'geo': (build_geo, 20000),
    'weather': (build_weather, 15000),
    'smallsat': (build_smallsat, 15000),
    'rocketbody': (build_rocketbody, 15000),
}


def export(name):
    path = os.path.join(OUT_DIR, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, export_yup=True,
                              use_selection=False, export_cameras=False, export_lights=False,
                              export_image_format='AUTO', export_materials='EXPORT')
    log(f'  exported {path} {os.path.getsize(path)} bytes')


def main():
    names = [a for a in bc.script_args() if a in MODELS] or list(MODELS)
    os.makedirs(OUT_DIR, exist_ok=True)
    for name in names:
        bc.clear_scene()
        bpy.context.scene.unit_settings.system = 'METRIC'
        T = make_textures()
        make_materials(T)
        fn, budget = MODELS[name]
        log(f'== {name}')
        root, ntri = fn()
        log(f'  total tris {ntri} (budget {budget})')
        if ntri > budget:
            log(f'  WARNING over triangle budget')
        export(name)


if __name__ == '__main__':
    bc.run(main, LOG)
