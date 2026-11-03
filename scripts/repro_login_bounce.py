#!/usr/bin/env python3
"""用真实 Chromium 复现「登录后又回到登录页」，并抓出到底是哪一步炸的。

curl 测不出来的那部分（浏览器对 Content-Type、模块加载、缓存、Service Worker
的处理）只有真浏览器才会暴露出来。这里把四类信号全记下来：

  console        页面 console 输出（含 Vite/浏览器的报错）
  pageerror      未捕获的 JS 异常
  failed         网络层失败的请求（chunk 加载失败会出现在这里）
  badstatus      返回 4xx/5xx 的响应

用法:
  python3 scripts/repro_login_bounce.py [地址] [--mobile] [--headed]
  地址默认 http://127.0.0.1:5186
"""
import sys
import time
import json

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5186"
MOBILE = "--mobile" in sys.argv
HEADED = "--headed" in sys.argv
for arg in sys.argv[1:]:
    if arg.startswith("http"):
        URL = arg

USERNAME, PASSWORD = "Marc", "qwertyuiop"

events = []


def attach(page):
    page.on("console", lambda m: events.append(("console", m.type, m.text[:400])))
    page.on("pageerror", lambda e: events.append(("pageerror", "-", str(e)[:400])))
    page.on("requestfailed", lambda r: events.append(
        ("failed", r.failure or "?", f"{r.method} {r.url[:160]}")))
    page.on("response", lambda r: events.append(
        ("badstatus", str(r.status), f"{r.request.method} {r.url[:160]}")) if r.status >= 400 else None)


def storage(page):
    try:
        return page.evaluate("() => ({"
                             "token: localStorage.getItem('auth-token'),"
                             "tokens: localStorage.getItem('pilotdeck-tokens'),"
                             "chunkFlag: sessionStorage.getItem('pilotdeck:chunk-load-reloaded'),"
                             "keys: Object.keys(localStorage)"
                             "})")
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def visible(page):
    """登录页是否还在屏幕上"""
    for sel in ("text=Welcome Back", "text=Sign in to"):
        try:
            if page.locator(sel).first.is_visible(timeout=1500):
                return True
        except Exception:  # noqa: BLE001
            pass
    return False


def report(page, stage, t0):
    st = storage(page)
    tok = st.get("token")
    tok_s = (tok[:16] + "...") if tok else "无"
    per_device = st.get("tokens") or "无"
    try:
        origins = ", ".join(json.loads(per_device).keys()) if per_device != "无" else "无"
    except Exception:  # noqa: BLE001
        origins = per_device
    print(f"\n[{stage}] 用时 {time.time()-t0:.1f}s")
    print(f"  url            : {page.url}")
    print(f"  还在登录页      : {visible(page)}")
    print(f"  auth-token     : {tok_s}")
    print(f"  按设备令牌      : {origins}")
    print(f"  chunk 重载标记  : {st.get('chunkFlag')}")
    return st


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED)
        ctx = browser.new_context(
            viewport={"width": 412, "height": 915} if MOBILE else {"width": 1280, "height": 900},
            is_mobile=MOBILE, has_touch=MOBILE,
            user_agent=("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36") if MOBILE else None,
        )
        page = ctx.new_page()
        attach(page)

        t0 = time.time()
        print(f"=== 打开 {URL} ({'移动端' if MOBILE else '桌面端'}) ===")
        page.goto(URL, wait_until="networkidle", timeout=45000)
        report(page, "初始加载", t0)

        print("\n=== 填入凭据并登录 ===")
        page.fill("input[name=username], input[type=text]", USERNAME)
        page.fill("input[type=password]", PASSWORD)
        page.click("button[type=submit]")
        page.wait_for_timeout(4000)
        st = report(page, "登录后 4 秒", t0)

        page.wait_for_timeout(6000)
        st = report(page, "登录后 10 秒", t0)

        print("\n=== 事件汇总 ===")
        if not events:
            print("  没有任何报错/失败请求")
        for kind, detail, text in events:
            if kind == "console" and detail in ("log", "debug", "info"):
                continue
            print(f"  [{kind}] {detail}: {text}")

        # 还有令牌却停在登录页 = 前端自己把会话丢了
        print("\n=== 结论 ===")
        has_token = bool(st.get("token")) or st.get("tokens") not in (None, "", "无")
        if has_token and visible(page):
            print("  有 token 却回到登录页 —— 会话在前端被丢弃")
        elif not has_token and visible(page):
            print("  token 没存下来 —— 登录响应没被持久化")
        elif not visible(page):
            print("  登录成功，已进入应用")

        ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
