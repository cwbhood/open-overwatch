"""Read an MP4 back with Blender: report size/length/fps/audio and save chosen frames as PNGs (QA without ffmpeg).

    blender-launcher.exe -b --factory-startup --python probe_video.py -- <video.mp4> <out_dir> [frame,frame,...]
"""
import os, sys, json
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bl_common as B


def main():
    args = B.script_args()
    video, out_dir = args[0], args[1]
    want = [int(x) for x in args[2].split(',')] if len(args) > 2 else []
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    ed = sc.sequence_editor_create()
    mv = ed.strips.new_movie('v', video, 1, 1, fit_method='ORIGINAL')
    info = {'frames': mv.frame_duration, 'fps': round(mv.fps, 3) if hasattr(mv, 'fps') else None,
            'width': mv.elements[0].orig_width if len(mv.elements) else None,
            'height': mv.elements[0].orig_height if len(mv.elements) else None}
    sc.render.fps, sc.render.fps_base = round(mv.fps), 1.0
    try:
        snd = ed.strips.new_sound('a', video, 2, 1)
        info['audio_frames'] = snd.frame_duration
        info['audio_channels'] = snd.sound.channels if hasattr(snd.sound, 'channels') else None
    except Exception as e:
        info['audio'] = 'none (' + str(e).strip()[:80] + ')'
    sc.render.resolution_x = info['width'] or 1080
    sc.render.resolution_y = info['height'] or 1920
    sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = 'Standard'
    sc.render.image_settings.file_format = 'PNG'
    sc.frame_start, sc.frame_end = 1, mv.frame_duration
    for f in want:
        sc.frame_set(f)
        sc.render.filepath = os.path.join(out_dir, f'probe_{f:04d}.png')
        bpy.ops.render.render(write_still=True)
    json.dump(info, open(os.path.join(out_dir, 'probe.json'), 'w'), indent=1)
    B.log(json.dumps(info))


B.run(main, os.path.join(sys.argv[sys.argv.index('--') + 2], 'probe.log'))
