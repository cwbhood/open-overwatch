"""Open Overwatch spacecraft models: ISS, Tiangong (CSS), Hubble and Soyuz MS -> .glb for the CesiumJS globe.

Run headless (Blender 5.2):
  blender-launcher.exe -b --factory-startup --python sat_models_stations.py -- build    [iss css hubble soyuz]
  blender-launcher.exe -b --factory-startup --python sat_models_stations.py -- validate [iss css hubble soyuz]
'build' generates the tiling textures (brand/models/tex), models each vehicle and exports brand/models/<name>.glb.
'validate' re-imports each .glb into an empty scene, checks the spec, writes brand/models/validation.json and
renders brand/models/previews/<name>.png (2x2: 3/4 above-front, side, top, below).
Logs: %TEMP%/sat_models_<mode>.log (Blender's stdout is not captured by the launcher).

Frame (meters): +X ram / direction of flight, +Z zenith, -Z nadir, +Y orbit normal, origin ~ centre of mass.
Because +Y is the orbit normal and the ISS/CSS fly +X-forward with +Z up, their STARBOARD side is -Y (ISS LVLH:
starboard = -orbit normal). So the ISS port truss (P4/P6, Kibo, Tranquility) is on +Y and S4/S6/Columbus/Quest on -Y.
Sun-tracking arrays are separate objects solar_N (parented to the root, zero rotation, unit scale, origin on the
rotation axis which is parallel to Y, cell side +Z at rest). See SOLAR_NOTES for which wing is which.
"""
import bpy, bmesh, os, sys, math, json, struct
import numpy as np
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bl_common import run, log, script_args, hex_rgba, setup_cycles, look_at  # noqa: E402

BRAND_DIR = os.path.dirname(HERE)
MODELS = os.path.join(BRAND_DIR, 'models')
TEX = os.path.join(MODELS, 'tex')
PREV = os.path.join(MODELS, 'previews')
TAU = 2 * math.pi
NAMES = ['iss', 'css', 'hubble', 'soyuz']
LIMITS = {'iss': (70000, 2.5e6), 'css': (40000, 1.0e6), 'hubble': (15000, 1.0e6), 'soyuz': (15000, 1.0e6)}
SOLAR_NOTES = {
    'iss': {'solar_1': 'P6 wing pair (port, outboard)', 'solar_2': 'P4 wing pair (port, inboard)',
            'solar_3': 'S4 wing pair (starboard, inboard)', 'solar_4': 'S6 wing pair (starboard, outboard)',
            'solar_5': 'Zvezda port wing (+Y)', 'solar_6': 'Zvezda starboard wing (-Y)'},
    'css': {'solar_1': 'Mengtian lab array, both wings (+Y lab)', 'solar_2': 'Wentian lab array, both wings (-Y lab)',
            'solar_3': 'Tianhe +Y wing', 'solar_4': 'Tianhe -Y wing'},
    'hubble': {'solar_1': 'SA3 +Y wing', 'solar_2': 'SA3 -Y wing'},
    'soyuz': {'solar_1': '+Y wing', 'solar_2': '-Y wing'},
}

# ----------------------------------------------------------------------------------------------------- materials
PAL = {
    'skin':        dict(tex='skin', rough=0.55, tile=2.0),           # US/EU/JP module skins with panel seams
    'skin_ru':     dict(tex='skin_ru', rough=0.55, tile=2.0),        # Russian / Chinese module skins
    'white':       dict(base='#e8ebee', rough=0.5),
    'band':        dict(base='#b4bac0', metal=0.6, rough=0.4),
    'alu':         dict(base='#9aa3ab', metal=0.8, rough=0.35),
    'truss':       dict(base='#9aa3ab', metal=0.8, rough=0.42),
    'dark':        dict(base='#3a3f45', metal=0.4, rough=0.5),
    'black':       dict(base='#0c0d0f', rough=0.85),
    'gold':        dict(base='#c8962e', metal=1.0, rough=0.35),
    'mli':         dict(tex='mli', metal=0.6, rough=0.38, tile=1.6),  # Hubble silver MLI / NOBL patches
    'radiator':    dict(tex='radiator', rough=0.45, tile=1.0),
    'cells':       dict(tex='cells', metal=0.3, rough=0.25, tile=1.0),
    'cells_fine':  dict(tex='cells', metal=0.3, rough=0.25, tile=0.5),
    'blanket_back': dict(base='#d8d0bd', rough=0.6),
    'panel_back':  dict(base='#80888f', metal=0.5, rough=0.45),
    'quilt':       dict(tex='quilt', rough=0.75, tile=0.8),           # Soyuz / Progress green-grey blankets
    'heat':        dict(base='#2c2826', rough=0.85),
    'glass':       dict(base='#0b1320', rough=0.06),
    'lamp':        dict(base='#ffd9a0', emit='#ffd9a0', strength=1.2, rough=0.4),
    'dm_grey':     dict(base='#bdbab0', rough=0.6),
}
_MATS = {}


