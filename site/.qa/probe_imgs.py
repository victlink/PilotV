#!/usr/bin/env python3
"""查一下 5 张界面截图的真实内容边界（去掉底部/四周的死白）。"""
import pathlib
from PIL import Image, ImageChops

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "site" / "assets"

for name in ["shot-board.webp", "shot-review.webp", "shot-files.webp", "shot-chat.webp",
             "shot-box.webp", "shot-ink.webp"]:
    p = SRC / name
    if not p.exists():
        print(f"{name}: 缺文件")
        continue
    im = Image.open(p).convert("RGB")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    diff = ImageChops.difference(im, bg).convert("L")
    # 容忍极小的压缩噪声
    diff = diff.point(lambda v: 255 if v > 12 else 0)
    bbox = diff.getbbox()
    print(f"{name:18s} size={im.size} 内容范围={bbox}")
