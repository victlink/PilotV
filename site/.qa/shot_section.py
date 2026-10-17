#!/usr/bin/env python3
"""介绍页单章节整段截图：先滚全页把 lazy 图片触发出来，再整页截、按章节位置裁。

用法:
  python3 site/.qa/shot_section.py --section cad3d --vp desktop
  python3 site/.qa/shot_section.py --section cad3d --vp phone --out review/cad3d-phone.png
"""
from __future__ import annotations

import argparse
import pathlib

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
PAGE = (ROOT / "site" / "index.html").as_uri()

VIEWPORTS = {
    "desktop": (1440, 900),
    "tablet": (834, 1112),
    "phone": (390, 844),
}


def load_all_images(pg, step: int = 600) -> None:
    """分段滚到底再滚回顶，逼着 loading=lazy 的图都下载完。"""
    total = pg.evaluate("document.body.scrollHeight")
    for y in range(0, total + step, step):
        pg.evaluate(f"window.scrollTo(0,{y})")
        pg.wait_for_timeout(120)
    pg.wait_for_timeout(600)
    pg.evaluate("window.scrollTo(0,0)")
    pg.wait_for_timeout(400)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--section", required=True, help="section 的 id，如 cad3d")
    ap.add_argument("--vp", default="desktop", choices=list(VIEWPORTS))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    w, h = VIEWPORTS[args.vp]
    out = pathlib.Path(args.out) if args.out else ROOT / "review" / f"sec-{args.section}-{args.vp}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    full_png = out.with_name(out.stem + "-full.png")

    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
        errs: list[str] = []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(PAGE, wait_until="networkidle")
        pg.wait_for_timeout(600)

        load_all_images(pg)

        # 入场动画是 IntersectionObserver 直接写行内样式，这里照同样方式全部点亮
        pg.evaluate(
            "() => { for (const el of document.querySelectorAll('[data-reveal]'))"
            " { el.style.opacity = 1; el.style.transform = 'none'; } }"
        )

        box = pg.eval_on_selector(
            f"#{args.section}",
            "el => { const r = el.getBoundingClientRect();"
            " return {x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height}; }",
        )
        pg.screenshot(path=str(full_png), full_page=True)
        b.close()

    im = Image.open(full_png)
    crop = im.crop(
        (
            max(0, int(box["x"])),
            max(0, int(box["y"])),
            min(im.width, int(box["x"] + box["w"])),
            min(im.height, int(box["y"] + box["h"])),
        )
    )
    crop.save(out)
    full_png.unlink()
    print(f"{out}  {crop.width}x{crop.height}  err={errs or 'none'}")


if __name__ == "__main__":
    main()
