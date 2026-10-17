#!/usr/bin/env python3
"""在真应用侧栏里按标题找会话，打印路由 slug（/p/<project>/c/<slug>）。"""
from __future__ import annotations

import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()
KEYS = sorted({"auth-token", "http://127.0.0.1:3001", "https://127.0.0.1:5186", "127.0.0.1:5186"})
DATA = json.dumps({"token": TOKEN, "keys": KEYS})
SEED = (f"(() => {{ try {{ const s = {DATA}; const o = {{}};"
        f" for (const k of s.keys) o[k] = s.token;"
        f" localStorage.setItem('pilotdeck-tokens', JSON.stringify(o));"
        f" }} catch (e) {{}} }})()")

WANT = sys.argv[1] if len(sys.argv) > 1 else "三维"

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1600, "height": 1000}, ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script(SEED)
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)

    for _ in range(3):
        btns = page.get_by_role("button", name="Show more").first
        if btns.count() == 0:
            break
        for i in range(btns.count()):
            try:
                page.get_by_role("button", name="Show more").nth(i).click(timeout=1500)
                page.wait_for_timeout(500)
            except Exception:
                pass
    page.wait_for_timeout(1500)

    rows = page.eval_on_selector_all(
        "a[href*='/c/']",
        "els => els.map(e => ({href: e.getAttribute('href'), text: (e.innerText||'').trim().slice(0,60)}))",
    )
    hits = [r for r in rows if WANT in r["text"]]
    print(f"命中 {len(hits)} 条：")
    for r in hits:
        print(" ", r["href"], "|", r["text"])
    ctx.close()
