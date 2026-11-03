#!/usr/bin/env python3
"""核对页面里的视频是不是真的能播：readyState、首帧宽度、播放后时间有没有往前走。"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8890/index.html"

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs: list[str] = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until="networkidle")
    pg.evaluate("() => window.scrollTo(0, document.querySelector('#cad3d').offsetTop)")
    pg.wait_for_timeout(6000)

    print("=== #cad3d 视频卡 ===")
    for i in range(pg.locator("#cad3d .vframe video").count()):
        v = pg.locator("#cad3d .vframe video").nth(i)
        v.scroll_into_view_if_needed()
        v.evaluate("el => el.play()")
        pg.wait_for_timeout(2500)
        st = v.evaluate("el => ({src: el.currentSrc.split('/').pop(), rs: el.readyState,"
                        " w: el.videoWidth, h: el.videoHeight, t: +el.currentTime.toFixed(2),"
                        " dur: +(el.duration||0).toFixed(1)})")
        print(f"  [{i}] {st['src']:26s} ready={st['rs']} {st['w']}x{st['h']} t={st['t']}s/{st['dur']}s")
        v.evaluate("el => el.pause()")

    print("=== 结尾品牌片 ===")
    pg.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
    pg.wait_for_timeout(4000)
    film = pg.locator(".endfilm video").first
    film.evaluate("el => el.play()")
    pg.wait_for_timeout(2500)
    st = film.evaluate("el => ({src: el.currentSrc.split('/').pop(), rs: el.readyState,"
                       " w: el.videoWidth, t: +el.currentTime.toFixed(2)})")
    print("  ", st)
    print("  SVG 字标是否已让位:", pg.locator(".endfilm.is-live").count() == 1)

    print("=== 控制台报错 ===")
    print("  err=none" if not errs else "\n".join("  " + e[:120] for e in errs[:6]))
    b.close()
    sys.exit(1 if errs else 0)
