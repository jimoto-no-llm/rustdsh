"""Decode the deliverable and extract every scene for a visual privacy review."""
from pathlib import Path
import json
import subprocess
import sys
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
stylish = '--stylish' in sys.argv
original = '--original' in sys.argv
sharp = '--sharp' in sys.argv
duration, fps = (30, 60) if sharp else ((44, 60) if original else ((52, 60) if stylish else (64, 30)))
width, height = (3840, 2160) if sharp else (1920, 1080)
prefix = 'sharp-' if sharp else ('original-' if original else ('stylish-' if stylish else ''))
video = root / 'out' / ('rdsh-intro-sharp-4k-ja.mp4' if sharp else ('rdsh-intro-original-ja.mp4' if original else ('rdsh-intro-stylish-ja.mp4' if stylish else 'rdsh-intro-ja.mp4')))
probe = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(video)
]))
visual = next(s for s in probe['streams'] if s['codec_type'] == 'video')
audio = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
assert (visual['width'], visual['height']) == (width, height)
assert visual['r_frame_rate'] == f'{fps}/1'
assert visual['codec_name'] == 'h264'
assert audio['codec_name'] == 'aac'
assert abs(float(probe['format']['duration']) - duration) < .1
decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-f', 'null', '-'], capture_output=True, text=True)
assert decoded.returncode == 0, decoded.stderr
assert not decoded.stderr.strip(), decoded.stderr
assets = root / 'public' / 'sharp' if sharp else root / 'public'
audit = json.loads((assets / 'capture-audit.json').read_text())
assert audit['result'] == 'PASS'
assert audit['personal_browser'] is False
assert audit['model_calls'] is False
assert audit['desktop_capture'] is False
if sharp:
    assert audit['device_scale_factor'] == 6
    for filename, display_pixels in [('project-tasks.png', 1216 * 1744 / 910 * 2), ('question-draft.png', 1216 * 1744 / 910 * 2), ('project-metrics.png', 1216 * 788 / 292 * 2), ('project-mobile-question.png', 390 * 2.1 * 2)]:
        assert Image.open(assets / filename).width >= display_pixels, filename
frames = [1.4, 4.3, 7.8, 10.8, 13.5, 17.5, 19.5, 22.8, 27] if sharp else ([1.1, 3.6, 7.8, 10.8, 15.3, 19.7, 23.6, 27.5, 30.7, 35.5, 41.4] if original else ([1, 4, 7.5, 12, 17, 20.5, 25.5, 31.5, 36, 43, 49] if stylish else [3.5, 12, 20, 28, 38, 48.5, 56, 61.5]))
sheet = Image.new('RGB', (1920, ((len(frames) + 2) // 3) * 390), '#111923')
draw = ImageDraw.Draw(sheet)
for index, seconds in enumerate(frames):
    frame = root / 'out' / f'{prefix}scene-{index + 1}.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(seconds), '-i', str(video), '-frames:v', '1', '-y', str(frame)], check=True)
    thumb = Image.open(frame).convert('RGB').resize((640, 360))
    x, y = (index % 3) * 640, (index // 3) * 390
    sheet.paste(thumb, (x, y))
    draw.text((x + 14, y + 367), f'Scene {index + 1} / {seconds}s', fill='white')
sheet.save(root / 'out' / f'{prefix}contact-sheet.jpg', quality=94)
report = {
    'result': 'PASS', 'duration_seconds': float(probe['format']['duration']),
    'width': width, 'height': height, 'fps': fps,
    'video_codec': visual['codec_name'], 'audio_codec': audio['codec_name'],
    'size_bytes': video.stat().st_size, 'full_decode': 'PASS',
    'capture_privacy': 'PASS', 'representative_frames_seconds': frames,
    'visual_review': 'Pending human/agent inspection of the contact sheet',
}
if sharp:
    report['ui_source_density'] = 'PASS: DPR 6 captures, no UI asset upscaled past native pixels in the 4K composition'
(root / 'out' / f'{prefix}verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
