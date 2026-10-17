#!/usr/bin/env python3
"""打开指定会话 → 切到「成果」页 → 列出成果标题。用来找哪条会话挂着 3D 成果。"""
from __future__ import annotations

import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()
KEYS = sorted({"auth-token", "http://127.0.0.1:3001", "https://127.0.0.1:5186", "127.0.0.1:5186"})
DATA = json.dumps({"token": TOKEN, "keys": KEYS})
SEED = (f"(() => {{ try {{ const s = {DATA}; const o = {{}};"
        f" for (const k of s.keys) o[k] = s.token;"
        f" localStorage.setItem('pilotdeck-tokens', JSON.stringify(o));"
        f" }} catch (e) {{}} }})()")

session_title = sys.argv[1]
needle = sys.argv[2] if len(sys.argv) > 2 else "连接法兰"

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1600, "height": 1000}, ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script(SEED)
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)

    project = sys.argv[3] if len(sys.argv) > 3 else ""
    if project:
        pb = page.get_by_role("button", name=re.compile(f"^{re.escape(project)}$")).first
        if pb.is_visible():
            pb.click()
            page.wait_for_timeout(1200)
        for _ in range(6):
            more = page.get_by_role("button", name=re.compile("Show more|显示更多")).first
            if not more.is_visible():
                break
            more.click()
            page.wait_for_timeout(600)

    node = page.get_by_text(session_title, exact=False).first
    node.wait_for(state="visible", timeout=45000)
    node.click()
    page.wait_for_timeout(3000)

    nav = page.get_by_role("navigation", name=re.compile("页面切换|对话与成果切换")).first
    nav.get_by_role("button", name="成果").click()
    page.wait_for_timeout(4000)

    body = " ".join(page.locator("body").inner_text().split())
    print("url:", page.url)
    print("has needle:", needle in body)
    hits = [t for t in page.eval_on_selector_all(
        "button, [role=button], h1, h2, h3, p, span",
        "els => els.map(e => (e.innerText||'').trim())")
        if needle in t and len(t) < 60]
    print("hits:", json.dumps(sorted(set(hits))[:10], ensure_ascii=False))
    page.screenshot(path="review/probe-artifacts.png")
    print("body:", body[:400])
    b.close()
