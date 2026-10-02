"""Validate the satellite-fleet GLBs and render preview sheets from the RE-IMPORTED files.

    blender-launcher.exe -b --factory-startup --python brand/tools/sat_models_check.py -- [model ...] [--close DIR]
                                                                                     [--norender]

For each model: fresh empty scene -> import brand/models/<name>.glb -> record dimensions, triangle count, file size,
solar_* nodes (location / rotation / scale / axis check), materials; check the spec; render a 2x2 sheet
(3/4 above-front, side, top, below) to brand/models/previews/<name>.png. --close DIR also renders a 2x2 close-up
of the bus (solar nodes excluded from framing) into DIR for review. Results: brand/models/previews/fleet_validation.json
"""
import bpy, os, sys, json, math
import numpy as np
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bl_common as bc
from bl_common import log

MODELS = {'starlink': 15000, 'gnss': 15000, 'geo': 20000, 'weather': 15000, 'smallsat': 15000, 'rocketbody': 15000}
MODEL_DIR = os.path.normpath(os.path.join(HERE, '..', 'models'))
PREV_DIR = os.path.join(MODEL_DIR, 'previews')
LOG = os.path.join(HERE, '_fleet_check.log')
W, H = 800, 600


def import_glb(path):
    bc.clear_scene()
    bpy.ops.import_scene.gltf(filepath=path)
    return bpy.context.scene


