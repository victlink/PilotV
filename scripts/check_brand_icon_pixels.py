#!/usr/bin/env python3
"""Sample pixels from rendered brand PNGs to confirm the artwork is correct.

Usage: python3 scripts/check_brand_icon_pixels.py <png> ...
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


def probe(path: Path) -> None:
    with Image.open(path) as img:
        img = img.convert("RGBA")
        w, h = img.size
        # Corner = app-icon background, centre-upper = V glyph,
        # lower band = blue accent rule.
        points = {
            "corner(4,4)": (4, 4),
            "V-centre(w/2,45%)": (w // 2, int(h * 0.45)),
            "accent(y=72%)": (w // 2, int(h * 0.72)),
        }
        print(f"{path.name}  size={img.size} mode={img.mode}")
        for label, (x, y) in points.items():
            px = img.getpixel((x, y))
            print(f"    {label:<20} {px}")
        print()


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    for raw in argv[1:]:
        probe(Path(raw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
