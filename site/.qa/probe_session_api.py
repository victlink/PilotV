#!/usr/bin/env python3
"""抓后端会话接口的响应，直接拿到 session id 与标题。"""
from __future__ import annotations

import json
import pathlib

from playwright.sync_api import sync_playwright

TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()
KEYS = sorted({"auth-token", "http://127.0.0.1:3001", "https://127.0.0.1:5186", "127.0.0.1:5186"})
DATA = json.dumps({"token": TOKEN, "keys": KEYS})
SEED = (f"(() => {{ try {{ const s = {DATA}; const o = {{}};"
        f" for (const k of s.keys) o[k] = s.token;"
        f" localStorage.setItem('pilotdeck-tokens', JSON.stringify(o));"
        f" }} catch (e) {{}} }})()")

WANT = "三维"

seen: list[str] = []
payloads: list[object] = []


def on_response(r) -> None:
    u = r.url
    if "session" not in u:
        return
    seen.append(u)
    try:
        payloads.append(json.loads(r.text()))
    except Exception:
        pass


def walk(obj, out: list[dict]) -> None:
    if isinstance(obj, dict):
        title = obj.get("title") or obj.get("name") or obj.get("label") or ""
        sid = obj.get("id") or obj.get("sessionId") or obj.get("session_id") or ""
        if sid and isinstance(title, str) and title:
            out.append({"id": sid, "title": title, "project": obj.get("project") or obj.get("projectId") or ""})
        for v in obj.values():
            walk(v, out)
    elif isinstance(obj, list):
        for v in obj:
            walk(v, out)


with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1600, "height": 1000}, ignore_https_errors=True)
    page = ctx.new_page()
    page.on("response", on_response)
    page.add_init_script(SEED)
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(7000)
    ctx.close()

print("接口:", sorted(set(seen))[:8])
rows: list[dict] = []
for p in payloads:
    walk(p, rows)
hits = [r for r in rows if WANT in r["title"]]
print(f"命中 {len(hits)} 条：")
for r in hits[:10]:
    print(" ", r)
