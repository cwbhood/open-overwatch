"""3D aircraft models (.glb) for globe.html, from the same Blender geometry as the top-down sprites.

    blender-launcher.exe -b --factory-startup --python plane_models.py -- <out_dir>

Writes <shape>_<civ|mil>.glb for airliner, prop, heli, fighter, heavy, tprop. Axes follow the satellite models:
+X nose, +Z up, +Y left wing; metres; origin near the centre of the airframe. Helicopter rotors are a separate node
`rotor` (identity rotation, origin on the mast) so the page can spin it about Blender Z.
"""
import os, sys, math
import bpy
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bl_common as B
import plane_sprites as PS

ROT = Matrix.Rotation(-math.pi / 2, 4, 'Z')  # sprite geometry has the nose on +Y; models want it on +X


def export(shape, pal, out):
    sc = B.clear_scene()
    PS.build(shape, pal)
    for name in ('disc',):
        ob = bpy.data.objects.get(name)
        if ob:
            bpy.data.objects.remove(ob, do_unlink=True)
    meshes = [o for o in sc.objects if o.type == 'MESH']
    for o in meshes:
        o.matrix_world = ROT @ o.matrix_world
    root = bpy.data.objects.new(shape, None); sc.collection.objects.link(root)
    rotor = None
    if shape == 'heli':
        hub = bpy.data.objects['hub']
        rotor = bpy.data.objects.new('rotor', None); sc.collection.objects.link(rotor)
        rotor.location = hub.matrix_world.translation.copy()
        rotor.parent = root
    for o in meshes:
        parent = rotor if (rotor and (o.name.startswith('blade') or o.name == 'hub')) else root
        mw = o.matrix_world.copy()
        o.parent = parent
        o.matrix_world = mw
    # centre: shift every top-level child so the bounding box centre sits at the origin
    from mathutils import Vector
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    ctr = Vector(((min(p.x for p in pts) + max(p.x for p in pts)) / 2, (min(p.y for p in pts) + max(p.y for p in pts)) / 2, 0))
    for o in [c for c in root.children]:
        o.location -= ctr
    bpy.context.view_layer.update()
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_yup=True,
                              use_selection=False, export_cameras=False, export_lights=False)
    B.log('wrote', out, os.path.getsize(out), 'bytes')


def main():
    out_dir = B.script_args()[0]
    os.makedirs(out_dir, exist_ok=True)
    for shape in PS.SHAPES:
        for pal in ('civ', 'mil'):
            export(shape, pal, os.path.join(out_dir, f'{shape}_{pal}.glb'))


B.run(main, os.path.join(B.script_args()[0], 'aircraft.log'))
