#!/usr/bin/env python3
"""两个键都种下之后，抓所有 /api/ 请求的 Authorization 头与 401 响应。"""
from __future__ import annotations

import json
import pathlib

from playwright.sync_api import sync_playwright

TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()
SEED = {"token": TOKEN, "keys": ["auth-token", "http://127.0.0.1:3001",
                                "127.0.0.1:5186", "https://127.0.0.1:5186"]}

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script("seed => { try { const o={}; for (const k of seed.keys) o[k]=seed.token;"
                         " localStorage.setItem('pilotdeck-tokens', JSON.stringify(o)); } catch(e){} }")
    seen: list[str] = []

    def on_response(r):
        if "/api/" not in r.url:
            return
        auth = r.request.headers.get("authorization")
        try:
            body = r.text()[:100]
        except Exception:
            body = ""
        line = (f"{r.status} {'HDR' if auth else 'no-hdr'} "
                f"{r.url.split('5186')[-1][:50]} {body[:80]}")
        if line not in seen:
            seen.append(line)
            print(line)

    page.on("response", on_response)
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)
    print("--- keys after:", page.evaluate(
        "() => Object.keys(JSON.parse(localStorage.getItem('pilotdeck-tokens')||'{}'))"))
    b.close()
