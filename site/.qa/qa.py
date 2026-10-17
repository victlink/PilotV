#!/usr/bin/env python3
"""介绍页 QA：逐屏截图 + 控制台报错 + 横向溢出检查。

用法：
  python3 qa.py                 # 三档视口逐屏截图
  python3 qa.py --anim          # 额外等 6 秒后再截 #mark（看批注演示动画中途状态）
  python3 qa.py --full          # 额外输出整页长图
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE = (ROOT / "site" / "index.html").as_uri()
OUT = ROOT / "site" / ".qa" / "shots"
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [("desktop", 1440, 900), ("tablet", 834, 1112), ("phone", 390, 844)]
SHOTS = [
    ("hero", None), ("diff", "#diff"), ("shot", "#shot"), ("group", "#group"),
    ("long", "#long"), ("mark", "#mark"), ("flow", "#flow"), ("works", "#works"),
    ("fleet", "#fleet"), ("open", "#open"), ("end", ".end"), ("foot", ".foot"),
]

OVERFLOW = """() => {
  const d = document.documentElement, vw = d.clientWidth, out = [];
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (r.right <= vw + 1.5 && r.left >= -1.5) return;
    if (el.closest('svg')) return;
    out.push(el.tagName + '.' + String(el.className).slice(0,36) + ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
  });
  return {canScrollX: d.scrollWidth > d.clientWidth, scrollW: d.scrollWidth, clientW: vw,
          offenders: [...new Set(out)].slice(0, 10)};
}"""

# 组件级截图：整块看，别被视口高度切一半
ELEMS = [
    ("comp-demo", "#demo"),
    ("comp-flow", "#flow .flowviz"),
    ("comp-works", "#works .res"),
    ("comp-fleet", "#fleet .fleet"),
    ("comp-vs", "#diff .vs"),
    ("comp-shots", "#shot .shots"),
]


def main() -> int:
    anim = "--anim" in sys.argv
    full = "--full" in sys.argv
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, w, h in VIEWPORTS:
            pg = b.new_page(viewport={"width": w, "height": h},
                            device_scale_factor=2 if name == "phone" else 1)
            errs: list[str] = []
            pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
            pg.goto(PAGE, wait_until="networkidle")
            pg.wait_for_timeout(3000)         # 等片头动画播完并淡出（2.4s 切走 + .9s 淡出）

            for tag, anchor in SHOTS:
                if anchor:
                    pg.eval_on_selector(anchor, "el => el.scrollIntoView({block:'start'})")
                    pg.wait_for_timeout(650)  # 触发 reveal / 进入视口动画
                pg.screenshot(path=str(OUT / f"{name}-{tag}.png"))

            if anim:
                pg.eval_on_selector("#mark", "el => el.scrollIntoView({block:'start'})")
                pg.wait_for_timeout(5400)     # 批注演示画到框选那一步
                pg.screenshot(path=str(OUT / f"{name}-mark-anim.png"))

            for tag, sel in ELEMS:
                loc = pg.query_selector(sel)
                if loc:
                    loc.scroll_into_view_if_needed()
                    pg.wait_for_timeout(220)
                    loc.screenshot(path=str(OUT / f"{name}-{tag}.png"))

            if full:
                pg.screenshot(path=str(OUT / f"{name}-full.png"), full_page=True)

            o = pg.evaluate(OVERFLOW)
            bad = "OVERFLOW" if (o["canScrollX"] or o["offenders"]) else "OK"
            print(f"[{name} {w}x{h}] {bad} scrollW={o['scrollW']} clientW={o['clientW']}")
            for x in o["offenders"]:
                print("    ", x)
            for e in errs[:6]:
                print("    ERR", e)
            if not errs:
                print("     无控制台报错")
            pg.close()
        b.close()
    print("截图目录:", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
