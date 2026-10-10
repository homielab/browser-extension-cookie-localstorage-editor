#!/usr/bin/env python3
"""Compose Chrome Web Store screenshots from real popup captures.

The Chrome Web Store wants 1280x800 or 640x400 images. A bare screenshot of a
780px popup looks lost at that size, so each capture is placed on a framed
background with a caption, sized to fit.

Usage:  python3 tools/make-screenshots.py <captures-dir> <output-dir>

Captures are produced by loading the extension unpacked and opening the popup;
see CONTRIBUTING.md. Each capture is expected to be a PNG of the popup on its
own, at its natural size.
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

WIDTH, HEIGHT = 1280, 800

# Frame and text colours per theme of the capture.
THEMES = {
    "light": {"bg": (27, 31, 38), "ink": (245, 246, 248), "muted": (150, 158, 170)},
    "dark": {"bg": (246, 247, 249), "ink": (24, 28, 34), "muted": (100, 108, 120)},
}

FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
)
FONT_BOLD_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
)

# (source capture, output name, theme, title, subtitle). The store takes at
# most five.
SHOTS = (
    ("live-list-light.png", "01-list.png", "light",
     "Every cookie for this page",
     "Including parent-domain and HttpOnly cookies the page itself cannot read."),
    ("live-editor-light.png", "02-editor.png", "light",
     "Quick edit any attribute",
     "Click a cookie and type: the value is ready. Ctrl + Enter saves."),
    ("storage-list-light.png", "03-local-storage.png", "light",
     "Local storage, one tab away",
     "Every item of the page, with its size. Add, edit, rename, delete, clear."),
    ("storage-editor-dark.png", "04-storage-json-dark.png", "dark",
     "Read and edit JSON values",
     "Format a stored object to edit it, then save it back on one line."),
    ("io-export-dark.png", "05-export-dark.png", "dark",
     "Export and import",
     "Cookies as JSON or a Cookie header; local storage as a JSON object."),
)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    for path in FONT_BOLD_CANDIDATES if bold else FONT_CANDIDATES:
        if os.path.isfile(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def wrap(draw: ImageDraw.ImageDraw, text: str, typeface, max_width: int) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=typeface) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def compose(capture_path: str, theme: str, title: str, subtitle: str, out_path: str) -> None:
    colours = THEMES[theme]
    canvas = Image.new("RGB", (WIDTH, HEIGHT), colours["bg"])
    draw = ImageDraw.Draw(canvas)

    # A faint lighter wash, so the frame is not flat.
    wash = Image.new("RGB", (WIDTH, HEIGHT), colours["bg"])
    ImageDraw.Draw(wash).ellipse(
        [-260, HEIGHT - 560, 560, HEIGHT + 220], fill=tuple(min(255, c + 16) for c in colours["bg"])
    )
    canvas = Image.blend(canvas, wash, 0.55)
    draw = ImageDraw.Draw(canvas)

    # Text on the left, popup on the right: the popup is wide and short, so a
    # stacked layout would waste most of a 16:10 frame.
    text_left, text_width = 84, 460
    title_font = font(46, bold=True)
    body_font = font(23)

    title_lines = wrap(draw, title, title_font, text_width)
    subtitle_lines = wrap(draw, subtitle, body_font, text_width)
    block_height = len(title_lines) * 58 + 26 + len(subtitle_lines) * 34

    y = (HEIGHT - block_height) // 2
    for line in title_lines:
        draw.text((text_left, y), line, font=title_font, fill=colours["ink"])
        y += 58
    y += 26
    for line in subtitle_lines:
        draw.text((text_left, y), line, font=body_font, fill=colours["muted"])
        y += 34

    # The popup, scaled to fill the right-hand column.
    popup = Image.open(capture_path).convert("RGBA")
    column_left = 600
    column_width = WIDTH - column_left - 84
    scale = min(column_width / popup.width, (HEIGHT - 96) / popup.height, 1.5)
    popup = popup.resize((int(popup.width * scale), int(popup.height * scale)), Image.LANCZOS)

    box = [column_left + (column_width - popup.width) // 2, (HEIGHT - popup.height) // 2]

    shadow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rectangle(
        (box[0] + 4, box[1] + 16, box[0] + popup.width + 4, box[1] + popup.height + 16),
        fill=(0, 0, 0, 130),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(20))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow)
    canvas.paste(popup, box, popup)

    canvas.convert("RGB").save(out_path, "PNG", optimize=True)


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    captures_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    for source, name, theme, title, subtitle in SHOTS:
        path = os.path.join(captures_dir, source)
        if not os.path.isfile(path):
            print(f"skipping {name}: {path} not found", file=sys.stderr)
            continue
        target = os.path.join(out_dir, name)
        compose(path, theme, title, subtitle, target)
        print(f"wrote {target} ({WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    main()
