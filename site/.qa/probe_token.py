#!/usr/bin/env python3
"""查两件事：token 有没有真写进 localStorage、前端 fetch 有没有带上 Authorization。"""
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
                         f" catch (e) {{ window.__seedErr = String(e); }}")
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    print("seedErr:", page.evaluate("() => window.__seedErr || null"))
    print("localStorage:", page.evaluate("() => localStorage.getItem('pilotdeck-tokens')") and
          "present (len=%d)" % len(page.evaluate("() => localStorage.getItem('pilotdeck-tokens')") or ""))
    print("keys:", page.evaluate("() => Object.keys(localStorage)"))
    print("auth/user:", page.evaluate(
        "async () => { const r = await fetch('/api/auth/user', {headers: "
        "{Authorization: 'Bearer ' + (JSON.parse(localStorage.getItem('pilotdeck-tokens')||'{}')['auth-token']||'')}});"
        " return r.status + ' ' + (await r.text()).slice(0,80); }"))
    b.close()
