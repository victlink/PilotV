#!/usr/bin/env python3
"""Compare the letter outlines in two PilotV wordmark SVGs.

The generator can only outline from Lato Black; a different build of that face
reorders contours and moves a few curve points by a fraction of a unit, so a
string diff is too strict and too blunt. This walks both paths, maps them onto
each other point for point and reports the largest deviation in glyph units
(1 unit = 0.005 viewBox units on a 280-wide wordmark).

Usage: python3 design/logo/compare-letterforms.py OLD.svg NEW.svg
"""
import re
import sys

ARGS = {"M": 2, "L": 2, "H": 1, "V": 1, "Q": 4, "C": 6, "Z": 0}
TOKEN = re.compile(r"[A-Za-z]|-?[\d.]+")


def contour_points(d):
    """Every coordinate in path order, following the current point."""
    tokens = TOKEN.findall(d)
    pts, cur, i = [], (0.0, 0.0), 0
    while i < len(tokens):
        cmd = tokens[i]
        if cmd not in ARGS:
            raise ValueError(f"unexpected token {cmd!r}")
        i += 1
        if cmd in "Zz":                            # closepath carries no numbers
            continue
        while i < len(tokens) and not tokens[i].isalpha():
            raw = [float(v) for v in tokens[i:i + ARGS[cmd]]]
            i += ARGS[cmd]
            rel = cmd.islower()
            if cmd in "ML":
                cur = (cur[0] + raw[0], cur[1] + raw[1]) if rel else (raw[0], raw[1])
            elif cmd == "H":
                cur = (cur[0] + raw[0], cur[1]) if rel else (raw[0], cur[1])
            elif cmd == "V":
                cur = (cur[0], cur[1] + raw[0]) if rel else (cur[0], raw[0])
            else:                                   # Q and C keep their start
                cur = (cur[0] + raw[-2], cur[1] + raw[-1]) if rel else (raw[-2], raw[-1])
            pts.append(cur)
    return pts


def main(old_path, new_path):
    old = re.findall(r'<path d="([^"]+)"', open(old_path).read())
    new = re.findall(r'<path d="([^"]+)"', open(new_path).read())
    if len(old) != len(new):
        raise SystemExit(f"path count {len(old)} vs {len(new)}")
    worst = 0.0
    for index, (a, b) in enumerate(zip(old, new)):
        pa, pb = contour_points(a), contour_points(b)
        same_shape = len(pa) == len(pb)
        # Contour order is a property of the font build, not of the mark, so
        # the geometry is compared as a point set either way.
        dev = max(max(abs(x - y) for x, y in zip(p, q))
                  for p, q in zip(sorted(pa), sorted(pb)))
        worst = max(worst, dev)
        order = "same order" if same_shape and all(
            abs(x - y) < 1e-6 for p, q in zip(pa, pb) for x, y in zip(p, q)
        ) else "contours reordered"
        print(f"letter {index}: {len(pa):>3} vs {len(pb):>3} points, "
              f"max deviation {dev:.3f} units ({order})")
    print(f"\nworst deviation {worst:.3f} glyph units "
          f"= {worst * 0.0005:.5f} viewBox units on a 280px wordmark")
    return 0 if worst <= 1.0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
