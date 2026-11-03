#!/usr/bin/env python3
"""诊断：注入 token 后前端到底读到什么、有没有把 Authorization 挂上。"""
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
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.evaluate(
        "tok => { const k='pilotdeck-tokens';"
        " const o=JSON.parse(localStorage.getItem(k)||'{}');"
        " o['auth-token']=tok; const b=window.__PILOTV__&&window.__PILOTV__.backend;"
        " if(b) o[b]=tok; o[window.location.origin]=tok;"
        " localStorage.setItem(k, JSON.stringify(o)); }", TOKEN)
    page.reload(wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)
    print("__PILOTV__:", page.evaluate("() => window.__PILOTV__ || null"))
    print("token store keys:", page.evaluate(
        "() => Object.keys(JSON.parse(localStorage.getItem('pilotdeck-tokens')||'{}'))"))
    print("token store:", page.evaluate(
        "() => (JSON.parse(localStorage.getItem('pilotdeck-tokens')||'{}')['auth-token']||'')"
        ".slice(0,12)"))
    print("status call:", page.evaluate(
        "async () => { const o=JSON.parse(localStorage.getItem('pilotdeck-tokens')||'{}');"
        " const t=o['auth-token']||'';"
        " const r=await fetch('/api/auth/status');"
        " const r2=await fetch('/api/auth/status',{headers:{Authorization:'Bearer '+t}});"
        " return 'no-hdr '+r.status+' / with-hdr '+r2.status+' '+await r2.text(); }"))
    b.close()
