#!/usr/bin/env python3
"""把侧栏所有项目、所有 "Show more" 都点开，再列出全部会话标题。"""
from __future__ import annotations

import json
import pathlib
import re

from playwright.sync_api import sync_playwright

TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()
KEYS = sorted({"auth-token", "http://127.0.0.1:3001", "https://127.0.0.1:5186", "127.0.0.1:5186"})
DATA = json.dumps({"token": TOKEN, "keys": KEYS})
SEED = (f"(() => {{ try {{ const s = {DATA}; const o = {{}};"
        f" for (const k of s.keys) o[k] = s.token;"
        f" localStorage.setItem('pilotdeck-tokens', JSON.stringify(o));"
        f" }} catch (e) {{}} }})()")

PROJECTS = ["PilotV", "CAD", "设备管理", "3D", "sub2api", "pilotcode", "aistudio",
            "VICTLINK-AI", "OBS", "General conversation", "PilotStudio"]

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1600, "height": 1000}, ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script(SEED)
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)

    for proj in PROJECTS:
        btn = page.get_by_role("button", name=re.compile(f"^{re.escape(proj)}$")).first
        if not btn.is_visible():
            continue
        btn.click()
        page.wait_for_timeout(900)
        # 该项目下的 Show more 全点开
        for _ in range(6):
            more = page.get_by_role("button", name=re.compile("Show more|显示更多")).all()
            clicked = False
            for m in more:
                if m.is_visible():
                    m.click()
                    page.wait_for_timeout(500)
                    clicked = True
                    break
            if not clicked:
                break

    body = " ".join(page.locator("body").inner_text().split())
    print("total chars:", len(body))
    print("has 三维成果:", "三维成果展示与交互标注" in body)
    print("has 连接法兰:", "连接法兰" in body)
    titles = page.eval_on_selector_all(
        "aside button, nav button",
        "els => els.map(e => (e.innerText||'').trim()).filter(t => t && t.length < 40)")
    uniq = sorted(set(titles))
    print(json.dumps(uniq, ensure_ascii=False, indent=0)[:2500])
    b.close()
