#!/usr/bin/env python3
"""把选中的真实界面截图裁剪压缩为 site/assets/*.webp，供介绍页使用。"""
import pathlib
from PIL import Image

ROOT = pathlib.Path("/home/marc/PilotV")
MOB = ROOT / "pilotdeck-mobile" / "review"
REV = ROOT / "review"
OUT = ROOT / "site" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

# (源文件, 输出名, 裁剪框 or None, 输出最大宽)
JOBS = [
    (MOB / "ink-02-box-saved.png",        "shot-box",    None,                  780),
    (MOB / "ink-04-ink-saved.png",        "shot-ink",    None,                  780),
    (MOB / "ink-into-composer.png",       "shot-chat",   None,                 1200),
    (MOB / "rail-03-artifacts.png",       "shot-board",  None,                 1200),
    (MOB / "rail-02-files.png",           "shot-files",  None,                 1200),
    (REV / "console-reveal.png",          "shot-review", (0, 0, 1280, 668),   1200),
    (REV / "live" / "device-settings-dialog.png", "shot-devices", (368, 62, 912, 658), 760),
    (ROOT / "常用资料" / "PilotV-Logo-3D" / "PilotV-Logo-3D.png", "shot-3d", (0, 0, 760, 760), 700),
]


def main():
    total = 0
    for src, name, box, maxw in JOBS:
        if not src.exists():
            print("MISS", src)
            continue
        im = Image.open(src).convert("RGB")
        if box:
            im = im.crop(box)
        if im.width > maxw:
            im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
        dst = OUT / f"{name}.webp"
        im.save(dst, "WEBP", quality=76, method=6)
        kb = dst.stat().st_size / 1024
        total += kb
        print(f"{name:14s} {im.size[0]}x{im.size[1]:<5} {kb:6.1f} KB")
    print(f"--- 合计 {total/1024:.2f} MB ---")


if __name__ == "__main__":
    main()
