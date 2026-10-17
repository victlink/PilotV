#!/usr/bin/env python3
"""按 session id 打开会话 → 切「成果」页 → dump 页面文本，找成果标题。"""
from __future__ import annotations

import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import shot_app_real as S  # noqa: E402

URL = "https://127.0.0.1:5186/"
SESSION_ID = sys.argv[1] if len(sys.argv) > 1 else "web:s_461e9e95-3e5b-44aa-b62e-9594f058e8a7"
PROJECT = sys.argv[2] if len(sys.argv) > 2 else "PilotV"

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=S.CHROME_FLAGS)
    ctx = b.new_context(viewport={"width": 1440, "height": 900},
                        ignore_https_errors=True, device_scale_factor=1)
    page = ctx.new_page()
    seed = (f"(() => {{ const t = {pathlib.Path('/tmp/pilotv-shot-token').read_text().strip()!r};"
            f" const o = {{}}; for (const k of ['auth-token','http://127.0.0.1:3001',"
            f"'https://127.0.0.1:5186','127.0.0.1:5186']) o[k] = t;"
            f" localStorage.setItem('pilotdeck-tokens', JSON.stringify(o)); }})()")
    page.add_init_script(seed)
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    S.open_session(page, URL, "三维", SESSION_ID, PROJECT, "http://127.0.0.1:3001")
    page.wait_for_timeout(4000)

    try:
        S.open_artifacts_tab(page)
    except Exception as e:
        print("切成果页失败:", str(e)[:160])
    page.wait_for_timeout(5000)
    page.screenshot(path="/tmp/probe-artifacts.png", full_page=False)

    texts = page.eval_on_selector_all(
        "[class*='artifact'], [class*='card'], h1, h2, h3, h4, button, a",
        "els => Array.from(new Set(els.map(e => (e.innerText||'').trim().split('\\n')[0])"
        " .filter(s => s && s.length < 60))).slice(0, 120)",
    )
    print("---- 可见文本 ----")
    for t in texts:
        print(" ", t)
    print("---- body ----")
    print(" ".join(page.locator("body").inner_text().split())[:1500])
    ctx.close()
