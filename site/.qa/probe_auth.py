#!/usr/bin/env python3
"""抓启动阶段 /api/auth/status 的实际请求头与响应体，定位为什么前端判定未登录。"""
from __future__ import annotations

import json
import pathlib

from playwright.sync_api import sync_playwright

TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script(f"try {{ localStorage.setItem('pilotdeck-tokens',"
                         f" JSON.stringify({{'auth-token': {json.dumps(TOKEN)}}})); }}"
                         f" catch (e) {{}}")

    def on_request(r):
        if "/api/" in r.url and ("/api/auth/" in r.url or "onboarding" in r.url):
            print("REQ", r.url.split("127.0.0.1:5186")[-1],
                  "| auth hdr:", "yes" if r.headers.get("authorization") else "NO",
                  "| x-backend:", r.headers.get("x-pilotv-backend"))

    def on_response(r):
        if "/api/" in r.url and ("/api/auth/" in r.url or "onboarding" in r.url):
            try:
                body = r.text()[:120]
            except Exception:
                body = "<no body>"
            print("RES", r.status, r.url.split("127.0.0.1:5186")[-1], body)

    page.on("request", on_request)
    page.on("response", on_response)
    page.on("console", lambda m: print("CONSOLE", m.type, m.text[:150])
            if m.type in ("error", "warning") else None)
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.evaluate("tok => { const k='pilotdeck-tokens';"
                   " const o=JSON.parse(localStorage.getItem(k)||'{}');"
                   " o['auth-token']=tok; const b=window.__PILOTV__&&window.__PILOTV__.backend;"
                   " if(b) o[b]=tok; o[window.location.origin]=tok;"
                   " localStorage.setItem(k, JSON.stringify(o)); }", TOKEN)
    page.reload(wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(7000)
    print("final url:", page.url)
    b.close()
