#!/usr/bin/env python3
"""在页面里给 localStorage 打探针，证明 auth-token 到底是存了又被谁删掉的。

在页面任何脚本之前注入，包装 setItem/removeItem，每次都往控制台打一条带时间戳
的记录，同时保留调用栈的调用方信息，便于定位是哪个模块删的。

用法: python3 scripts/probe_token_lifecycle.py [地址]
"""
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5186"
for arg in sys.argv[1:]:
    if arg.startswith("http"):
        URL = arg

PROBE = """
(() => {
  const log = (op, key) => {
    if (key !== 'auth-token') return;
    const stack = (new Error().stack || '').split('\\n').slice(2, 6).join(' | ');
    console.log(`[TOKEN-PROBE] ${op} auth-token  <<< ${stack}`);
  };
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    log('SET', k);
    return setItem.call(this, k, v);
  };
  Storage.prototype.removeItem = function (k) {
    log('REMOVE', k);
    return removeItem.call(this, k);
  };
})();
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    ctx.add_init_script(PROBE)
    page = ctx.new_page()

    page.on("console", lambda m: print(f"{m.text[:300]}")
            if "TOKEN-PROBE" in m.text or "[Auth]" in m.text else None)
    page.on("response", lambda r: print(f"  -> {r.status} {r.request.method} {r.url.split('5186')[-1][:60]}"
                                       f"  [auth={'有' if r.request.headers.get('authorization') else '**无**'}]")
            if "/api/auth" in r.url or "onboarding" in r.url else None)

    page.goto(URL, wait_until="networkidle", timeout=45000)
    print("\n########## 提交登录 ##########")
    page.fill("input[name=username]", "Marc")
    page.fill("input[name=password]", "qwertyuiop")
    page.click("button[type=submit]")
    page.wait_for_timeout(7000)
    print(f"\n最终 auth-token: {page.evaluate(chr(40)+')=>localStorage.getItem(\"auth-token\")'+chr(41))}")
    browser.close()
