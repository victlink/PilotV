#!/usr/bin/env python3
"""复用本机已开着的 Chrome（CDP 9222）看 PilotV 是不是已经登录态。

不新建登录、不碰账号：只是借用户自己浏览器的会话去开页面，能省掉要密码这件事。
"""
from __future__ import annotations

import pathlib
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://127.0.0.1:5186/"
OUT = pathlib.Path("review/probe-chrome.png")

with sync_playwright() as pw:
    b = pw.chromium.connect_over_cdp("http://127.0.0.1:9222")
    ctx = b.contexts[0]
    print("contexts:", len(b.contexts), "pages:", sum(len(c.pages) for c in b.contexts))
    page = ctx.new_page()
    page.set_viewport_size({"width": 1440, "height": 900})
    # 自签证书：浏览器已经在跑，不能加启动参数，只能用 CDP 让这一页忽略。
    try:
        cdp = ctx.new_cdp_session(page)
        cdp.send("Security.setIgnoreCertificateErrors", {"ignore": True})
        print("cert errors ignored via CDP")
    except Exception as exc:
        print("CDP 设置失败:", exc)
    try:
        page.goto(URL, wait_until="domcontentloaded", timeout=45000)
    except Exception as exc:
        print("goto:", exc)
    page.wait_for_timeout(4000)
    print("url:", page.url)
    print("password inputs:", page.locator("input[type=password]").count())
    print("body:", " ".join(page.locator("body").inner_text().split())[:300])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT))
    print("shot:", OUT)
    page.close()
    b.close()
