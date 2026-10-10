#!/usr/bin/env python3
"""Generate the extension icon set and the Web Store promo tiles.

Draws a monochrome bitten cookie at high resolution and downsamples it to every size
referenced in src/manifest.json, then composes the store's promotional images
from the same artwork.

Usage:  python3 tools/make-icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "src", "icons")
STORE_DIR = os.path.join(ROOT, "store")
SIZES = (16, 32, 48, 128)

# The Web Store shows the 128px icon on cards and wants transparent padding
# around it: the artwork should be about 112px across (85-90% of the width).
# The toolbar sizes are shown tiny, so they fill their whole square.
STORE_ICON = 128
STORE_ICON_ART = 112

# Promotional tiles: (file, width, height). The small tile is required (items
# without one rank lower); the marquee is only used if the item is featured.
PROMO_TILES = (("promo-small.png", 440, 280), ("promo-marquee.png", 1400, 560))
# Dark and flat so the tile stands out on the store's light grey, as the
# guidelines ask, while staying monochrome like the icon.
PROMO_TOP = (44, 44, 48)
PROMO_BOTTOM = (14, 14, 16)

# Palette: monochrome. A white cookie on a near-black tile reads on both light
# and dark browser toolbars.
TILE = (24, 24, 27, 255)
INK = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

SS = 8  # supersampling factor, doubles as the anti-aliasing


def cookie(d: ImageDraw.ImageDraw, s: float, fill, hole) -> None:
    """Draw the bitten cookie glyph on a 100x100 grid scaled by `s`."""

    def dot(px: float, py: float, pr: float, color) -> None:
        x, y, r = px * s, py * s, pr * s
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)

    # The cookie is nudged down-left so the bite reads as a bite rather than a
    # clipped circle.
    dot(47.0, 54.0, 31.0, fill)
    dot(75.0, 27.0, 16.0, hole)
    # Chips are punched out, large enough to survive the 16px toolbar size.
    for px, py, pr in ((39.0, 46.0, 6.0), (57.0, 62.0, 6.0), (35.0, 67.0, 4.5)):
        dot(px, py, pr, hole)


def draw(size: int) -> Image.Image:
    """Render the icon at `size` pixels: the cookie on a rounded tile."""
    n = size * SS
    s = n / 100.0
    img = Image.new("RGBA", (n, n), CLEAR)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=22 * s, fill=TILE)
    cookie(d, s, INK, TILE)
    return img.resize((size, size), Image.LANCZOS)


def glyph(size: int) -> Image.Image:
    """The bare cookie, white on transparent, for the promo tiles."""
    n = size * SS
    img = Image.new("RGBA", (n, n), CLEAR)
    cookie(ImageDraw.Draw(img), n / 100.0, INK, CLEAR)
    return img.resize((size, size), Image.LANCZOS)


def icon(size: int) -> Image.Image:
    """The icon file for `size`, padded as the store asks at 128px."""
    if size != STORE_ICON:
        return draw(size)
    canvas = Image.new("RGBA", (size, size), CLEAR)
    offset = (size - STORE_ICON_ART) // 2
    canvas.paste(draw(STORE_ICON_ART), (offset, offset))
    return canvas


def promo(width: int, height: int) -> Image.Image:
    """A text-free tile: the cookie on a dark vertical gradient, full bleed."""
    tile = Image.new("RGB", (width, height))
    shade = ImageDraw.Draw(tile)
    for y in range(height):
        t = y / max(1, height - 1)
        shade.line(
            [(0, y), (width, y)],
            fill=tuple(round(a + (b - a) * t) for a, b in zip(PROMO_TOP, PROMO_BOTTOM)),
        )

    # Faint crumbs across the tile so it reads as more than a flat fill at
    # half size, kept clear of the cookie itself.
    crumbs = ImageDraw.Draw(tile, "RGBA")
    unit = height / 280
    for fx, fy, fr in ((0.08, 0.2, 9), (0.16, 0.78, 6), (0.86, 0.18, 7), (0.92, 0.7, 10), (0.74, 0.88, 5), (0.27, 0.1, 4)):
        x, y, r = fx * width, fy * height, fr * unit
        crumbs.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 38))

    art = glyph(round(height * 0.78))
    tile.paste(art, ((width - art.width) // 2, (height - art.height) // 2), art)
    return tile


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        icon(size).save(path, "PNG", optimize=True)
        print(f"wrote {path}")

    os.makedirs(STORE_DIR, exist_ok=True)
    for name, width, height in PROMO_TILES:
        path = os.path.join(STORE_DIR, name)
        promo(width, height).save(path, "PNG", optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()