#!/usr/bin/env python3
"""把登录页的表单结构打出来，并真正提交一次登录，抓取 /api/auth/login 的完整往返。

用法: python3 scripts/inspect_login_form.py [地址]
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5186"
for arg in sys.argv[1:]:
    if arg.startswith("http"):
        URL = arg

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})

    def on_request(r):
        if "/api/auth/login" in r.url:
            print(f"\n>>> 发出 POST /api/auth/login")
            print(f"    headers: {json.dumps(dict(r.headers), ensure_ascii=False, indent=6)}")

    def on_response(r):
        if "/api/auth/login" in r.url:
            print(f"\n<<< 收到 {r.status}")
            print(f"    headers: {json.dumps(dict(r.headers), ensure_ascii=False, indent=6)}")

    page.on("request", on_request)
    page.on("response", on_response)

    page.goto(URL, wait_until="networkidle", timeout=45000)

    print("=== 表单元素 ===")
    for sel in ("input", "button", "form"):
        for el in page.locator(sel).all():
            try:
                print(f"  <{el.evaluate('e=>e.tagName').lower()}> "
                      f"type={el.get_attribute('type')!r} "
                      f"name={el.get_attribute('name')!r} "
                      f"id={el.get_attribute('id')!r} "
                      f"text={(el.inner_text() or '').strip()[:40]!r}")
            except Exception:  # noqa: BLE001
                pass

    print("\n=== 提交登录 ===")
    page.fill("input[type=password]", "Marc_probe_only")  # 先探一下能否定位
    print("  密码框可定位")
    page.fill("input[type=password]", "qwertyuiop")

    pw = page.locator("input[type=password]")
    # 用户名框：排除密码框的第一个可见文本框
    boxes = page.locator("input:not([type=password]):not([type=hidden])")
    for i in range(boxes.count()):
        print(f"  候选输入框 {i}: type={boxes.nth(i).get_attribute('type')} "
              f"name={boxes.nth(i).get_attribute('name')} "
              f"placeholder={boxes.nth(i).get_attribute('placeholder')}")
    boxes.first.fill("Marc")

    page.keyboard.press("Enter")
    page.wait_for_timeout(5000)

    st = page.evaluate("() => ({token: localStorage.getItem('auth-token'),"
                       "url: location.href})")
    print(f"\n=== 结果 ===\n  token: {st['token'][:20] if st['token'] else '无'}")
    print(f"  url  : {st['url']}")
    for t in page.locator("text=Welcome Back").all():
        print(f"  仍在登录页: {t.is_visible()}")

    browser.close()
