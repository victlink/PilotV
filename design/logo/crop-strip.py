#!/usr/bin/env python3
"""Crop one row of the QA contact sheet at full resolution.

The strip stacks 18 rows down 4000-odd pixels, so a row lands ~200px tall and
the interesting overlap -- a blue letter against the blue V -- is a handful of
pixels. Eyeballing the full sheet is how that fault got missed before.

Usage: python3 design/logo/crop-strip.py <row-index> [<row-index> ...]
       python3 design/logo/crop-strip.py --list
"""
import sys
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
STRIP = HERE / "animated-frames" / "qa-strip.png"
# Matches the labels qa-frames.py prints, in order.
ROWS = ["0.30", "0.59", "1.09", "1.46", "1.47", "1.97", "2.34", "2.35",
        "2.86", "3.23-o", "3.23-t", "3.74", "4.11", "4.62",
        "6.18", "6.81", "7.44", "8.07"]
HEADER = 0.055          # fraction of the height the caption band takes


def main():
    args = sys.argv[1:]
    if args == ["--list"]:
        for i, name in enumerate(ROWS):
            print(f"{i:2}  {name}s")
        return
    img = Image.open(STRIP)
    w, h = img.size
    body = h * (1 - HEADER)
    row_h = body / len(ROWS)
    for arg in args:
        i = int(arg)
        top = int(h * HEADER + row_h * i)
        bottom = int(h * HEADER + row_h * (i + 1))
        # Keep the wordmark and the V; the labels live in the left margin.
        crop = img.crop((int(w * 0.20), top, w, bottom))
        out = HERE / "animated-frames" / f"zoom-{ROWS[i]}.png"
        crop.save(out)
        print(f"row {i} ({ROWS[i]}s) -> {out.name} {crop.size}")


if __name__ == "__main__":
    main()
