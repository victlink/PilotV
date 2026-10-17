#!/usr/bin/env python3
"""登录后的首页长什么样：把正文文本、导航、按钮都打出来，找会话列表入口。"""
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

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script(SEED)
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)
    print("url:", page.url)
    print("--- body ---")
    print(" ".join(page.locator("body").inner_text().split())[:1500])
    print("--- navs ---")
    print(page.eval_on_selector_all("nav", "els => els.map(e => e.getAttribute('aria-label'))"))
    print("--- buttons ---")
    labels = page.eval_on_selector_all(
        "button", "els => els.map(e => (e.getAttribute('aria-label') || e.innerText || '').trim().slice(0,24))")
    print(json.dumps([x for x in labels if x][:40], ensure_ascii=False))
    print("--- links ---")
    hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => e.getAttribute('href'))")
    print(json.dumps(hrefs[:25], ensure_ascii=False))
    page.screenshot(path=sys.argv[1] if len(sys.argv) > 1 else "review/probe-home.png")
    b.close()
