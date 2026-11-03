#!/usr/bin/env python3
"""按时间顺序记录登录前后的完整交互，定位 token 在哪一步丢的。

用法: python3 scripts/trace_login.py [地址] [--mobile]
"""
import sys
import time

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5186"
MOBILE = "--mobile" in sys.argv
for arg in sys.argv[1:]:
    if arg.startswith("http"):
        URL = arg

t0 = time.time()
log = []


def note(kind, text):
    log.append((time.time() - t0, kind, text))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 412, "height": 915} if MOBILE else {"width": 1280, "height": 900},
            is_mobile=MOBILE, has_touch=MOBILE,
        )
        page = ctx.new_page()

        page.on("console", lambda m: note("console", f"{m.type}: {m.text[:220]}")
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: note("pageerror", str(e)[:220]))
        page.on("requestfailed", lambda r: note("failed", f"{r.method} {r.url[:120]}"))

        def on_resp(r):
            u = r.url
            if "/api/" not in u:
                return
            tok = r.request.headers.get("authorization", "-")
            mark = ""
            if r.status >= 400:
                mark = "  <<< "
            elif "/api/auth/login" in u:
                mark = "  <<< "
            elif tok.startswith("Bearer"):
                tok = "Bearer 有"
            else:
                tok = "**无 token**"
            note("resp", f"{r.status} {r.request.method} {u.split('5186')[-1].split('3001')[-1][:70]} [{tok}]{mark}")
        page.on("response", on_resp)

        page.goto(URL, wait_until="networkidle", timeout=45000)
        note("mark", f"--- 页面加载完成 url={page.url} ---")

        page.fill("input[name=username]", "Marc")
        page.fill("input[name=password]", "qwertyuiop")
        note("mark", "--- 点击 Sign In ---")
        page.click("button[type=submit]")
        page.wait_for_timeout(8000)

        st = page.evaluate("() => ({token: localStorage.getItem('auth-token'),"
                           "url: location.href,"
                           "body: document.body.innerText.slice(0,200)})")
        note("mark", f"--- 8 秒后：token={st['token'][:20] if st['token'] else '无'} url={st['url']} ---")

        print(f"=== 时间线（{URL}{' 移动端' if MOBILE else ''}） ===")
        for t, kind, text in log:
            if kind == "console" and ("[Auth]" in text or "auth" in text.lower()
                                      or "WebSocket" in text or "Unauthorized" in text
                                      or "401" in text):
                print(f"{t:6.2f}s  {kind:9} {text}")
            elif kind in ("resp", "mark", "pageerror", "failed"):
                print(f"{t:6.2f}s  {kind:9} {text}")

        print(f"\n=== 页面当前内容 ===\n{st['body']}")
        browser.close()


if __name__ == "__main__":
    main()
