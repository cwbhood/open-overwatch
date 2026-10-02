"""Shared helpers for the Open Overwatch brand renders (Blender 5.2, run headless).

Run a script with:
    "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\blender-launcher.exe" -b --factory-startup --python <script.py> -- <args>
The launcher blocks until Blender exits and returns its exit code, but Blender's stdout is NOT captured,
so every script logs through log() to a file and wraps its body in run(main, log_path).

Blender 5.x API notes (verified on 5.2.2):
- Compositor: a node group of type 'CompositorNodeTree' assigned to scene.compositing_node_group, ending in a
  NodeGroupOutput (there is no Composite node any more). Node settings are input sockets, e.g.
  glare.inputs['Type'].default_value = 'Fog Glow'.
- Video sequencer: scene.sequence_editor.strips (not .sequences); strips.new_image/new_movie/new_sound/new_effect.
- Video output: scene.render.image_settings.media_type = 'VIDEO', then scene.render.ffmpeg.*.
"""
import bpy, os, sys, json, math, traceback

# brand palette from open-overwatch.html :root (sRGB hex)
BRAND = {
    'bg': '#04060a', 'panel': '#080c12', 'line': '#182230', 'ink': '#e6edf3', 'ink_dim': '#8b9bab',
    'accent': '#7dffa6', 'vibe': '#b48cff', 'civ': '#5fd3ff', 'mil': '#ffb44d', 'emg': '#ff4d5e',
    'sat': '#d9ccff', 'ship': '#62e0c8', 'bal': '#fff2a8', 'qk': '#ff7b4f', 'evt': '#ffd45c', 'cable': '#3f8fb5',
}

_LOG = None


def log(*a):
    msg = ' '.join(str(x) for x in a)
    if _LOG:
        with open(_LOG, 'a', encoding='utf-8') as f:
            f.write(msg + '\n')


def run(main, log_path):
    """Call main() with logging; exit 0 on success, 1 on any exception (traceback goes to the log)."""
    global _LOG
    _LOG = log_path
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    open(log_path, 'w', encoding='utf-8').close()
    try:
        main()
        log('DONE')
        sys.stdout.flush()
        os._exit(0)
    except BaseException:
        log(traceback.format_exc())
        os._exit(1)


def script_args():
    """Arguments after '--' on the Blender command line."""
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h, alpha=1.0, linear=True):
    """'#7dffa6' -> (r, g, b, a). Linear by default, which is what shader/socket colors expect."""
    h = h.lstrip('#')
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    if linear:
        rgb = [srgb_to_linear(c) for c in rgb]
    return (*rgb, alpha)


def color(name_or_hex, alpha=1.0):
    return hex_rgba(BRAND.get(name_or_hex, name_or_hex), alpha)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def setup_cycles(scene, width, height, samples=64, transparent=False, denoise=True, pct=100):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for dev_type in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = dev_type
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == dev_type]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == dev_type
                scene.cycles.device = 'GPU'
                log('cycles device', dev_type, [d.name for d in gpus])
                break
        except Exception as e:
            log('device', dev_type, 'unavailable:', e)
    scene.cycles.samples = samples
    scene.cycles.use_denoising = denoise
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = width, height, pct
    scene.render.film_transparent = transparent
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'None'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA' if transparent else 'RGB'
    scene.render.image_settings.color_depth = '8'
    return scene


def setup_glare(scene, glare_type='Fog Glow', threshold=0.8, strength=1.0, size=0.6, quality='High'):
    """Render Layers -> Glare -> Group Output. Keeps alpha, so it works with film_transparent."""
    ng = bpy.data.node_groups.new('Comp', 'CompositorNodeTree')
    ng.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    scene.compositing_node_group = ng
    rl = ng.nodes.new('CompositorNodeRLayers')
    gl = ng.nodes.new('CompositorNodeGlare')
    out = ng.nodes.new('NodeGroupOutput')
    gl.inputs['Type'].default_value = glare_type
    gl.inputs['Quality'].default_value = quality
    gl.inputs['Threshold'].default_value = threshold
    gl.inputs['Strength'].default_value = strength
    gl.inputs['Size'].default_value = size
    ng.links.new(rl.outputs['Image'], gl.inputs['Image'])
    ng.links.new(gl.outputs['Image'], out.inputs[0])
    return ng, gl


def emission_material(name, col, strength=1.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = color(col) if isinstance(col, str) else col
    em.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    if alpha < 1.0:
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mix = nt.nodes.new('ShaderNodeMixShader')
        mix.inputs['Fac'].default_value = alpha
        nt.links.new(tr.outputs[0], mix.inputs[1])
        nt.links.new(em.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs['Surface'])
    else:
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m


def world_color(scene, col='#04060a', strength=1.0):
    w = bpy.data.worlds.new('World')
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background') or w.node_tree.nodes.new('ShaderNodeBackground')
    bg.inputs['Color'].default_value = color(col)
    bg.inputs['Strength'].default_value = strength
    scene.world = w
    return w


def look_at(obj, target):
    from mathutils import Vector
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def add_camera(scene, loc, target=(0, 0, 0), lens=50, ortho_scale=None):
    cam_data = bpy.data.cameras.new('Camera')
    if ortho_scale:
        cam_data.type = 'ORTHO'
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.lens = lens
    cam = bpy.data.objects.new('Camera', cam_data)
    scene.collection.objects.link(cam)
    cam.location = loc
    look_at(cam, target)
    scene.camera = cam
    return cam


def render_still(scene, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    log('wrote', path, os.path.getsize(path), 'bytes')
