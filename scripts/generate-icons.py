#!/usr/bin/env python3
"""Convert the canonical artwork into application icon formats without redrawing it."""
import base64
from pathlib import Path
import struct
import subprocess
from ico_format import parse_ico

assets = Path(__file__).resolve().parents[1] / 'assets'
subprocess.run(['convert', str(assets / 'icon.png'), '-resize', '256x256',
                str(assets / 'icon-256.png')], check=True)
subprocess.run(['convert', str(assets / 'icon.png'), '-define',
                'icon:auto-resize=256,128,64,48,32,24,16', str(assets / 'icon.ico')], check=True)

# PNG-compress the 256px entry; retain smaller native DIB entries for Windows.
icon = (assets / 'icon.ico').read_bytes()
reserved, kind, entries = parse_ico(icon)
count = len(entries)
result_entries = []
for width, height, colors, padding, planes, bits, payload in entries:
    if width == height == 0:
        payload = (assets / 'icon-256.png').read_bytes()
    result_entries.append((width, height, colors, padding, planes, bits, payload))
result = bytearray(struct.pack('<HHH', reserved, kind, count))
offset = 6 + count * 16
for width, height, colors, padding, planes, bits, payload in result_entries:
    result.extend(struct.pack('<BBBBHHII', width, height, colors, padding, planes, bits, len(payload), offset))
    offset += len(payload)
for *_, payload in result_entries:
    result.extend(payload)
(assets / 'icon.ico').write_bytes(result)
image = base64.b64encode((assets / 'icon-256.png').read_bytes()).decode('ascii')
(assets / 'icon.svg').write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
    f'<image width="256" height="256" href="data:image/png;base64,{image}"/></svg>\n'
)
