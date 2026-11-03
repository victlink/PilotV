#!/usr/bin/env python3
"""确认登录成功后 token 到底被写到了哪个键。

预期（如果诊断成立）：localStorage 里 pilotdeck-tokens 有值且含 JWT，
而 auth-token 是空的 —— 这就是「登录后所有请求都不带 Authorization」的根因。

用法: python3 scripts/check_token_keys.py [地址]
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5186"
for arg in sys.argv[1:]:
    if arg.startswith("http"):
        URL = arg

DUMP = """() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k);
    out[k] = v && v.length > 120 ? v.slice(0, 120) + `...(len=${v.length})` : v;
  }
  return out;
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle", timeout=45000)

    print("=== 登录前 localStorage ===")
    for k, v in page.evaluate(DUMP).items():
        print(f"  {k} = {v}")

    page.fill("input[name=username]", "Marc")
    page.fill("input[name=password]", "qwertyuiop")
    page.click("button[type=submit]")
    page.wait_for_timeout(2500)

    after = page.evaluate(DUMP)
    print("\n=== 登录后 localStorage ===")
    for k, v in after.items():
        print(f"  {k} = {v}")

    print("\n=== 判定 ===")
    scoped = after.get("pilotdeck-tokens")
    legacy = after.get("auth-token")
    if scoped and not legacy:
        print("  确诊：token 只写进了 pilotdeck-tokens，auth-token 是空的")
        try:
            print("  作用域映射: " + json.dumps(json.loads(scoped), ensure_ascii=False)[:200])
        except Exception:  # noqa: BLE001
            pass
    elif scoped and legacy:
        print("  两个键都有值")
    elif not scoped and not legacy:
        print("  两个键都没有 —— token 完全没落盘")
    browser.close()
