#!/usr/bin/env python3
"""把候选真实截图缩成小预览，便于快速挑选；并把入选的图裁剪压缩进 site/assets/。"""
import pathlib, sys
from PIL import Image

ROOT = pathlib.Path("/home/marc/PilotV")
MOB = ROOT / "pilotdeck-mobile" / "review"
REV = ROOT / "review"
PREV = ROOT / "site" / ".qa" / "prev"
PREV.mkdir(parents=True, exist_ok=True)

CANDIDATES = [
    MOB / "desktop.png", MOB / "desktop-saved.png",
    MOB / "ink-01-box-draft-reachable.png", MOB / "ink-02-box-saved.png",
    MOB / "ink-03-ink-drawn.png", MOB / "ink-04-ink-saved.png",
    MOB / "ink-into-composer.png",
    MOB / "rail-01-chat.png", MOB / "rail-02-files.png", MOB / "rail-03-artifacts.png",
    MOB / "pane-07-model3d.png", MOB / "pane-07-page.png",
    MOB / "pane-05-drag.png", MOB / "phone-native-panel.png",
    MOB / "tablet-portrait.png",
    REV / "console-reveal.png", REV / "live" / "device-settings-dialog.png",
    ROOT / "常用资料" / "PilotV-Logo-3D" / "PilotV-Logo-3D.png",
    ROOT / "demo" / "chart.png",
]


def preview(src: pathlib.Path, w: int = 760):
    im = Image.open(src).convert("RGB")
    if im.width > w:
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    out = PREV / (src.stem + ".jpg")
    im.save(out, "JPEG", quality=72, optimize=True)
    return out, im.size


def main():
    for src in CANDIDATES:
        if not src.exists():
            print("MISS", src)
            continue
        out, size = preview(src)
        print(f"{src.name:38s} {size} -> {out.stat().st_size//1024}KB")


if __name__ == "__main__":
    main()
