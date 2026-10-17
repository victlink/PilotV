#!/usr/bin/env python3
"""把 Playwright 抓到的整屏截图裁成站点用的窄图（webp）。

用法:
  python3 site/.qa/make_shots.py --src review/app-3d.png --out site/assets/shot-3d.webp \
      --box 470,200,2870,1700 --size 1200x750
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def crop_to_aspect(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """按目标比例居中裁切，避免直接拉伸把界面弄变形。"""
    tw, th = size
    want = tw / th
    w, h = im.size
    if w / h > want:  # 太宽 → 两侧收
        new_w = int(round(h * want))
        left = (w - new_w) // 2
        im = im.crop((left, 0, left + new_w, h))
    elif w / h < want:  # 太高 → 上下收
        new_h = int(round(w / want))
        top = (h - new_h) // 2
        im = im.crop((0, top, w, top + new_h))
    return im


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--box", default=None, help="x0,y0,x1,y1，像素坐标")
    ap.add_argument("--size", default="1200x750")
    ap.add_argument("--quality", type=int, default=82)
    args = ap.parse_args()

    im = Image.open(args.src).convert("RGB")
    if args.box:
        x0, y0, x1, y1 = (int(v) for v in args.box.split(","))
        im = im.crop((x0, y0, x1, y1))

    tw, th = (int(v) for v in args.size.lower().split("x"))
    im = crop_to_aspect(im, (tw, th))
    im = im.resize((tw, th), Image.LANCZOS)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "WEBP", quality=args.quality, method=6)
    print(f"{out} {im.size[0]}x{im.size[1]} {out.stat().st_size // 1024} KB  <- {args.src} box={args.box}")


if __name__ == "__main__":
    main()