def mesh_world_verts(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        oe = o.evaluated_get(dg)
        me = oe.to_mesh()
        co = np.empty(len(me.vertices) * 3, dtype=np.float64)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        Mw = np.array(o.matrix_world)
        pts.append(co @ Mw[:3, :3].T + Mw[:3, 3])
        oe.to_mesh_clear()
    return np.concatenate(pts) if pts else np.zeros((0, 3))


def validate(name):
    path = os.path.join(MODEL_DIR, name + '.glb')
    scene = import_glb(path)
    objs = list(scene.objects)
    meshes = [o for o in objs if o.type == 'MESH']
    rep = {'file': path, 'bytes': os.path.getsize(path), 'errors': [], 'warnings': []}
    err = rep['errors']
    roots = [o for o in objs if o.parent is None]
    rep['roots'] = [o.name for o in roots]
    if len(roots) != 1 or roots[0].name != name:
        err.append(f'expected exactly one root named {name}, got {rep["roots"]}')
    else:
        r = roots[0]
        if max(abs(a - b) for ra, rb in zip(r.matrix_world, Matrix.Identity(4)) for a, b in zip(ra, rb)) > 1e-5:
            err.append('root transform is not identity')
    for o in objs:
        if o.type in ('CAMERA', 'LIGHT'):
            err.append(f'{o.type} {o.name} exported')
    tris = 0
    for o in meshes:
        tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
    rep['triangles'] = tris
    if tris > MODELS[name]:
        err.append(f'triangles {tris} > {MODELS[name]}')
    if rep['bytes'] > 1.05 * 1024 * 1024:
        err.append(f'file {rep["bytes"]} bytes > ~1 MB')
    P = mesh_world_verts(meshes)
    lo, hi = P.min(0), P.max(0)
    rep['bbox_min'] = [round(float(v), 3) for v in lo]
    rep['bbox_max'] = [round(float(v), 3) for v in hi]
    rep['dimensions_m'] = [round(float(v), 3) for v in hi - lo]
    body = [o for o in meshes if not o.name.startswith('solar_')]
    B = mesh_world_verts(body)
    rep['body_dimensions_m'] = [round(float(v), 3) for v in B.max(0) - B.min(0)]
    sol = []
    for o in sorted([o for o in objs if o.name.startswith('solar_')], key=lambda o: o.name):
        q = o.rotation_quaternion if o.rotation_mode == 'QUATERNION' else o.rotation_euler.to_quaternion()
        rot_ok = abs(q.angle) < 1e-5
        sc_ok = all(abs(s - 1) < 1e-5 for s in o.scale)
        V = mesh_world_verts([o]) - np.array(o.matrix_world.translation)
        # the wing should extend along +-Y from its origin, and the axis (origin) should lie inside the
        # panels' X/Z extent so the rotation is about the wing's own long axis
        ext = V.max(0) - V.min(0)
        info = {'name': o.name, 'parent': o.parent.name if o.parent else None,
                'location': [round(v, 4) for v in o.location],
                'rotation_quat_wxyz': [round(v, 6) for v in q], 'rotation_euler_deg':
                    [round(math.degrees(v), 4) for v in q.to_euler()], 'scale': [round(v, 6) for v in o.scale],
                'local_extent_m': [round(float(v), 3) for v in ext],
                'local_min': [round(float(v), 3) for v in V.min(0)], 'local_max': [round(float(v), 3) for v in V.max(0)]}
        if not rot_ok:
            err.append(f'{o.name} rotation not zero')
        if not sc_ok:
            err.append(f'{o.name} scale not 1')
        if o.parent is None or o.parent.name != name:
            err.append(f'{o.name} not parented to root')
        if not (ext[1] > ext[0] and ext[1] > ext[2]):
            rep['warnings'].append(f'{o.name}: longest extent is not along Y')
        if not (V.min(0)[0] < 0 < V.max(0)[0] and V.min(0)[2] < 0 < V.max(0)[2]):
            err.append(f'{o.name}: origin not on the wing axis')
        if not (V.min(0)[1] > -0.05 or V.max(0)[1] < 0.05):
            err.append(f'{o.name}: wing does not extend to one side of its origin')
        # cells face +Z: the solar_cells faces' normals
        me = o.data
        ci = [i for i, m in enumerate(me.materials) if m and m.name.startswith('solar_cells')]
        if ci:
            nz = [p.normal.z for p in me.polygons if p.material_index in ci and p.area > 0.05]
            info['cell_faces_up'] = sum(1 for z in nz if z > 0.99)
            info['cell_faces_down'] = sum(1 for z in nz if z < -0.99)
            if info['cell_faces_down']:
                err.append(f'{o.name}: large cell faces pointing -Z')
        sol.append(info)
    rep['solar_nodes'] = sol
    mats = sorted({m.name for o in meshes for m in o.data.materials if m})
    rep['materials'] = mats
    for m in bpy.data.materials:
        if m.node_tree:
            kinds = {n.type for n in m.node_tree.nodes}
            bad = kinds - {'BSDF_PRINCIPLED', 'OUTPUT_MATERIAL', 'TEX_IMAGE', 'NORMAL_MAP', 'MIX', 'MIX_RGB',
                           'SEPARATE_COLOR', 'TEX_COORD', 'MAPPING', 'UVMAP', 'FRAME', 'REROUTE', 'MATH',
                           'VERTEX_COLOR', 'ATTRIBUTE'}
            if bad:
                rep['warnings'].append(f'material {m.name} has nodes {sorted(bad)}')
    rep['images'] = sorted(f'{i.name} {i.size[0]}x{i.size[1]}' for i in bpy.data.images)
    rep['nodes'] = sorted(o.name for o in objs)
    return rep, scene, meshes


def setup_render(scene):
    bc.setup_cycles(scene, W, H, samples=48)
    w = bpy.data.worlds.new('W')
    scene.world = w
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    lp = nt.nodes.new('ShaderNodeLightPath')
    bg_cam = nt.nodes.new('ShaderNodeBackground')
    bg_cam.inputs['Color'].default_value = bc.hex_rgba('#04060a')
    bg_env = nt.nodes.new('ShaderNodeBackground')
    bg_env.inputs['Color'].default_value = bc.hex_rgba('#7a8696')
    bg_env.inputs['Strength'].default_value = 0.6
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac'])
    nt.links.new(bg_env.outputs[0], mix.inputs[1])
    nt.links.new(bg_cam.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.energy = 7.0
    sun.angle = 0.53 * math.pi / 180
    sun_o = bpy.data.objects.new('Sun', sun)
    scene.collection.objects.link(sun_o)
    fill = bpy.data.lights.new('Fill', 'SUN')
    fill.energy = 0.35
    fill.color = (0.55, 0.7, 1.0)
    fill_o = bpy.data.objects.new('Fill', fill)
    scene.collection.objects.link(fill_o)
    return sun_o, fill_o


def fit_camera(scene, cam, pts, direction, target, margin=0.06):
    from bpy_extras.object_utils import world_to_camera_view
    d = Vector(direction).normalized()
    lo, hi = 0.1, 400.0
    sel = pts[np.linspace(0, len(pts) - 1, min(len(pts), 4000)).astype(int)]
    for _ in range(30):
        mid = (lo + hi) / 2
        cam.location = Vector(target) + d * mid
        bc.look_at(cam, target)
        bpy.context.view_layer.update()
        ok = True
        for p in sel:
            c = world_to_camera_view(scene, cam, Vector(p))
            if not (margin < c.x < 1 - margin and margin < c.y < 1 - margin) or c.z <= 0:
                ok = False
                break
        if ok:
            hi = mid
        else:
            lo = mid
    cam.location = Vector(target) + d * hi
    bc.look_at(cam, target)
    cam.data.clip_start = max(0.01, hi * 0.01)
    cam.data.clip_end = hi * 10


def render_sheet(scene, meshes, out_path, focus=None, tag=''):
    sun_o, fill_o = setup_render(scene)
    for o in meshes:   # preview only: hide Cycles' low-poly shadow-terminator stair-stepping
        o.shadow_terminator_geometry_offset = 0.4
    P = mesh_world_verts(focus or meshes)
    lo, hi = P.min(0), P.max(0)
    ctr = (lo + hi) / 2
    ext = hi - lo
    cam = bc.add_camera(scene, (10, 10, 10), tuple(ctr), lens=50)
    long_axis = int(np.argmax(ext))
    side = (0.05, -1.0, 0.12) if long_axis == 0 else (1.0, -0.06, 0.12)
    views = [('three_quarter', (0.85, -0.75, 0.6)), ('side', side), ('top', (0.0001, -0.12, 1.0)),
             ('below', (0.55, -0.6, -0.8))]
    tiles = []
    tmp = os.path.join(HERE, '_fleet_tmp')
    for vname, d in views:
        fit_camera(scene, cam, P, d, tuple(ctr))
        # key light from the camera's upper-left, fill from the opposite side
        cd = Vector(d).normalized()
        up = Vector((0, 0, 1)) if abs(cd.z) < 0.9 else Vector((1, 0, 0))
        right = cd.cross(up).normalized()
        upv = right.cross(cd).normalized()
        L = (cd * 0.55 - right * 0.65 + upv * 0.55).normalized()
        sun_o.rotation_euler = L.to_track_quat('Z', 'Y').to_euler()
        fill_o.rotation_euler = (-L + cd * 0.3).normalized().to_track_quat('Z', 'Y').to_euler()
        f = os.path.join(tmp, f'{tag}{vname}.png')
        bc.render_still(scene, f)
        img = bpy.data.images.load(f, check_existing=False)
        a = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)
        bpy.data.images.remove(img)
        tiles.append(a)
    # pixels are bottom-up: top row of the sheet = tiles 0,1
    gap = 4
    sheet = np.zeros((2 * H + gap, 2 * W + gap, 4), dtype=np.float32)
    sheet[..., 3] = 1
    sheet[..., :3] = 0.08
    sheet[H + gap:, :W] = tiles[0]
    sheet[H + gap:, W + gap:] = tiles[1]
    sheet[:H, :W] = tiles[2]
    sheet[:H, W + gap:] = tiles[3]
    img = bpy.data.images.new('sheet', 2 * W + gap, 2 * H + gap, alpha=False)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = out_path
    img.file_format = 'PNG'
    img.save()
    log('sheet', out_path)


def main():
    args = bc.script_args()
    names = [a for a in args if a in MODELS] or list(MODELS)
    close_dir = args[args.index('--close') + 1] if '--close' in args else None
    norender = '--norender' in args
    os.makedirs(PREV_DIR, exist_ok=True)
    jpath = os.path.join(PREV_DIR, 'fleet_validation.json')
    allrep = {}
    if os.path.exists(jpath):
        try:
            allrep = json.load(open(jpath))
        except Exception:
            allrep = {}
    for name in names:
        rep, scene, meshes = validate(name)
        allrep[name] = rep
        log(name, json.dumps(rep, indent=1))
        json.dump(allrep, open(jpath, 'w'), indent=1)
        if norender:
            continue
        render_sheet(scene, meshes, os.path.join(PREV_DIR, name + '.png'), tag=name + '_')
        if close_dir:
            rep2, scene, meshes = validate(name)
            body = [o for o in meshes if not o.name.startswith('solar_')]
            render_sheet(scene, meshes, os.path.join(close_dir, name + '_close.png'), focus=body, tag=name + '_c_')
    json.dump(allrep, open(jpath, 'w'), indent=1)


if __name__ == '__main__':
    bc.run(main, LOG)