def get_mat(name):
    if name in _MATS:
        return _MATS[name]
    spec = PAL[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        nt.nodes.clear()
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    if 'tex' in spec:
        img = bpy.data.images.load(os.path.join(TEX, spec['tex'] + '.png'), check_existing=True)
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = img
        tn.interpolation = 'Linear'
        nt.links.new(tn.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = hex_rgba(spec['base'])
    bsdf.inputs['Metallic'].default_value = spec.get('metal', 0.0)
    bsdf.inputs['Roughness'].default_value = spec.get('rough', 0.5)
    if 'emit' in spec:
        bsdf.inputs['Emission Color'].default_value = hex_rgba(spec['emit'])
        bsdf.inputs['Emission Strength'].default_value = spec['strength']
    m.diffuse_color = hex_rgba(spec.get('base', '#d0d0d0'))
    _MATS[name] = m
    return m


def tile(mat):
    return PAL[mat].get('tile', 1.0)


# ------------------------------------------------------------------------------------------------------ textures
def save_png(name, arr):
    h, w, _ = arr.shape
    img = bpy.data.images.new('gen_' + name, w, h, alpha=False)
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = np.clip(arr, 0, 255) / 255.0
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = os.path.join(TEX, name + '.png')
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def gen_textures():
    os.makedirs(TEX, exist_ok=True)
    rng = np.random.default_rng(7)
    N = 512
    yy, xx = np.mgrid[0:N, 0:N]
    # solar cells: 16x16 cells per tile (6 cm cells at tile=1 m), thin dark-silver grid, cropped cell corners,
    # lighter hinge/bus bars every half tile along u
    cell = 32
    cx, cy = xx % cell, yy % cell
    ci = (yy // cell) * 16 + (xx // cell)
    var = rng.uniform(0.85, 1.15, 256)[ci]
    sheen = 1.0 + 0.25 * (1 - (cx + cy) / (2 * cell))
    a = np.zeros((N, N, 3), np.float32)
    a[:] = np.array([13, 26, 58], np.float32) * (var * sheen)[..., None]
    corner = (np.minimum(cx, cell - 1 - cx) + np.minimum(cy, cell - 1 - cy)) < 4
    a[corner] = [70, 80, 100]
    a[(cx == 0) | (cy == 0)] = [92, 104, 128]
    a[(xx % (N // 2)) < 3] = [168, 176, 188]
    save_png('cells', a)

    def panels(base, rows, cols, vmin, seam, bolts=True, stripe=None):
        ph, pw = N // rows, N // cols
        r_ = yy // ph
        off = (r_ % 2) * (pw // 2)
        c_ = ((xx + off) // pw) % cols
        pid = r_ * cols + c_
        v = rng.uniform(vmin, 1.0, rows * cols + cols)[pid % (rows * cols + cols)]
        out = np.array(base, np.float32) * v[..., None]
        if stripe is not None:
            out[(xx // (N // 4)) % 4 == 1] *= stripe
        px_, py_ = (xx + off) % pw, yy % ph
        out[(px_ < 2) | (py_ < 2)] = seam
        if bolts:
            b = ((np.abs(px_ - 9) < 2) | (np.abs(px_ - (pw - 9)) < 2)) & ((np.abs(py_ - 9) < 2) | (np.abs(py_ - (ph - 9)) < 2))
            out[b] = np.array(seam) * 0.92
        return out
    save_png('skin', panels([232, 235, 238], 4, 2, 0.955, [166, 172, 179]))
    save_png('skin_ru', panels([226, 226, 220], 2, 2, 0.95, [160, 162, 158], stripe=0.9))
    # Hubble silver MLI: irregular patches, seams, quilting dots
    m = panels([214, 218, 222], 4, 3, 0.9, [150, 156, 162], bolts=False)
    m[((xx % 32) < 2) & ((yy % 32) < 2)] *= 0.85
    save_png('mli', m)
    # radiator: white with fine flow-tube lines
    n = 256
    ry, rx = np.mgrid[0:n, 0:n]
    r = np.zeros((n, n, 3), np.float32) + [238, 240, 242]
    r[(rx % 16) == 0] = [212, 216, 220]
    r[(rx % 128) < 3] = [196, 200, 205]
    r[(ry % 128) < 2] = [205, 208, 212]
    save_png('radiator', r)
    # Soyuz quilt: green-grey blanket with diamond stitching
    q = np.zeros((n, n, 3), np.float32) + [126, 134, 116]
    d1, d2 = (rx + ry) % 64, (rx - ry) % 64
    q[(d1 < 2) | (d2 < 2)] = [100, 107, 92]
    q[((rx % 32) == 16) & ((ry % 32) == 0)] = [150, 156, 140]
    save_png('quilt', q)
    log('textures written to', TEX)


# ------------------------------------------------------------------------------------------------ geometry core
class Geo:
    """Accumulates polygons (world coords), per-loop UVs in meters and per-face material names."""

    def __init__(self):
        self.V, self.F, self.UV, self.M, self.S = [], [], [], [], []

    def add(self, verts, faces, uvs, mats, m=None, soft=False):
        off = len(self.V)
        if m is not None:
            verts = [m @ Vector(v) for v in verts]
        self.V.extend((v[0], v[1], v[2]) for v in verts)
        for i, f in enumerate(faces):
            self.F.append(tuple(off + j for j in f))
            self.UV.append(uvs[i])
            self.M.append(mats if isinstance(mats, str) else mats[i])
            self.S.append(soft)


def rot_to(axis):
    """4x4 rotation taking local +Z onto the named axis."""
    return {'Z': Matrix.Identity(4), '-Z': Matrix.Rotation(math.pi, 4, 'X'),
            'X': Matrix.Rotation(math.pi / 2, 4, 'Y'), '-X': Matrix.Rotation(-math.pi / 2, 4, 'Y'),
            'Y': Matrix.Rotation(-math.pi / 2, 4, 'X'), '-Y': Matrix.Rotation(math.pi / 2, 4, 'X')}[axis]


def M(loc=(0, 0, 0), axis='Z', spin=0.0):
    return Matrix.Translation(Vector(loc)) @ rot_to(axis) @ Matrix.Rotation(spin, 4, 'Z')


def Mdir(p0, d):
    d = Vector(d).normalized()
    q = d.to_track_quat('Z', 'Y' if abs(d.y) < 0.9 else 'X')
    return Matrix.Translation(Vector(p0)) @ q.to_matrix().to_4x4()


def RZ(a):
    return Matrix.Rotation(a, 4, 'Z')


def T(loc):
    return Matrix.Translation(Vector(loc))


def revolve(g, prof, mat, m, segs=32, cap0=False, cap1=False, phase=0.0, arc=None, soft=False):
    """Lathe a profile [(r, z[, mat-of-band-to-next])] about local Z. Traverse z upward for outward normals.
    r == 0 makes a pole (triangle fan). arc=(a0, a1) makes an open partial surface."""
    P = [(p[0], p[1]) for p in prof]
    PM = [p[2] if len(p) > 2 else mat for p in prof]
    full = arc is None
    a0, a1 = (phase, phase + TAU) if full else arc
    n = segs if full else segs + 1
    ang = [a0 + (a1 - a0) * j / segs for j in range(n)]
    verts, faces, uvs, mats, rings = [], [], [], [], []
    for r, z in P:
        if r < 1e-6:
            rings.append([len(verts)])
            verts.append((0.0, 0.0, z))
        else:
            rings.append(list(range(len(verts), len(verts) + n)))
            verts += [(r * math.cos(a), r * math.sin(a), z) for a in ang]
    s = 0.0
    frac = (a1 - a0) / TAU
    for i in range(len(P) - 1):
        (r0, z0), (r1, z1) = P[i], P[i + 1]
        L = math.hypot(r1 - r0, z1 - z0)
        if L < 1e-9:
            continue
        bm = PM[i]
        rm = max((r0 + r1) / 2, 1e-3)
        t = tile(bm)
        C = max(1, round(TAU * rm * frac / t)) * t
        A, B = rings[i], rings[i + 1]
        if len(A) == 1 and len(B) == 1:
            continue
        for j in range(segs):
            j1 = (j + 1) % n
            u0, u1 = C * j / segs, C * (j + 1) / segs
            if len(A) == 1:
                faces.append((A[0], B[j1], B[j]))
                uvs.append([((u0 + u1) / 2, s), (u1, s + L), (u0, s + L)])
            elif len(B) == 1:
                faces.append((A[j], A[j1], B[0]))
                uvs.append([(u0, s), (u1, s), ((u0 + u1) / 2, s + L)])
            else:
                faces.append((A[j], A[j1], B[j1], B[j]))
                uvs.append([(u0, s), (u1, s), (u1, s + L), (u0, s + L)])
            mats.append(bm)
        s += L
    if full:
        if cap0 and len(rings[0]) > 1:
            f = tuple(reversed(rings[0]))
            faces.append(f); uvs.append([(verts[k][0], verts[k][1]) for k in f]); mats.append(PM[0])
        if cap1 and len(rings[-1]) > 1:
            f = tuple(rings[-1])
            faces.append(f); uvs.append([(verts[k][0], verts[k][1]) for k in f]); mats.append(PM[-2] if len(PM) > 1 else mat)
    g.add(verts, faces, uvs, mats, m, soft)


def cyl(g, r, z0, z1, mat, m, segs=32, bev=0.02, cap_mat=None):
    b = min(bev, r * 0.3, (z1 - z0) * 0.3)
    cm = cap_mat or mat
    revolve(g, [(0, z0, cm), (r - b, z0, mat), (r, z0 + b, mat), (r, z1 - b, mat), (r - b, z1, cm), (0, z1)], mat, m, segs)


def sphere(g, r, m, mat, segs=32, rings=16):
    revolve(g, [(r * math.sin(math.pi * k / rings), -r * math.cos(math.pi * k / rings)) for k in range(rings + 1)], mat, m, segs)


def dish(g, r, depth, m, mat='white', back='alu', segs=24):
    """Parabolic dish opening toward local +Z, apex at origin."""
    K = 6
    prof = [(r * k / K, depth * (k / K) ** 2, back) for k in range(K + 1)]
    prof += [(r + 0.02, depth + 0.01, mat)]
    prof += [(r * k / K, depth * (k / K) ** 2 + 0.03, mat) for k in range(K, -1, -1)]
    revolve(g, prof, mat, m, segs)


def beam(g, p0, p1, w, mat, sides=4, caps=False):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    L = d.length
    if L < 1e-6:
        return
    r = w / 2 / math.cos(math.pi / sides)
    revolve(g, [(r, 0), (r, L)], mat, Mdir(p0, d), segs=sides, cap0=caps, cap1=caps, phase=math.pi / sides, soft=True)


def box(g, size, loc, mat, bevel=0.0, m=None):
    """Axis-aligned (in local frame) box, optional chamfer. mat: name or {'+z': .., '-x': .., '*': default}."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for v in bm.verts:
        v.co = Vector((v.co.x * sx + loc[0], v.co.y * sy + loc[1], v.co.z * sz + loc[2]))
    if bevel > 0 and min(size) > 0.12:   # thin plates stay unbevelled (saves vertices, no visible gain)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, 0.45 * min(size)), offset_type='OFFSET',
                        segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
    bm.verts.index_update()
    verts = [tuple(v.co) for v in bm.verts]
    faces, uvs, mats = [], [], []
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        key = ('+' if n[ax] > 0 else '-') + 'xyz'[ax]
        if abs(n[ax]) < 0.9:
            key = '*'
        if isinstance(mat, str):
            mm = mat
        else:
            mm = mat.get(key, mat.get('*'))
        faces.append(tuple(v.index for v in f.verts))
        if ax == 2:
            uvs.append([(l.vert.co.x, l.vert.co.y) for l in f.loops])
        elif ax == 0:
            uvs.append([(l.vert.co.y, l.vert.co.z) for l in f.loops])
        else:
            uvs.append([(l.vert.co.x, l.vert.co.z) for l in f.loops])
        mats.append(mm)
    bm.free()
    g.add(verts, faces, uvs, mats, m)


def quad(g, pts, mat, m=None):
    """Single planar polygon from 3D points (UV = planar projection on its two largest axes)."""
    p = [Vector(v) for v in pts]
    n = (p[1] - p[0]).cross(p[2] - p[0])
    ax = max(range(3), key=lambda i: abs(n[i]))
    ia, ib = [i for i in range(3) if i != ax]
    g.add(p, [tuple(range(len(p)))], [[(v[ia], v[ib]) for v in p]], mat, m)


def lattice(g, p0, p1, w, h, bay, rod, mat, up=(0, 0, 1), diag=True):
    """Open rectangular box truss from p0 to p1 (centre line); w across, h along `up`."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    L = d.length
    d.normalize()
    upv = Vector(up)
    side = d.cross(upv).normalized()
    upv = side.cross(d).normalized()
    cs = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]

    def P(t, c):
        return p0 + d * t + side * c[0] + upv * c[1]
    for c in cs:
        beam(g, P(0, c), P(L, c), rod * 1.5, mat, caps=True)
    nb = max(1, round(L / bay))
    for k in range(nb + 1):
        t = L * k / nb
        for i in range(4):
            beam(g, P(t, cs[i]), P(t, cs[(i + 1) % 4]), rod, mat)
    if diag:
        for k in range(nb):
            t0, t1 = L * k / nb, L * (k + 1) / nb
            for i in range(4):
                ca, cb = cs[i], cs[(i + 1) % 4]
                if (k + i) % 2:
                    beam(g, P(t0, ca), P(t1, cb), rod * 0.8, mat)
                else:
                    beam(g, P(t0, cb), P(t1, ca), rod * 0.8, mat)


def tri_mast(g, p0, p1, w, bay, rod, mat, m=None):
    """Triangular lattice mast (FAST-mast look) along local X from x=p0 to x=p1 at y=z=0, then m."""
    m = m or Matrix.Identity(4)
    R = w / math.sqrt(3)
    cs = [(R * math.cos(a), R * math.sin(a)) for a in (math.pi / 2, math.pi / 2 + TAU / 3, math.pi / 2 + 2 * TAU / 3)]

    def P(x, c):
        return m @ Vector((x, c[0], c[1]))
    for c in cs:
        beam(g, P(p0, c), P(p1, c), rod * 1.3, mat, sides=4)
    nb = max(1, round((p1 - p0) / bay))
    for k in range(nb + 1):
        x = p0 + (p1 - p0) * k / nb
        for i in range(3):
            beam(g, P(x, cs[i]), P(x, cs[(i + 1) % 3]), rod, mat, sides=3)
        if k < nb:
            x1 = p0 + (p1 - p0) * (k + 1) / nb
            for i in range(3):
                beam(g, P(x, cs[i]), P(x1, cs[(i + 1) % 3]), rod * 0.7, mat, sides=3)


def flex_wing(g, root, ang, L, bw, gap, mast_w, bay, z=0.0, box_h=0.4, tip_h=0.28, rod=0.05):
    """Flexible two-blanket array wing (ISS/CSS style) extending along local +X from `root`, rotated `ang` about Z.
    Cells face +Z; blankets either side of a triangular mast."""
    m = T(root) @ RZ(ang)
    W = 2 * bw + gap
    yc = gap / 2 + bw / 2
    box(g, (0.7, min(1.4, gap * 0.9 + 0.3), 0.9), (0.35, 0, z), 'white', 0.04, m)        # mast canister
    for sy in (1, -1):
        box(g, (0.5, bw + 0.1, box_h), (0.3, sy * yc, z), {'+z': 'white', '*': 'band'}, 0.03, m)  # blanket box
        box(g, (L - 0.9, bw, 0.025), ((L - 0.9) / 2 + 0.55, sy * yc, z), {'+z': 'cells', '*': 'blanket_back'}, 0, m)
    box(g, (0.45, W, tip_h), (L - 0.2, 0, z), {'+z': 'white', '*': 'band'}, 0.03, m)       # tip fitting
    tri_mast(g, 0.7, L - 0.4, mast_w, bay, rod, 'alu', m @ T((0, 0, z)))
    for sy in (1, -1):   # tension / guide wires along blanket outer edges
        beam(g, m @ Vector((0.55, sy * (W / 2 + 0.05), z)), m @ Vector((L - 0.4, sy * (W / 2 + 0.05), z)), 0.03, 'alu', sides=3)


def rigid_wing(g, root, ang, n, plen, pw, gap=0.04, t=0.04, cells='cells_fine', arm=0.3, spine=True):
    """Rigid panel wing along local +X (n panels of plen x pw), cells +Z, rotated `ang` about Z at `root`."""
    m = T(root) @ RZ(ang)
    beam(g, m @ Vector((0, 0, 0)), m @ Vector((arm, 0, 0)), 0.09, 'alu', caps=True)
    x = arm
    for k in range(n):
        box(g, (plen, pw, t), (x + plen / 2, 0, 0), {'+z': cells, '*': 'panel_back'}, 0.008, m)
        x += plen + gap
    if spine:
        beam(g, m @ Vector((arm, 0, -t / 2 - 0.03)), m @ Vector((x - gap, 0, -t / 2 - 0.03)), 0.06, 'alu')
    return x - gap


# ------------------------------------------------------------------------------------------- shared vehicles
def pmod(g, m, L, r, mat='skin', rr=None, cone=0.9, bands=(), segs=40, ring0=True, ring1=True, end_mat=None):
    """Pressurised module along local Z (0..L): end cones to berthing rings, raised debris-shield bands."""
    rr = rr or min(1.0, r * 0.5)
    em = end_mat or mat
    P = []
    if ring0:
        P += [(0, 0, 'alu'), (rr, 0, 'alu'), (rr, 0.18, 'band'), (rr + 0.1, 0.22, em), (r - 0.12, cone, em), (r, cone + 0.1, mat)]
    else:
        P += [(0, 0, em), (r - 0.15, 0, em), (r, 0.15, mat)]
    for zb in bands:
        P += [(r, zb - 0.07, 'band'), (r + 0.035, zb - 0.05, 'band'), (r + 0.035, zb + 0.05, 'band'), (r, zb + 0.07, mat)]
    if ring1:
        P += [(r, L - cone - 0.1, em), (r - 0.12, L - cone, em), (rr + 0.1, L - 0.22, 'band'), (rr, L - 0.18, 'alu'), (rr, L, 'alu'), (0, L)]
    else:
        P += [(r, L - 0.15, em), (r - 0.15, L, em), (0, L)]
    revolve(g, P, mat, m, segs)


def port_ring(g, m, r_in, h=0.35, rr=0.95):
    """Unused CBM/docking ring sticking out of a hull (local +Z outward from radius r_in)."""
    revolve(g, [(0, r_in - 0.1, 'alu'), (rr, r_in - 0.1, 'alu'), (rr, r_in + h, 'band'), (rr - 0.12, r_in + h, 'dark'), (0, r_in + h)], 'alu', m, 24)


def soyuz(G, m, solar=None, progress=False, segs=48):
    """Soyuz MS (or Progress MS) in vehicle frame: +X forward (orbital module / probe), cells +Z.
    solar(pivot_world) -> Geo for a separate wing object, or None to merge wings into G."""
    X = m @ rot_to('X')
    SM = [(0, -3.58, 'dark'), (1.18, -3.58, 'dark'), (1.30, -3.52, 'band'), (1.36, -3.44, 'radiator'), (1.36, -2.62, 'band'),
          (1.36, -2.55, 'radiator'), (1.13, -2.32, 'radiator'), (1.13, -2.0, 'dark'), (1.06, -1.95, 'dark'), (1.06, -1.86, 'heat')]
    if not progress:
        mid = [(1.085, -1.80, 'quilt'), (1.08, -1.55), (1.05, -1.2), (0.99, -0.8), (0.91, -0.45), (0.80, -0.15), (0.68, 0.10),
               (0.57, 0.27, 'dark'), (0.50, 0.36, 'dark'), (0.46, 0.40, 'dark'), (0.46, 0.52, 'quilt')]
        c, a, b = 1.78, 1.30, 1.13
    else:
        mid = [(1.06, -1.80, 'quilt'), (1.06, -0.30), (0.92, 0.18), (0.55, 0.42, 'dark'), (0.48, 0.52, 'quilt')]
        c, a, b = 1.86, 1.36, 1.13
    om = []
    for k in range(16):
        t = math.radians(-62 + k * 122 / 15)
        om.append((b * math.cos(t), c + a * math.sin(t), 'quilt'))
    ze = om[-1][1]
    dock = [(om[-1][0], ze, 'band'), (0.62, ze + 0.04, 'alu'), (0.62, ze + 0.21, 'alu'), (0.45, ze + 0.27, 'dark'),
            (0.13, ze + 0.34, 'alu'), (0.09, ze + 0.44, 'alu'), (0.045, ze + 0.75, 'alu'), (0, ze + 0.83)]
    om[-1] = (om[-1][0], om[-1][1], 'band')
    revolve(G, SM + mid + om[:-1] + dock, 'quilt', X, segs)
    revolve(G, [(0.12, -3.50, 'dark'), (0.12, -3.60, 'dark'), (0.30, -3.76, 'black'), (0.27, -3.76, 'black'), (0.09, -3.62, 'black'), (0, -3.62)], 'dark', X, 24)

    def surf(x, r, ang, out=0.0):
        return m @ Vector((x, (r + out) * math.cos(ang), (r + out) * math.sin(ang)))

    def radial(x, r, ang, length, w, mat, sides=6):
        p0 = surf(x, r, ang, -0.02)
        p1 = surf(x, r, ang, length)
        beam(G, p0, p1, w, mat, sides=sides, caps=True)
    # windows (glass nubs), periscope blister, antennas
    if not progress:
        radial(-0.9, 1.0, math.radians(100), 0.04, 0.24, 'glass', 12)
        radial(-0.6, 0.95, math.radians(220), 0.04, 0.22, 'glass', 12)
        radial(-0.35, 0.86, math.radians(300), 0.12, 0.26, 'dark', 6)
        radial(1.4, 1.11, math.radians(-40), 0.04, 0.22, 'glass', 12)
    for ang, x in ((135, 2.5), (45, 2.3)):
        a_ = math.radians(ang)
        p0 = surf(x, 0.95, a_)
        p1 = surf(x + 0.8, 0.95, a_, 0.9)
        beam(G, p0, p1, 0.035, 'alu', 4)
    a_ = math.radians(270)
    p0, p1 = surf(1.6, 1.12, a_), surf(1.6, 1.12, a_, 0.55)
    beam(G, p0, p1, 0.06, 'alu', 6, True)
    dish(G, 0.2, 0.06, Mdir(p1, (m.to_3x3() @ Vector((0.5, 0, -1))).normalized()), 'white', 'alu', 16)
    for ang in (60, 240):
        a_ = math.radians(ang)
        beam(G, surf(-3.35, 1.36, a_), surf(-4.2, 1.36, a_, 0.6), 0.035, 'alu', 4)
    for ang in (0, 90, 180, 270):   # attitude thruster blocks on the service module skirt
        a_ = math.radians(ang + 45)
        p = surf(-3.25, 1.36, a_, 0.06)
        box(G, (0.25, 0.16, 0.16), (0, 0, 0), 'dark', 0.02, T(p) @ Matrix.Rotation(a_, 4, 'X'))
    # solar wings: rotation axis = line x=xa, z=0 (vehicle frame), parallel to Y
    xa = -3.0
    for s in (1, -1):
        pivot = m @ Vector((xa, s * 1.36, 0))
        tg = solar(pivot) if solar else G
        beam(tg, m @ Vector((xa, s * 1.15, 0)), m @ Vector((xa, s * 1.62, 0)), 0.1, 'alu', caps=True)
        mw = m @ T((xa, s * 1.62, 0)) @ RZ(s * math.pi / 2)
        y = 0.0
        for k in range(4):
            box(tg, (0.895, 1.12, 0.035), (y + 0.895 / 2, 0, 0), {'+z': 'cells_fine', '*': 'panel_back'}, 0.008, mw)
            y += 0.935
        beam(tg, mw @ Vector((0, 0, -0.05)), mw @ Vector((y - 0.04, 0, -0.05)), 0.05, 'alu')


def shenzhou(G, m, segs=48):
    X = m @ rot_to('X')
    P = [(0, -4.5, 'dark'), (1.25, -4.5, 'dark'), (1.4, -4.4, 'radiator'), (1.4, -2.0, 'band'), (1.4, -1.92, 'radiator'),
         (1.25, -1.75, 'dark'), (1.25, -1.62, 'heat'), (1.26, -1.58, 'dm_grey'), (1.24, -1.3), (1.15, -0.8), (1.02, -0.3),
         (0.85, 0.2), (0.68, 0.6, 'dark'), (0.6, 0.75, 'dark'), (0.6, 0.9, 'skin_ru'), (0.95, 1.05), (1.125, 1.35),
         (1.125, 3.6), (0.95, 3.95, 'alu'), (0.7, 4.1, 'alu'), (0.7, 4.4, 'dark'), (0.5, 4.45, 'dark'), (0, 4.5)]
    revolve(G, P, 'dm_grey', X, segs)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        revolve(G, [(0.1, 0, 'dark'), (0.22, -0.3, 'black'), (0.19, -0.3, 'black'), (0, -0.15)], 'dark',
                m @ T((-4.5, 0.6 * math.cos(a), 0.6 * math.sin(a))) @ rot_to('X'), 12)
    for s in (1, -1):
        beam(G, m @ Vector((-3.3, s * 1.3, 0)), m @ Vector((-3.3, s * 1.75, 0)), 0.12, 'alu', caps=True)
        mw = m @ T((-3.3, s * 1.75, 0)) @ RZ(s * math.pi / 2)
        y = 0
        for k in range(4):
            box(G, (1.66, 2.0, 0.04), (y + 0.83, 0, 0), {'+z': 'cells_fine', '*': 'panel_back'}, 0.01, mw)
            y += 1.71
        beam(G, mw @ Vector((0, 0, -0.06)), mw @ Vector((y, 0, -0.06)), 0.06, 'alu')


def tianzhou(G, m, segs=48):
    X = m @ rot_to('X')
    P = [(0, -5.3, 'dark'), (1.3, -5.3, 'dark'), (1.4, -5.2, 'radiator'), (1.4, -1.1, 'band'), (1.45, -1.0, 'band'),
         (1.675, -0.6, 'skin_ru'), (1.675, 0.8, 'band'), (1.71, 0.85, 'band'), (1.675, 0.9, 'skin_ru'), (1.675, 3.6, 'skin_ru'),
         (1.2, 4.6, 'skin_ru'), (0.7, 4.9, 'alu'), (0.7, 5.15, 'dark'), (0.5, 5.2, 'dark'), (0, 5.3)]
    revolve(G, P, 'skin_ru', X, segs)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        revolve(G, [(0.1, 0, 'dark'), (0.25, -0.35, 'black'), (0.22, -0.35, 'black'), (0, -0.2)], 'dark',
                m @ T((-5.3, 0.65 * math.cos(a), 0.65 * math.sin(a))) @ rot_to('X'), 12)
    for s in (1, -1):
        beam(G, m @ Vector((-3.4, s * 1.3, 0)), m @ Vector((-3.4, s * 1.65, 0)), 0.12, 'alu', caps=True)
        mw = m @ T((-3.4, s * 1.65, 0)) @ RZ(s * math.pi / 2)
        y = 0
        for k in range(3):
            box(G, (1.9, 2.2, 0.04), (y + 0.95, 0, 0), {'+z': 'cells_fine', '*': 'panel_back'}, 0.01, mw)
            y += 1.95
        beam(G, mw @ Vector((0, 0, -0.06)), mw @ Vector((y, 0, -0.06)), 0.06, 'alu')


def dragon(G, m, segs=56):
    """Crew Dragon in vehicle frame: +X = nose (docking adapter), trunk aft."""
    X = m @ rot_to('X')
    P = [(0, -4.05, 'dark'), (1.72, -4.05, 'dark'), (1.85, -3.95, 'white'), (1.85, -0.3, 'band'), (1.88, -0.22, 'heat'),
         (1.97, -0.12, 'heat'), (2.0, 0.0, 'white'), (1.97, 0.18, 'white'), (1.15, 3.05, 'white'), (1.05, 3.2, 'dark'),
         (0.85, 3.35, 'alu'), (0.75, 3.42, 'alu'), (0.75, 3.85, 'dark'), (0.6, 3.95, 'dark'), (0, 3.95)]
    revolve(G, P, 'white', X, segs)
    revolve(G, [(1.862, -3.55), (1.862, -0.7)], 'cells_fine', X, 28, arc=(math.radians(-90), math.radians(90)))
    # open nose cone, hinged at the top of the capsule
    revolve(G, [(0, 0.32, 'white'), (0.55, 0.25), (0.85, 0.1), (0.95, 0.0, 'dark'), (0.85, 0.03, 'dark'), (0, 0.2)], 'white',
            m @ T((3.55, 0, 1.15)) @ Matrix.Rotation(math.radians(-35), 4, 'Y') @ rot_to('Z'), 32)
    for k, a in enumerate((25, 155, 205, 335)):   # windows
        ar = math.radians(a)
        x, r = 1.4, 1.97 - (1.4 - 0.18) * (0.82 / 2.87)
        n = Vector((0.27, math.cos(ar), math.sin(ar))).normalized()
        p = m @ Vector((x, r * math.cos(ar), r * math.sin(ar)))
        cyl(G, 0.13, -0.02, 0.03, 'glass', Mdir(p, m.to_3x3() @ n), 16, 0.01)
    for a in (45, 135, 225, 315):   # SuperDraco pods
        ar = math.radians(a)
        x, r = 0.7, 1.97 - (0.7 - 0.18) * (0.82 / 2.87)
        p = m @ Vector((x, r * math.cos(ar), r * math.sin(ar)))
        box(G, (0.7, 0.35, 0.14), (0, 0, 0), 'white', 0.05, T(p) @ Matrix.Rotation(ar, 4, 'X') @ Matrix.Rotation(-0.27, 4, 'Y'))


def cupola(g, m):
    """ISS Cupola, local +Z = outward (dome pointing away from the module)."""
    cyl(g, 1.5, 0.0, 0.35, 'alu', m, 36, 0.04)
    hexR0, hexR1, z0, z1 = 1.45, 0.95, 0.35, 1.2
    revolve(g, [(hexR0, z0, 'alu'), (hexR1, z1, 'alu'), (0, z1 + 0.05, 'alu')], 'alu', m, 6, phase=0)
    for k in range(6):
        a0, a1 = TAU * k / 6, TAU * (k + 1) / 6
        c0 = [Vector((hexR0 * math.cos(a), hexR0 * math.sin(a), z0)) for a in (a0, a1)]
        c1 = [Vector((hexR1 * math.cos(a), hexR1 * math.sin(a), z1)) for a in (a0, a1)]
        ctr = (c0[0] + c0[1] + c1[0] + c1[1]) / 4
        n = (c0[1] - c0[0]).cross(c1[0] - c0[0]).normalized()
        if n.dot(ctr) < 0:
            n = -n
        pts = [ctr + (p - ctr) * 0.72 + n * 0.015 for p in (c0[0], c0[1], c1[1], c1[0])]
        quad(g, pts, 'glass', m)
    cyl(g, 0.4, z1 + 0.02, z1 + 0.08, 'lamp', m, 24, 0.01, cap_mat='lamp')


def apply_rot_box(g, size, center, dirx, mat, bevel=0.0):
    """Box whose local X follows dirx (rotation about world Y only)."""
    ang = math.atan2(-dirx[2], dirx[0])
    box(g, size, (0, 0, 0), mat, bevel, T(center) @ Matrix.Rotation(ang, 4, 'Y'))


# ---------------------------------------------------------------------------------------------------------- ISS
def build_iss():
    G, SOL = Geo(), []

    def solar(name, origin):
        g = Geo()
        SOL.append((name, Vector(origin), g))
        return g
    ZT, TW, TH = 4.7, 4.2, 3.6          # truss centreline height, width (X), height (Z)
    PORT = 1                             # port side = +Y (starboard = -Y, see module docstring)
    # ---------- integrated truss (main mesh part): S0, P1/S1, P3/S3, SARJ, P5/S5
    lattice(G, (0, -6.7, ZT), (0, 6.7, ZT), TW, TH, 3.35, 0.16, 'truss')
    box(G, (3.2, 13.0, 2.6), (0, 0, ZT), {'+z': 'skin', '-z': 'skin', '*': 'white'}, 0.06)
    for y in (-4.5, -1.5, 1.5, 4.5):
        box(G, (1.2, 2.2, 0.5), (0.6, y, ZT + 1.55), 'band', 0.03)
    for s in (1, -1):
        lattice(G, (0, s * 6.7, ZT), (0, s * 20.0, ZT), TW, TH, 3.3, 0.15, 'truss')
        lattice(G, (0, s * 20.0, ZT), (0, s * 25.4, ZT), TW, TH, 2.7, 0.15, 'truss')
        lattice(G, (0, s * 40.4, ZT), (0, s * 43.0, ZT), TW * 0.9, TH * 0.9, 2.6, 0.14, 'truss')
        box(G, (2.2, 5.5, 1.8), (0.2, s * 10.5, ZT - 0.2), 'white', 0.05)
        box(G, (1.6, 3.2, 1.4), (-0.3, s * 16.5, ZT + 0.1), 'band', 0.04)
        cyl(G, 1.5, 0, 0.8, 'alu', M((0, s * 7.0, ZT), 'Y' if s > 0 else '-Y'), 28, 0.05)   # TRRJ
        cyl(G, 2.35, 0, 1.4, 'alu', M((0, s * 25.4, ZT), 'Y' if s > 0 else '-Y'), 40, 0.08)  # SARJ
        cyl(G, 2.42, 0.5, 0.9, 'dark', M((0, s * 25.4, ZT), 'Y' if s > 0 else '-Y'), 40, 0.02)
        # P3/S3 ExPRESS logistics carriers
        for zz in (1, -1):
            box(G, (3.4, 4.4, 0.25), (0, s * 22.7, ZT + zz * (TH / 2 + 0.2)), 'alu', 0.03)
            for k, (dx, dy, mt) in enumerate(((-0.9, -1.2, 'white'), (0.9, -1.0, 'gold'), (-0.8, 1.1, 'band'), (0.9, 1.2, 'white'))):
                hgt = 0.6 + 0.25 * (k % 2)
                box(G, (1.3, 1.6, hgt), (dx, s * 22.7 + dy, ZT + zz * (TH / 2 + 0.33 + hgt / 2)), mt, 0.04)
        # heat rejection radiators (3 per side), extending aft and 20 deg down from P1/S1
        box(G, (0.9, 11.2, 1.1), (-TW / 2 - 0.45, s * 12.8, ZT), 'white', 0.05)
        d = Vector((-math.cos(math.radians(20)), 0, -math.sin(math.radians(20))))
        for yc in (9.2, 12.8, 16.4):
            r0 = Vector((-TW / 2 - 0.9, s * yc, ZT))
            for i in range(8):
                apply_rot_box(G, (2.82, 3.4, 0.06), r0 + d * (0.3 + i * 2.9 + 1.41), d, 'radiator', 0.015)
            for e in (1, -1):
                beam(G, r0 + Vector((0, e * 1.72, 0)), r0 + d * 23.5 + Vector((0, e * 1.72, 0)), 0.07, 'alu')
    # AMS-02 on S3 zenith
    ys = -PORT * 22.7
    box(G, (3.2, 3.6, 0.5), (0, ys, ZT + TH / 2 + 0.6 + 0.25), 'white', 0.05)
    cyl(G, 1.5, ZT + TH / 2 + 0.85, ZT + TH / 2 + 3.0, 'alu', M((0, ys, 0)), 32, 0.06)
    for e in (1, -1):
        box(G, (0.08, 3.4, 2.4), (e * 1.9, ys, ZT + TH / 2 + 2.1), 'radiator', 0.01)
    # ---------- sun-tracking array pairs: P6, P4, S4, S6 (alpha gimbal = rotation about Y)
    pairs = [('solar_1', PORT * 48.7, PORT * 43.0, PORT * 54.4), ('solar_2', PORT * 33.6, PORT * 26.8, PORT * 40.4),
             ('solar_3', -PORT * 33.6, -PORT * 26.8, -PORT * 40.4), ('solar_4', -PORT * 48.7, -PORT * 43.0, -PORT * 54.4)]
    for name, yc, ya, yb in pairs:
        g = solar(name, (0, yc, ZT))
        lattice(g, (0, ya, ZT), (0, yb, ZT), TW * 0.95, TH * 0.95, 2.9, 0.14, 'truss')
        box(g, (3.0, 5.2, 2.6), (0, yc, ZT), {'+z': 'skin', '*': 'white'}, 0.06)               # IEA
        for k in (-1, 1):
            box(g, (1.2, 1.8, 0.7), (0.5 * k, yc + k * 3.6, ZT + 1.5), 'band', 0.03)
        # photovoltaic radiator, deployed toward nadir on the inboard side
        yr = yc - math.copysign(4.6, yc)
        for i in range(7):
            box(g, (3.1, 0.05, 1.75), (0, yr, ZT - TH / 2 - 0.5 - i * 1.82 - 0.88), 'radiator', 0.012)
        for sx in (1, -1):
            cyl(g, 0.6, 0, 0.9, 'alu', M((sx * 1.6, yc, ZT), 'X' if sx > 0 else '-X'), 28, 0.05)   # beta gimbal
            flex_wing(g, Vector((sx * 2.5, yc, ZT)), 0 if sx > 0 else math.pi, 34.8, 4.57, 2.46, 0.78, 2.0)
    # ---------- US / international pressurised segment (axis along X)
    pmod(G, M((4.3, 0, 0), 'X'), 7.2, 2.2, bands=(2.6, 4.6))                      # Harmony (Node 2)
    pmod(G, M((-4.25, 0, 0), 'X'), 8.5, 2.15, bands=(2.2, 4.25, 6.3))             # Destiny
    pmod(G, M((-9.8, 0, 0), 'X'), 5.5, 2.3, bands=(2.75,))                         # Unity (Node 1)
    revolve(G, [(0, 0, 'alu'), (0.9, 0, 'alu'), (0.9, 0.2, 'skin'), (1.35, 1.55, 'skin'), (1.35, 1.8, 'alu'), (1.0, 2.0, 'alu'), (0, 2.0)],
            'skin', M((-11.8, 0, 0), 'X'), 32)                                     # PMA-1
    # Destiny -> S0 struts and nadir window
    for sx in (1, -1):
        for sy in (1, -1):
            beam(G, (sx * 1.6, sy * 1.2, 1.7), (sx * 1.5, sy * 3.0, ZT - TH / 2), 0.16, 'alu', caps=True)
    cyl(G, 0.32, 2.12, 2.2, 'glass', M((0.5, 0, 0), '-Z'), 20, 0.01)
    # Harmony: PMA-2 + IDA-2 forward, PMA-3/IDA-3 zenith, nadir CBM
    revolve(G, [(0, 0, 'alu'), (1.1, 0, 'alu'), (1.35, 0.2, 'skin'), (1.0, 1.5, 'skin'), (0.95, 1.7, 'alu'), (1.0, 2.0, 'band'),
                (0.95, 2.1, 'dark'), (0, 2.1)], 'skin', M((11.5, 0, 0), 'X'), 32)
    revolve(G, [(0, 0, 'alu'), (1.1, 0, 'alu'), (1.35, 0.2, 'skin'), (1.0, 1.5, 'skin'), (0.95, 1.7, 'alu'), (1.0, 2.0, 'band'),
                (0.95, 2.1, 'dark'), (0, 2.1)], 'skin', M((7.9, 0, 2.15), 'Z'), 32)
    port_ring(G, M((7.9, 0, 0), '-Z'), 2.2)
    # Columbus (starboard of Harmony) with external payload facility
    pmod(G, M((7.9, -PORT * 2.15, 0), '-Y' if PORT > 0 else 'Y'), 6.9, 2.24, bands=(3.4,))
    for k, (dx, dz, mt) in enumerate(((1.2, 1.0, 'white'), (-1.2, 1.0, 'gold'), (1.2, -1.0, 'band'), (-1.1, -1.0, 'white'))):
        box(G, (1.0, 1.2, 1.1), (7.9 + dx, -PORT * 8.6, dz), mt, 0.05)
    # Kibo PM (port of Harmony), ELM-PS, exposed facility, JEM-RMS
    pmod(G, M((7.9, PORT * 2.15, 0), 'Y' if PORT > 0 else '-Y'), 11.2, 2.2, bands=(2.8, 5.6, 8.4))
    pmod(G, M((7.9, PORT * 4.6, 2.1), 'Z'), 4.2, 2.2, bands=(2.1,))
    cyl(G, 1.1, 0, 0.6, 'alu', M((7.9, PORT * 13.3, 0), 'Y' if PORT > 0 else '-Y'), 28, 0.04)
    yef = PORT * (13.9 + 2.8)
    box(G, (4.6, 5.6, 1.0), (7.9, yef, 0), {'+z': 'skin', '-z': 'skin', '*': 'white'}, 0.06)
    for k, (dx, dy, dz, mt) in enumerate(((1.2, -1.6, 1, 'white'), (-1.2, -1.4, 1, 'gold'), (1.1, 1.2, 1, 'band'),
                                          (-1.1, 1.4, 1, 'white'), (1.0, 0.0, -1, 'gold'), (-1.0, 0.6, -1, 'white'))):
        h = 0.9 + 0.2 * (k % 3)
        box(G, (1.6, 1.8, h), (7.9 + dx, yef + dy, dz * (0.5 + h / 2)), mt, 0.05)
    jb = Vector((7.9 + 1.4, PORT * 12.5, 2.0))
    je = jb + Vector((1.2, PORT * 2.2, 2.4))
    jw = je + Vector((1.6, PORT * 3.5, -1.6))
    for a, b in ((jb, je), (je, jw)):
        cyl(G, 0.17, 0, (b - a).length, 'white', Mdir(a, b - a), 12, 0.03)
    for p in (jb, je, jw):
        sphere(G, 0.3, T(p), 'dark', 12, 6)
    # Tranquility (port of Unity) + Cupola (nadir) + BEAM (aft); PMM on Unity nadir; Quest (starboard of Unity)
    pmod(G, M((-7.0, PORT * 2.3, 0), 'Y' if PORT > 0 else '-Y'), 6.7, 2.24, bands=(2.4, 4.4))
    cupola(G, T((-7.0, PORT * 5.6, -2.2)) @ rot_to('-Z'))
    revolve(G, [(0, 0, 'alu'), (0.9, 0, 'alu'), (0.9, 0.3, 'blanket_back'), (1.5, 0.6), (1.6, 1.0), (1.6, 3.0), (1.4, 3.6),
                (0.9, 3.95), (0, 4.0)], 'blanket_back', M((-7.0 - 2.2, PORT * 6.2, 0), '-X'), 32)
    pmod(G, M((-7.0, 0, -2.3), '-Z'), 6.4, 2.2, bands=(2.1, 4.2))
    revolve(G, [(0, 0, 'alu'), (1.0, 0, 'alu'), (1.0, 0.2, 'band'), (1.6, 0.5, 'skin'), (2.0, 0.9, 'skin'), (2.0, 2.3, 'skin'),
                (1.6, 2.7, 'skin'), (1.0, 2.9, 'band'), (1.0, 5.0, 'skin'), (0.8, 5.2, 'alu'), (0, 5.2)], 'skin',
            M((-7.0, -PORT * 2.3, 0), '-Y' if PORT > 0 else 'Y'), 36)
    for k in range(4):
        sphere(G, 0.48, T((-7.0 + (-1.1 if k < 2 else 1.1), -PORT * (3.2 + 1.1 * (k % 2)), 2.15)), 'gold' if k % 2 else 'white', 16, 8)
    # Z1 truss on Unity zenith with Ku-band antenna
    lattice(G, (-7.0, 0, 2.4), (-7.0, 0, 5.6), 3.4, 3.2, 1.6, 0.13, 'truss', up=(1, 0, 0))
    box(G, (2.4, 2.4, 2.2), (-7.0, 0, 4.0), 'white', 0.05)
    beam(G, (-7.0, -1.3, 5.6), (-7.0, -1.3, 8.4), 0.18, 'alu', caps=True)
    dish(G, 1.0, 0.35, Mdir((-7.0, -1.3, 8.5), (0.6, -0.3, 0.75)), 'white', 'alu', 28)
    # Canadarm2 on the Mobile Base System (forward face of S0)
    box(G, (1.4, 4.4, 3.2), (TW / 2 + 0.75, -2.8 * PORT, ZT), 'white', 0.06)
    sh = Vector((TW / 2 + 1.6, -2.8 * PORT, ZT + 1.2))
    el = sh + Vector((1.0, -5.0 * PORT, 5.2))
    wr = el + Vector((1.5, -5.5 * PORT, -4.8))
    for a, b in ((sh, el), (el, wr)):
        cyl(G, 0.19, 0.3, (b - a).length - 0.3, 'white', Mdir(a, b - a), 16, 0.03)
    for p in (sh, el, wr):
        cyl(G, 0.34, -0.45, 0.45, 'dark', T(p) @ rot_to('Y'), 16, 0.04)
    cyl(G, 0.34, 0.4, 1.4, 'white', Mdir(wr, (0.1, 0, -1)), 16, 0.04)
    # ---------- Russian segment
    zr = [(0, 0, 'alu'), (0.8, 0, 'alu'), (0.8, 0.3, 'band'), (1.3, 0.4, 'skin_ru'), (2.05, 1.3, 'skin_ru')]
    for zb in (3.6, 6.0, 8.3):
        zr += [(2.05, zb - 0.07, 'band'), (2.08, zb - 0.05, 'band'), (2.08, zb + 0.05, 'band'), (2.05, zb + 0.07, 'skin_ru')]
    zr += [(2.05, 9.8, 'skin_ru'), (1.35, 10.6, 'skin_ru'), (1.42, 11.4, 'skin_ru'), (1.2, 12.0, 'band'), (0.8, 12.25, 'alu'), (0.8, 12.6, 'alu'), (0, 12.6)]
    revolve(G, zr, 'skin_ru', M((-24.4, 0, 0), 'X'), 40)                              # Zarya
    for e in (1, -1):
        box(G, (3.5, 0.06, 1.6), (-19.5, e * 2.1, -0.6), 'radiator', 0.01)
    zv = [(0, 0, 'alu'), (0.8, 0, 'alu'), (0.8, 0.3, 'band'), (1.2, 0.35, 'skin_ru'), (2.07, 0.9, 'skin_ru')]
    for zb in (2.2, 4.0):
        zv += [(2.07, zb - 0.07, 'band'), (2.10, zb - 0.05, 'band'), (2.10, zb + 0.05, 'band'), (2.07, zb + 0.07, 'skin_ru')]
    zv += [(2.07, 5.3, 'skin_ru'), (1.45, 6.5, 'skin_ru'), (1.45, 8.6, 'band'), (1.48, 8.65, 'band'), (1.45, 8.7, 'skin_ru'),
           (1.45, 10.6, 'band'), (1.2, 10.75, 'skin_ru'), (1.25, 11.4, 'skin_ru'), (1.15, 12.1, 'skin_ru'), (0.8, 12.55, 'alu'),
           (0.8, 13.1, 'alu'), (0, 13.1)]
    revolve(G, zv, 'skin_ru', M((-37.5, 0, 0), 'X'), 40)                              # Zvezda (+ forward node)
    for e in (1, -1):
        box(G, (2.6, 0.06, 1.4), (-28.8, e * 1.52, 0.3), 'radiator', 0.01)
        beam(G, (-28.0, e * 1.4, 0.9), (-27.2, e * 2.6, 2.0), 0.05, 'alu', 4)
    # Zvezda sun-tracking wings (about the Y line through x=-31.5, z=0)
    for name, s in (('solar_5', PORT), ('solar_6', -PORT)):
        g = solar(name, (-31.5, s * 1.85, 0))
        cyl(g, 0.22, 0, 0.6, 'alu', M((-31.5, s * 1.65, 0), 'Y' if s > 0 else '-Y'), 16, 0.03)
        mw = T((-31.5, s * 2.25, 0)) @ RZ(s * math.pi / 2)
        y = 0
        for k in range(6):
            box(g, (2.05, 3.3, 0.05), (y + 1.025, 0, 0), {'+z': 'cells', '*': 'panel_back'}, 0.01, mw)
            y += 2.12
        for e in (1, -1):
            beam(g, mw @ Vector((0, e * 1.68, 0)), mw @ Vector((y, e * 1.68, 0)), 0.06, 'alu')
        beam(g, mw @ Vector((0, 0, -0.06)), mw @ Vector((y, 0, -0.06)), 0.08, 'alu')
    xn = -24.4 - 1.25
    pmod(G, M((xn, 0, 1.15), 'Z'), 4.0, 1.27, mat='skin_ru', rr=0.8, cone=0.45, bands=(2.0,))     # Poisk
    nk = [(0, 0, 'alu'), (0.8, 0, 'alu'), (0.8, 0.25, 'band'), (1.45, 0.8, 'skin_ru'), (1.45, 4.5, 'skin_ru'), (2.12, 5.4, 'skin_ru')]
    for zb in (7.5, 10.0):
        nk += [(2.12, zb - 0.07, 'band'), (2.15, zb - 0.05, 'band'), (2.15, zb + 0.05, 'band'), (2.12, zb + 0.07, 'skin_ru')]
    nk += [(2.12, 12.3, 'skin_ru'), (1.2, 12.9, 'band'), (0.8, 13.1, 'alu'), (0.8, 13.3, 'alu'), (0, 13.3)]
    revolve(G, nk, 'skin_ru', M((xn, 0, -1.15), '-Z'), 40)                             # Nauka
    zp = -1.15 - 13.3 - 1.55
    sphere(G, 1.6, T((xn, 0, zp)), 'skin_ru', 32, 16)                                   # Prichal
    for ax in ('X', '-X', 'Y', '-Y', '-Z'):
        port_ring(G, T((xn, 0, zp)) @ rot_to(ax), 1.55, 0.3, 0.7)
    for e in (1, -1):
        box(G, (0.06, 2.0, 4.5), (xn + e * 2.2, 0, -10.0), 'radiator', 0.01)
    ea, eb, ec = Vector((xn, 2.35, -3.0)), Vector((xn, 2.35, -8.6)), Vector((xn + 0.6, 2.35, -13.4))   # ERA
    for a, b in ((ea, eb), (eb, ec)):
        cyl(G, 0.13, 0.2, (b - a).length - 0.2, 'white', Mdir(a, b - a), 12, 0.02)
    for p in (ea, eb, ec):
        sphere(G, 0.25, T(p), 'dark', 12, 6)
    pmod(G, M((-13.0, 0, -1.35), '-Z'), 6.0, 1.17, mat='skin_ru', rr=0.7, cone=0.4, bands=(3.0,))   # Rassvet
    # ---------- visiting vehicles: Soyuz on Rassvet (nadir), Progress on Zvezda aft, Crew Dragon on Harmony fwd
    soyuz(G, T((-13.0, 0, -1.35 - 6.0 - 3.74 - 0.05)) @ Matrix.Rotation(-math.pi / 2, 4, 'Y'), segs=36)
    soyuz(G, T((-37.5 - 3.86 - 0.05, 0, 0)), progress=True, segs=36)
    dragon(G, T((13.6 + 0.05 + 3.95, 0, 0)) @ RZ(math.pi), segs=40)
    return G, SOL


# ---------------------------------------------------------------------------------------------------------- CSS
def build_css():
    G, SOL = Geo(), []

    def solar(name, origin):
        g = Geo()
        SOL.append((name, Vector(origin), g))
        return g
    # Tianhe forward node at the origin; Tianhe core extends aft (-X)
    sphere(G, 1.4, T((0, 0, 0)), 'skin_ru', 40, 20)
    port_ring(G, T((0, 0, 0)) @ rot_to('-Z'), 1.35, 0.3, 0.7)
    port_ring(G, T((0, 0, 0)) @ rot_to('Z'), 1.35, 0.15, 0.6)
    th = [(0, 0, 'alu'), (0.75, 0, 'alu'), (0.75, 0.35, 'band'), (1.6, 0.4, 'dark'), (2.0, 0.5, 'band'), (2.1, 0.6, 'radiator'),
          (2.1, 3.0, 'band'), (2.13, 3.05, 'band'), (2.1, 3.1, 'skin_ru')]
    for zb in (5.0, 7.3):
        th += [(2.1, zb - 0.07, 'band'), (2.135, zb - 0.05, 'band'), (2.135, zb + 0.05, 'band'), (2.1, zb + 0.07, 'skin_ru')]
    th += [(2.1, 9.6, 'skin_ru'), (1.4, 10.6, 'skin_ru'), (1.4, 12.25, 'band'), (1.43, 12.3, 'band'), (1.4, 12.35, 'skin_ru'),
           (1.4, 14.0, 'band'), (1.05, 14.25, 'skin_ru'), (1.0, 14.45)]
    x_aft = -15.2
    revolve(G, th, 'skin_ru', M((x_aft, 0, 0), 'X'), 44)                                  # Tianhe
    for k in range(4):
        a = math.radians(45 + 90 * k)
        revolve(G, [(0.18, 0, 'dark'), (0.42, -0.6, 'black'), (0.38, -0.6, 'black'), (0, -0.3)], 'dark',
                T((x_aft + 0.4, 1.3 * math.cos(a), 1.3 * math.sin(a))) @ rot_to('X'), 16)
    for e in (1, -1):
        box(G, (2.2, 0.06, 1.8), (-7.0, e * 2.13, -0.9), 'radiator', 0.01)
    # Chinarm folded along Tianhe (zenith side)
    ca, cb, cc = Vector((-2.4, 0.6, 1.55)), Vector((-7.6, 0.6, 2.35)), Vector((-3.2, 0.6, 2.75))
    for a, b in ((ca, cb), (cb, cc)):
        cyl(G, 0.17, 0.25, (b - a).length - 0.25, 'white', Mdir(a, b - a), 14, 0.03)
    for p in (ca, cb, cc):
        sphere(G, 0.3, T(p), 'dark', 12, 6)
    # Tianhe wings (each its own object, rotating about the Y line x=-8, z=0)
    for name, s in (('solar_3', 1), ('solar_4', -1)):
        g = solar(name, (-8.0, s * 2.1, 0))
        cyl(g, 0.25, 0, 0.6, 'alu', M((-8.0, s * 2.0, 0), 'Y' if s > 0 else '-Y'), 16, 0.03)
        flex_wing(g, Vector((-8.0, s * 2.55, 0)), s * math.pi / 2, 12.0, 1.35, 0.42, 0.36, 0.8, box_h=0.3, tip_h=0.2, rod=0.035)
    # Wentian (-Y, starboard) and Mengtian (+Y, port) labs with their big arrays
    for name, s, lab in (('solar_1', 1, 'mengtian'), ('solar_2', -1, 'wentian')):
        ax = 'Y' if s > 0 else '-Y'
        lp = [(0.95, 0.0, 'band'), (0.95, 0.25, 'alu'), (1.25, 0.35, 'skin_ru'), (2.1, 1.6, 'skin_ru')]
        for zb in (3.6, 6.0, 8.2):
            lp += [(2.1, zb - 0.07, 'band'), (2.135, zb - 0.05, 'band'), (2.135, zb + 0.05, 'band'), (2.1, zb + 0.07, 'skin_ru')]
        lp += [(2.1, 10.0, 'band'), (1.75, 10.6, 'skin_ru'), (1.75, 14.2, 'band'), (1.45, 14.6, 'radiator'), (1.45, 17.7, 'alu'),
               (1.2, 17.95, 'dark'), (0, 18.05)]
        revolve(G, lp, 'skin_ru', M((0, s * 1.2, 0), ax), 44)
        yl = lambda z: s * (1.2 + z)   # noqa: E731
        if lab == 'mengtian':   # exposed payload platform on the zenith side + cargo airlock
            box(G, (3.0, 3.4, 0.25), (0, yl(12.4), 2.0), 'alu', 0.03)
            for k, (dx, dy, mt) in enumerate(((-0.8, -0.8, 'gold'), (0.8, -0.8, 'white'), (-0.8, 0.9, 'white'), (0.8, 0.9, 'gold'))):
                box(G, (1.1, 1.3, 0.7), (dx, yl(12.4) + dy, 2.5), mt, 0.04)
            port_ring(G, T((0, yl(12.4), 0)) @ rot_to('-Z'), 1.7, 0.2, 0.6)
        else:                   # airlock hatch + small arm
            cyl(G, 0.55, 1.72, 1.82, 'dark', T((0, yl(12.4), 0)) @ rot_to('-Z'), 24, 0.02)
            a, b, c = Vector((1.3, yl(10.8), 1.4)), Vector((1.6, yl(6.5), 2.4)), Vector((1.3, yl(3.4), 2.3))
            for p, q in ((a, b), (b, c)):
                cyl(G, 0.12, 0.2, (q - p).length - 0.2, 'white', Mdir(p, q - p), 12, 0.02)
            for p in (a, b, c):
                sphere(G, 0.22, T(p), 'dark', 12, 6)
        for e in (1, -1):
            box(G, (0.06, 2.4, 1.6), (e * 1.78, yl(12.3), -0.4), 'radiator', 0.01)
        ylab = yl(16.2)
        g = solar(name, (0, ylab, 0))
        cyl(g, 0.4, -2.2, 2.2, 'alu', M((0, ylab, 0), 'X'), 20, 0.04)
        for sx in (1, -1):
            flex_wing(g, Vector((sx * 2.2, ylab, 0)), 0 if sx > 0 else math.pi, 25.4, 2.0, 0.46, 0.44, 1.0, box_h=0.35, tip_h=0.24, rod=0.04)
    # visiting vehicles: Shenzhou on the forward port, Tianzhou on the aft port
    shenzhou(G, T((1.4 + 0.05 + 4.5, 0, 0)) @ RZ(math.pi))
    tianzhou(G, T((x_aft - 0.05 - 5.3, 0, 0)))
    return G, SOL


# ------------------------------------------------------------------------------------------------------- Hubble
def build_hubble():
    G, SOL = Geo(), []

    def solar(name, origin):
        g = Geo()
        SOL.append((name, Vector(origin), g))
        return g
    X = M((0, 0, 0), 'X')
    P = [(0, -6.62, 'mli'), (1.2, -6.56), (1.8, -6.42), (2.04, -6.25, 'band'), (2.1, -6.1, 'mli')]
    for zb in (-4.4,):
        P += [(2.1, zb - 0.07, 'band'), (2.13, zb - 0.05, 'band'), (2.13, zb + 0.05, 'band'), (2.1, zb + 0.07, 'mli')]
    P += [(2.1, -2.62, 'dark'), (1.55, -2.6, 'mli'), (1.55, 0.7, 'band'), (1.58, 0.75, 'band'), (1.58, 0.85, 'band'), (1.55, 0.9, 'mli'),
          (1.55, 2.4, 'band'), (1.6, 2.45, 'band'), (1.6, 2.6, 'band'), (1.55, 2.65, 'mli')]
    for zb in (3.9, 5.2):
        P += [(1.55, zb - 0.06, 'band'), (1.575, zb - 0.04, 'band'), (1.575, zb + 0.04, 'band'), (1.55, zb + 0.06, 'mli')]
    P += [(1.55, 6.55, 'alu'), (1.55, 6.62, 'alu'), (1.47, 6.62, 'black'), (1.47, 3.1, 'black'), (0.5, 3.1, 'black'), (0, 3.1)]
    revolve(G, P, 'mli', X, 56)
    # SSM equipment section: 10 bays
    revolve(G, [(1.5, -2.66, 'mli'), (2.14, -2.66, 'mli'), (2.2, -2.6, 'mli'), (2.2, -0.81, 'mli'), (2.14, -0.75, 'mli'), (1.5, -0.75)],
            'mli', X, 10, phase=math.pi / 10)
    for k in range(10):   # bay door seams / handholds
        a = TAU * k / 10
        p0 = Vector((-2.55, 2.2 * math.cos(a) * 1.005, 2.2 * math.sin(a) * 1.005))
        beam(G, p0, p0 + Vector((1.7, 0, 0)), 0.04, 'band', 4)
    # aft shroud handrails (gold) on standoffs, and a radiator panel
    for k in range(6):
        a = TAU * (k + 0.5) / 6
        cs, sn = math.cos(a), math.sin(a)
        beam(G, (-5.9, 2.22 * cs, 2.22 * sn), (-3.0, 2.22 * cs, 2.22 * sn), 0.05, 'gold', 6)
        for x in (-5.6, -3.3):
            beam(G, (x, 2.08 * cs, 2.08 * sn), (x, 2.23 * cs, 2.23 * sn), 0.04, 'gold', 4)
    box(G, (1.8, 0.06, 1.3), (-4.9, 2.12, -0.4), 'radiator', 0.01)
    # soft capture mechanism + aft low-gain antenna
    revolve(G, [(0.7, -6.6, 'alu'), (0.95, -6.62, 'alu'), (0.95, -6.85, 'alu'), (0.8, -6.88, 'alu'), (0.7, -6.6)], 'alu', X, 32)
    for k in range(3):
        a = TAU * k / 3
        beam(G, (-6.85, 0.88 * math.cos(a), 0.88 * math.sin(a)), (-7.05, 0.8 * math.cos(a), 0.8 * math.sin(a)), 0.08, 'alu', 6)
    beam(G, (-6.5, 1.2, 1.2), (-7.0, 1.3, 1.3), 0.06, 'alu', 6)
    revolve(G, [(0, 0, 'white'), (0.12, 0.02), (0.18, 0.18), (0, 0.22)], 'white', Mdir((-7.0, 1.3, 1.3), (-1, 0.2, 0.2)), 12)
    # aperture door, open ~100 deg, hinged at the top of the light shield
    hinge = Vector((6.66, 0, 1.6))
    mdoor = T(hinge) @ Matrix.Rotation(math.radians(-100), 4, 'Y') @ T((0.0, 0, -1.6)) @ rot_to('X')
    revolve(G, [(0, 0.0, 'mli'), (1.6, 0.0, 'mli'), (1.65, 0.05, 'band'), (1.65, 0.1, 'mli'), (1.6, 0.14, 'mli'), (0, 0.14)], 'mli', mdoor, 48)
    for e in (1, -1):
        beam(G, hinge + Vector((-0.2, e * 0.5, 0)), hinge + Vector((0.1, e * 0.5, 0.15)), 0.12, 'alu', 6, True)
    # forward magnetometers / low gain antenna
    for e in (1, -1):
        box(G, (0.5, 0.3, 0.25), (6.2, e * 0.3, 1.72), 'white', 0.04)
    revolve(G, [(0, 0, 'white'), (0.12, 0.02), (0.18, 0.18), (0, 0.22)], 'white', Mdir((6.0, -1.0, -1.25), (0.2, -0.6, -0.8)), 12)
    # high-gain antennas on deployed booms (+/-Z)
    for e in (1, -1):
        root = Vector((1.2, 0, e * 1.5))
        tip = Vector((1.2, 0, e * 4.9))
        box(G, (0.5, 0.5, 0.4), (1.2, 0, e * 1.65), 'band', 0.04)
        beam(G, root, tip, 0.12, 'alu', 8, True)
        box(G, (0.35, 0.35, 0.35), tuple(tip), 'dark', 0.04)
        dish(G, 0.66, 0.2, Mdir(tip + Vector((0.18, 0, 0)), (1, 0, 0)), 'white', 'alu', 32)
    # SA3 rigid arrays (+/-Y); rotation axis = mast line x=-0.3, z=0
    xa = -0.3
    for name, s in (('solar_1', 1), ('solar_2', -1)):
        g = solar(name, (xa, s * 1.6, 0))
        box(g, (0.55, 0.5, 0.55), (xa, s * 1.75, 0), 'dark', 0.04)
        beam(g, (xa, s * 1.95, 0), (xa, s * 9.5, 0), 0.14, 'alu', 8, True)
        for hx in (1, -1):
            box(g, (1.24, 7.1, 0.05), (xa + hx * 0.72, s * (2.35 + 3.55), 0), {'+z': 'cells_fine', '*': 'panel_back'}, 0.012)
        for yy in (2.3, 9.4):
            beam(g, (xa - 1.36, s * yy, 0), (xa + 1.36, s * yy, 0), 0.07, 'alu')
    return G, SOL


# -------------------------------------------------------------------------------------------------------- Soyuz
def build_soyuz():
    G, SOL = Geo(), []
    names = iter(['solar_1', 'solar_2'])

    def solar(origin):
        g = Geo()
        SOL.append((next(names), Vector(origin), g))
        return g
    soyuz(G, Matrix.Identity(4), solar=solar, segs=64)
    return G, SOL


BUILDERS = {'iss': build_iss, 'css': build_css, 'hubble': build_hubble, 'soyuz': build_soyuz}


# ------------------------------------------------------------------------------------------------- object/export
def split_geo(geo):
    """(untextured part, textured part): untextured faces are exported without TEXCOORD_0 to save ~25% of the bytes."""
    parts = (Geo(), Geo())
    maps = ({}, {})
    for f, uv, m, sft in zip(geo.F, geo.UV, geo.M, geo.S):
        k = 1 if 'tex' in PAL[m] else 0
        g, mp = parts[k], maps[k]
        nf = []
        for i in f:
            if i not in mp:
                mp[i] = len(g.V)
                g.V.append(geo.V[i])
            nf.append(mp[i])
        g.F.append(tuple(nf)); g.UV.append(uv); g.M.append(m); g.S.append(sft)
    return parts


def build_object(name, geo, origin=Vector((0, 0, 0)), uv=True):
    me = bpy.data.meshes.new(name + '_mesh')
    ox, oy, oz = origin
    me.from_pydata([(x - ox, y - oy, z - oz) for (x, y, z) in geo.V], [], geo.F)
    names = sorted(set(geo.M))
    for n in names:
        me.materials.append(get_mat(n))
    idx = {n: i for i, n in enumerate(names)}
    me.polygons.foreach_set('material_index', [idx[n] for n in geo.M])
    if uv:
        uvl = me.uv_layers.new(name='UVMap')
        flat = []
        for uvs, n in zip(geo.UV, geo.M):
            t = tile(n)
            for u, v in uvs:
                flat += (u / t, v / t)
        uvl.data.foreach_set('uv', flat)
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(32))
    if any(geo.S):   # thin beams/rods: smooth-shade them (rounder look, ~40% fewer exported vertices)
        sh = me.attributes.get('sharp_edge')
        if sh is not None:
            vals = [False] * len(me.edges)
            sh.data.foreach_get('value', vals)
            ek = {e.key: e.index for e in me.edges}
            for p, soft in zip(me.polygons, geo.S):
                if soft:
                    for k in p.edge_keys:
                        vals[ek[k]] = False
            sh.data.foreach_set('value', vals)
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_model(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _MATS.clear()
    G, SOL = BUILDERS[name]()
    plain, textured = split_geo(G)
    root = build_object(name, plain, uv=False)
    if textured.F:
        skin = build_object(name + '_skin', textured)
        skin.parent = root
    for sname, origin, g in SOL:
        ob = build_object(sname, g, origin)
        ob.parent = root
        ob.location = origin
    bpy.context.view_layer.update()
    os.makedirs(MODELS, exist_ok=True)
    path = os.path.join(MODELS, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, export_yup=True, use_selection=False,
                              export_cameras=False, export_lights=False, export_image_format='AUTO')
    tris = sum(len(o.data.polygons) and sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.data.objects if o.type == 'MESH')
    log(name, 'exported', path, os.path.getsize(path), 'bytes', 'tris~', tris, 'solars', [s[0] for s in SOL])


# ------------------------------------------------------------------------------------------------- validation
def glb_json(path):
    with open(path, 'rb') as f:
        data = f.read()
    clen, ctype = struct.unpack('<II', data[12:20])
    return json.loads(data[20:20 + clen].decode('utf-8'))


def setup_preview_world(scene):
    w = bpy.data.worlds.new('PreviewWorld')
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    cam_bg = nt.nodes.new('ShaderNodeBackground')
    cam_bg.inputs['Color'].default_value = hex_rgba('#04060a')
    env = nt.nodes.new('ShaderNodeBackground')
    env.inputs['Color'].default_value = (0.10, 0.15, 0.24, 1)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = -1.0
    mr.inputs['From Max'].default_value = 0.4
    mr.inputs['To Min'].default_value = 0.9     # earthshine from below
    mr.inputs['To Max'].default_value = 0.06    # nearly black sky above
    lp = nt.nodes.new('ShaderNodeLightPath')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], env.inputs['Strength'])
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac'])
    nt.links.new(env.outputs[0], mix.inputs[1])
    nt.links.new(cam_bg.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    scene.world = w
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.energy = 4.5
    sun.angle = math.radians(0.53)
    so = bpy.data.objects.new('Sun', sun)
    scene.collection.objects.link(so)
    so.rotation_euler = Vector((-0.55, 0.45, -0.7)).to_track_quat('-Z', 'Y').to_euler()   # light travels this way


def render_sheet(name, pts):
    scene = bpy.context.scene
    setup_cycles(scene, 800, 600, samples=48)
    scene.view_settings.look = 'AgX - Medium High Contrast' if 'AgX - Medium High Contrast' in [
        i.identifier for i in scene.view_settings.bl_rna.properties['look'].enum_items] else 'None'
    setup_preview_world(scene)
    lo, hi = pts.min(0), pts.max(0)
    ctr = (lo + hi) / 2
    rel = pts - ctr
    views = [('34', (0.85, -0.75, 0.62)), ('side', (0.0, -1.0, 0.06)), ('top', (0.0, 0.0001, 1.0)), ('below', (0.35, -0.45, -0.82))]
    tiles = []
    th, tw = math.tan(math.atan(18 / 50)), math.tan(math.atan(13.5 / 50))
    for tag, dvec in views:
        d = Vector(dvec).normalized()
        cam = bpy.data.objects.get('PrevCam')
        if cam is None:
            cd = bpy.data.cameras.new('PrevCam')
            cd.lens = 50
            cd.clip_start = 0.05
            cd.clip_end = 5000
            cam = bpy.data.objects.new('PrevCam', cd)
            scene.collection.objects.link(cam)
            scene.camera = cam
        cam.location = Vector(ctr) + d * 10
        look_at(cam, Vector(ctr))
        bpy.context.view_layer.update()
        R = np.array(cam.matrix_world.to_3x3())
        right, up = R[:, 0], R[:, 1]
        dd = np.array(d)
        along = rel @ dd
        need = max(np.max(along + np.abs(rel @ right) / (th * 0.92)), np.max(along + np.abs(rel @ up) / (tw * 0.92)))
        cam.location = Vector(ctr) + d * float(need)
        p = os.path.join(PREV, f'_{name}_{tag}.png')
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        tiles.append(p)
    imgs = []
    for p in tiles:
        im = bpy.data.images.load(p)
        a = np.array(im.pixels[:], np.float32).reshape(im.size[1], im.size[0], 4)
        imgs.append(a)
        bpy.data.images.remove(im)
        os.remove(p)
    h, w = imgs[0].shape[:2]
    sheet = np.zeros((2 * h, 2 * w, 4), np.float32)
    sheet[..., 3] = 1
    sheet[h:, :w], sheet[h:, w:], sheet[:h, :w], sheet[:h, w:] = imgs[0], imgs[1], imgs[2], imgs[3]
    sheet[h - 1:h + 1, :, :3] = 0.16
    sheet[:, w - 1:w + 1, :3] = 0.16
    out = bpy.data.images.new('sheet', 2 * w, 2 * h, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = os.path.join(PREV, name + '.png')
    out.file_format = 'PNG'
    out.save()
    log('preview', out.filepath_raw)


def validate(name, report):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = os.path.join(MODELS, name + '.glb')
    bpy.ops.import_scene.gltf(filepath=path)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    pts, tris = [], 0
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        me = o.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        co = np.zeros(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        mw = np.array(o.matrix_world)
        pts.append(co @ mw[:3, :3].T + mw[:3, 3])
        o.evaluated_get(dg).to_mesh_clear()
    pts = np.concatenate(pts)
    lo, hi = pts.min(0), pts.max(0)
    js = glb_json(path)
    nodes = js.get('nodes', [])
    errors = []
    scene_roots = js['scenes'][js.get('scene', 0)]['nodes']
    if len(scene_roots) != 1 or nodes[scene_roots[0]].get('name') != name:
        errors.append(f'root nodes {[nodes[i].get("name") for i in scene_roots]} (want exactly ["{name}"])')
    root = nodes[scene_roots[0]]
    for k in ('translation', 'rotation', 'scale', 'matrix'):
        if k in root:
            errors.append(f'root has {k}={root[k]}')
    gltf_tris = 0
    for mesh in js.get('meshes', []):
        for prim in mesh['primitives']:
            gltf_tris += js['accessors'][prim['indices']]['count'] // 3
    solars = []
    child_idx = set(root.get('children', []))
    seen = set()
    for i, n in enumerate(nodes):
        nm = n.get('name', '')
        if not nm.startswith('solar_'):
            continue
        if nm in seen:
            errors.append('duplicate ' + nm)
        seen.add(nm)
        t = n.get('translation', [0, 0, 0])
        r = n.get('rotation', [0, 0, 0, 1])
        s = n.get('scale', [1, 1, 1])
        if i not in child_idx:
            errors.append(nm + ' not a child of root')
        if max(abs(r[0]), abs(r[1]), abs(r[2]), abs(r[3] - 1)) > 1e-6:
            errors.append(f'{nm} rotation {r}')
        if max(abs(v - 1) for v in s) > 1e-6:
            errors.append(f'{nm} scale {s}')
        bo = bpy.data.objects.get(nm)
        rot_bl = list(bo.rotation_quaternion) if bo.rotation_mode == 'QUATERNION' else list(bo.rotation_euler)
        mpts = np.array([v.co[:] for v in bo.data.vertices])
        solars.append({'name': nm, 'what': SOLAR_NOTES.get(name, {}).get(nm, ''),
                       'location_blender_zup': [round(t[0], 3), round(-t[2], 3), round(t[1], 3)],
                       'translation_gltf_yup': [round(v, 3) for v in t], 'rotation_gltf_xyzw': r,
                       'rotation_blender_after_import': [round(v, 6) for v in rot_bl], 'scale': s,
                       'local_bbox_min': [round(v, 2) for v in mpts.min(0)], 'local_bbox_max': [round(v, 2) for v in mpts.max(0)]})
    if js.get('cameras') or (js.get('extensions', {}).get('KHR_lights_punctual')):
        errors.append('cameras/lights present')
    size = os.path.getsize(path)
    tri_lim, size_lim = LIMITS[name]
    if gltf_tris > tri_lim:
        errors.append(f'triangles {gltf_tris} > {tri_lim}')
    if size > size_lim:
        errors.append(f'file size {size} > {size_lim}')
    mats = [m.get('name') for m in js.get('materials', [])]
    imgs = [(im.get('name'), im.get('mimeType')) for im in js.get('images', [])]
    rec = {'file': path, 'bytes': size, 'triangles_gltf': gltf_tris, 'triangles_blender_import': tris,
           'dims_m_xyz_blender': [round(float(v), 2) for v in (hi - lo)],
           'bbox_min': [round(float(v), 2) for v in lo], 'bbox_max': [round(float(v), 2) for v in hi],
           'nodes': [n.get('name') for n in nodes], 'solar_nodes': solars, 'materials': mats, 'images': imgs,
           'errors': errors, 'ok': not errors}
    report[name] = rec
    log(name, json.dumps(rec, indent=1))
    os.makedirs(PREV, exist_ok=True)
    render_sheet(name, pts)


def main():
    args = script_args()
    mode = args[0] if args else 'build'
    names = [a for a in args[1:] if a in NAMES] or NAMES
    if mode == 'build':
        gen_textures()
        for n in names:
            build_model(n)
    elif mode == 'validate':
        rp = os.path.join(MODELS, 'validation.json')
        report = {}
        if os.path.exists(rp):
            with open(rp, encoding='utf-8') as f:
                report = json.load(f)
        for n in names:
            validate(n, report)
            with open(rp, 'w', encoding='utf-8') as f:
                json.dump(report, f, indent=1)
        bad = [n for n in names if not report[n]['ok']]
        if bad:
            raise RuntimeError('spec violations: ' + ', '.join(f'{n}: {report[n]["errors"]}' for n in bad))


if __name__ == '__main__':
    run(main, os.path.join(os.environ.get('TEMP', HERE), 'sat_models_' + (script_args()[0] if script_args() else 'build') + '.log'))
