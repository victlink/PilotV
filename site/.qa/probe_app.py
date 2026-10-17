#!/usr/bin/env python3
"""注入本机 token 后，看 PilotV 首屏到底渲染成什么样：登录页？侧栏？会话列表？"""
from __future__ import annotations

import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://127.0.0.1:5186/"
TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "review/probe-app.png")

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900},
                        ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script(f"try {{ localStorage.setItem('pilotdeck-tokens',"
                         f" JSON.stringify({{'auth-token': {json.dumps(TOKEN)}}})); }}"
                         f" catch (e) {{}}")
    logs: list[str] = []
    page.on("response", lambda r: logs.append(f"{r.status} {r.request.method} {r.url[:90]}")
            if r.status >= 400 else None)
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.evaluate("tok => { const k = 'pilotdeck-tokens';"
                   " const o = JSON.parse(localStorage.getItem(k) || '{}');"
                   " o['auth-token'] = tok; const b = window.__PILOTV__ && window.__PILOTV__.backend;"
                   " if (b) o[b] = tok; o[window.location.origin] = tok;"
                   " localStorage.setItem(k, JSON.stringify(o)); }", TOKEN)
    page.reload(wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)
    print("url:", page.url)
    print("password inputs:", page.locator("input[type=password]").count())
    print("body:", " ".join(page.locator("body").inner_text().split())[:600])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT))
    print("shot:", OUT)
    if logs:
        print("4xx/5xx:", " | ".join(logs[:8]))
    b.close()
