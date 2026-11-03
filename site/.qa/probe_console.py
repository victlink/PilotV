#!/usr/bin/env python3
"""探一下成果台首页到底渲染成什么样：有没有登录门、树有没有节点。"""
from __future__ import annotations

import pathlib
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8799/"
OUT = pathlib.Path("review/probe-console.png")

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    p = b.new_context(viewport={"width": 1440, "height": 900},
                      ignore_https_errors=True).new_page()
    logs: list[str] = []
    p.on("console", lambda m: logs.append(f"{m.type}: {m.text[:160]}"))
    p.on("pageerror", lambda e: logs.append(f"pageerror: {e.message[:200]}"))
    p.goto(URL, wait_until="networkidle", timeout=40000)
    p.wait_for_timeout(2500)
    print("title:", p.title())
    print("url:", p.url)
    print("art-node-artifact:", p.locator(".art-node-artifact").count())
    print("art-project-head:", p.locator(".art-project-head").count())
    print("login form:", p.locator("input[type=password]").count())
    print("body text[:400]:", " ".join(p.locator("body").inner_text().split())[:400])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    p.screenshot(path=str(OUT), full_page=False)
    print("console:", " | ".join(logs[:10]))
    b.close()
