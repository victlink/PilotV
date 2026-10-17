#!/usr/bin/env python3
"""量一下 #works 网格：卡片/内部是否溢出、行高是否被内容撑开。"""
import pathlib, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE = (ROOT / "site" / "index.html").as_uri()

JS = """() => {
  const res = document.querySelector('#works .res');
  const rb = res.getBoundingClientRect();
  const cards = [...res.children].map(c => {
    const r = c.getBoundingClientRect();
    const body = c.querySelector('.rbody') || c.querySelector('.rside');
    const br = body ? body.getBoundingClientRect() : null;
    const viz = c.querySelector('.rviz');
    const vr = viz ? viz.getBoundingClientRect() : null;
    return {cls: c.className,
            h: Math.round(r.height), top: Math.round(r.top - rb.top), bottom: Math.round(r.bottom - rb.top),
            scrollH: c.scrollHeight, clientH: c.clientHeight,
            bodyH: br ? Math.round(br.height) : null, bodyScroll: body ? body.scrollHeight : null,
            vizH: vr ? Math.round(vr.height) : null};
  });
  return {resH: Math.round(rb.height), resScroll: res.scrollHeight, cards};
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(PAGE, wait_until="networkidle")
    pg.wait_for_timeout(1200)
    pg.eval_on_selector("#works", "el => el.scrollIntoView({block:'start'})")
    pg.wait_for_timeout(500)
    for c in pg.evaluate(JS)["cards"]:
        over = c["scrollH"] - c["clientH"]
        body_over = (c["bodyScroll"] or 0) - (c["bodyH"] or 0)
        print(f"{c['cls'][:28]:30s} h={c['h']:4d} top={c['top']:4d} bot={c['bottom']:4d} "
              f"viz={str(c['vizH']):>4} body={c['bodyH']} cardOverflow={over} bodyOverflow={body_over}")
    print("res height:", pg.evaluate("() => Math.round(document.querySelector('#works .res').getBoundingClientRect().height)"))
    b.close()
