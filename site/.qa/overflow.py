#!/usr/bin/env python3
"""检查页面是否真的横向溢出（scrollWidth 对比 clientWidth），并逐个确认越界元素是否为 SVG 内部节点。"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
PAGE = (ROOT / "site" / "index.html").as_uri()

PROBE = """() => {
  const d = document.documentElement;
  const res = {
    clientW: d.clientWidth,
    scrollW: d.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    canScrollX: d.scrollWidth > d.clientWidth,
    realOffenders: [],
  };
  const vw = d.clientWidth;
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right <= vw + 1.5 && r.left >= -1.5) return;
    if (el.ownerSVGElement || el.closest('svg')) return;   // SVG 内部坐标，由 SVG 自身裁剪
    res.realOffenders.push(el.tagName + '.' + String(el.className).slice(0, 40)
      + ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
  });
  res.realOffenders = [...new Set(res.realOffenders)].slice(0, 12);
  return res;
}"""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, w, h in [("desktop", 1440, 900), ("tablet", 834, 1112), ("phone", 390, 844)]:
            pg = b.new_page(viewport={"width": w, "height": h})
            pg.goto(PAGE, wait_until="networkidle")
            pg.wait_for_timeout(600)
            r = pg.evaluate(PROBE)
            verdict = "OK" if (not r["canScrollX"] and not r["realOffenders"]) else "OVERFLOW"
            print(f'[{name} {w}x{h}] {verdict} scrollW={r["scrollW"]} clientW={r["clientW"]} '
                  f'offenders={r["realOffenders"] or "none"}')
            pg.close()
        b.close()


if __name__ == "__main__":
    main()
