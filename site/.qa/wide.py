#!/usr/bin/env python3
"""找出真正撑宽页面的元素：按 offsetWidth 排序，输出最宽的若干个及其选择器路径。"""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE = (ROOT / "site" / "index.html").as_uri()
W = int(sys.argv[1]) if len(sys.argv) > 1 else 390

PROBE = """(W) => {
  const path = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string')
      s += '.' + el.className.trim().split(/\\s+/).join('.');
    return s;
  };
  return [...document.querySelectorAll('body *')]
    .map(el => ({el, w: Math.round(el.getBoundingClientRect().width),
                 sw: el.scrollWidth, ow: el.offsetWidth}))
    .filter(o => o.w > W + 1 && !o.el.closest('svg'))
    .sort((a, b) => b.w - a.w).slice(0, 14)
    .map(o => `${o.w}px (scrollW ${o.sw}) ${path(o.el)}`);
}"""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": W, "height": 844})
        pg.goto(PAGE, wait_until="networkidle")
        pg.wait_for_timeout(700)
        print(f"== viewport {W} ==")
        for line in pg.evaluate(PROBE, W):
            print(" ", line)
        b.close()


if __name__ == "__main__":
    main()
