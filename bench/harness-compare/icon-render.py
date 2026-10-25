
"""Render harness icons as PNG in per-theme tints."""
import cairosvg
import pathlib
import re

SRC = pathlib.Path(__file__).resolve().parent / "icons-src"
OUT = pathlib.Path(__file__).resolve().parent / "icons"
OUT.mkdir(exist_ok=True)

FILES = {
    "dsh": SRC / "deepseek.svg",
    "codex": SRC / "codex.svg",
    "claude": SRC / "claudecode.svg",
    "gemini": SRC / "googlegemini.svg",
    "opencode": SRC / "opencode.svg",
}
TINTS = {
    "light": {"dsh": "#4D6BFE", "codex": "#0F172A", "claude": "#D97757",
              "gemini": "#4285F4", "opencode": "#0F172A"},
    "dark": {"dsh": "#7C93FF", "codex": "#F3F4F6", "claude": "#F0A07F",
             "gemini": "#8AB4F8", "opencode": "#F3F4F6"},
}

for theme, tints in TINTS.items():
    for name, path in FILES.items():
        svg = path.read_text(encoding="utf-8")
        svg = re.sub(r'fill="[^"]*"', f'fill="{tints[name]}"', svg, count=1)
        if 'fill="' not in svg:
            svg = svg.replace("<svg ", f'<svg fill="{tints[name]}" ', 1)
        cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                         write_to=str(OUT / f"{name}-{theme}.png"),
                         output_width=160, output_height=160)
print("icons rendered")
