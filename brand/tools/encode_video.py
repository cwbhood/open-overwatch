"""Encode composed frames (+ optional soundtrack) to an H.264 MP4 with Blender's built-in FFmpeg.

    blender-launcher.exe -b --factory-startup --python encode_video.py -- <frames_dir> <out.mp4> [audio.wav] [--last N]

Colour management is set to Standard so the footage's sRGB colours pass through untouched (AgX would shift them).
"""
import os, sys, json
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bl_common as B


def main():
    args = B.script_args()
    frames_dir, out_path = args[0], args[1]
    audio = args[2] if len(args) > 2 and not args[2].startswith('--') else None
    files = sorted(f for f in os.listdir(frames_dir) if f.startswith('frame_') and f.endswith('.jpg'))
    if '--last' in args:
        files = files[:int(args[args.index('--last') + 1])]
    B.log('frames', len(files), 'audio', audio)

    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1080, 1920, 100
    sc.render.fps, sc.render.fps_base = 30, 1.0
    sc.frame_start, sc.frame_end = 1, len(files)
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure, sc.view_settings.gamma = 0.0, 1.0
    sc.sequencer_colorspace_settings.name = 'sRGB'

    ed = sc.sequence_editor_create()
    strip = ed.strips.new_image('frames', os.path.join(frames_dir, files[0]), 1, 1, fit_method='FIT')
    for f in files[1:]:
        strip.elements.append(f)
    strip.frame_final_duration = len(files)
    if audio:
        snd = ed.strips.new_sound('music', audio, 2, 1)
        B.log('sound strip', snd.frame_final_start, snd.frame_final_end)

    r = sc.render
    r.image_settings.media_type = 'VIDEO'
    r.ffmpeg.format = 'MPEG4'
    r.ffmpeg.codec = 'H264'
    r.ffmpeg.constant_rate_factor = 'HIGH'
    r.ffmpeg.ffmpeg_preset = 'GOOD'
    r.ffmpeg.gopsize = 30
    r.ffmpeg.audio_codec = 'AAC' if audio else 'NONE'
    if audio:
        r.ffmpeg.audio_bitrate = 192
        r.ffmpeg.audio_channels = 'STEREO'
        r.ffmpeg.audio_mixrate = 48000
    r.use_sequencer = True
    r.filepath = out_path
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.render.render(animation=True)
    # Blender may append the frame range to the name; normalise to out_path
    base, ext = os.path.splitext(out_path)
    for cand in (out_path, f'{base}{1:04d}-{len(files):04d}{ext}', f'{base}0001-{len(files):04d}{ext}'):
        if os.path.exists(cand):
            if cand != out_path:
                os.replace(cand, out_path)
            break
    B.log('wrote', out_path, os.path.getsize(out_path) if os.path.exists(out_path) else 'MISSING')


B.run(main, os.path.join(os.path.dirname(sys.argv[sys.argv.index('--') + 2]) if '--' in sys.argv else '.', 'encode.log'))
