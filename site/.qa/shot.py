#!/usr/bin/env python3
"""PilotV 介绍页三档视口截图校对。"""
import sys, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
PAGE = (ROOT / "site" / "index.html").as_uri()
OUT = ROOT / "site" / ".qa"
OUT.mkdir(exist_ok=True)

VIEWPORTS = [
    ("desktop", 1440, 900),
    ("tablet", 834, 1112),
    ("phone", 390, 844),
]
# 每档要单独截的屏（锚点）
SHOTS = [
    ("hero", None),
    ("s2", "#start"),
]

def main():
    full = "--full" in sys.argv
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, w, h in VIEWPORTS:
            pg = b.new_page(viewport={"width": w, "height": h},
                            device_scale_factor=2 if name == "phone" else 1)
            errs = []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto(PAGE, wait_until="networkidle")
            pg.wait_for_timeout(900)

            if full:
                pg.screenshot(path=str(OUT / f"{name}-full.png"), full_page=True)
            else:
                pg.screenshot(path=str(OUT / f"{name}-hero.png"))

            # 逐屏滚到位再截，触发 IntersectionObserver
            for anchor, tag in [("#start", "s2")]:
                pass
            secs = pg.query_selector_all("section, header.hero")
            for i, s in enumerate(secs):
                s.scroll_into_view_if_needed()
                pg.wait_for_timeout(700)
                name_id = s.get_attribute("id") or ("hero" if i == 0 else f"s{i+1}")
                pg.screenshot(path=str(OUT / f"{name}-{name_id}.png"))

            # 溢出检测
            ov = pg.evaluate("""() => {
              const bad = [];
              const vw = document.documentElement.clientWidth;
              document.querySelectorAll('body *').forEach(el => {
                const r = el.getBoundingClientRect();
                if (r.width === 0) return;
                if (r.right > vw + 1.5 || r.left < -1.5) {
                  bad.push(el.tagName + '.' + (el.className||'').toString().slice(0,40)
                           + ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
                }
              });
              return [...new Set(bad)].slice(0, 12);
            }""")
            print(f"[{name} {w}x{h}] overflow={ov if ov else 'none'} err={errs if errs else 'none'}")
            pg.close()
        b.close()
    print("shots ->", OUT)

if __name__ == "__main__":
    main()
