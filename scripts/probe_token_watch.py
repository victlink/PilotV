#!/usr/bin/env python3
"""高频轮询 auth-token，并监听页面跳转，看 token 是否出现过、又被什么清掉。

上一个探针只包了 Storage.prototype.setItem，漏掉了
`localStorage['auth-token'] = x` 这种属性赋值写法。这里两条都覆盖。

用法: python3 scripts/probe_token_watch.py [地址]
"""
import sys
import time

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5186"
for arg in sys.argv[1:]:
    if arg.startswith("http"):
        URL = arg

# 同时覆盖 setItem / removeItem / 属性赋值
PROBE = """
(() => {
  window.__tokenLog = [];
  const push = (op, extra) => window.__tokenLog.push({op, extra, t: Date.now()});
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'auth-token') push('SET', String(v).slice(0, 24));
    return setItem.call(this, k, v);
  };
  Storage.prototype.removeItem = function (k) {
    if (k === 'auth-token') {
      push('REMOVE', (new Error().stack || '').split('\\n')[3] || '');
    }
    return removeItem.call(this, k);
  };
  const desc = Object.getOwnPropertyDescriptor(Storage.prototype, 'auth-token');
  if (desc && desc.set) {
    Object.defineProperty(window.localStorage.__proto__, 'auth-token', {
      get() { return desc.get.call(this); },
      set(v) { push('ASSIGN', String(v).slice(0, 24)); return desc.set.call(this, v); },
      configurable: true,
    });
  }
  const clear = Storage.prototype.clear;
  Storage.prototype.clear = function () { push('CLEAR', ''); return clear.call(this); };
})();
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    ctx.add_init_script(PROBE)
    page = ctx.new_page()

    page.on("framenavigated",
            lambda f: print(f"  >> 页面导航 -> {f.url}") if f == page.main_frame else None)

    page.goto(URL, wait_until="networkidle", timeout=45000)
    print(f"加载后 token: {page.evaluate('()=>localStorage.getItem(\"auth-token\")')!r}")

    page.fill("input[name=username]", "Marc")
    page.fill("input[name=password]", "qwertyuiop")
    print("\n########## 点击 Sign In ##########")
    page.click("button[type=submit]")

    # 每 40ms 采样一次，看看 token 有没有短暂出现过
    seen = set()
    t0 = time.time()
    while time.time() - t0 < 8:
        cur = page.evaluate("()=>localStorage.getItem('auth-token')")
        key = (cur is None, cur[:16] if cur else None)
        if key not in seen:
            seen.add(key)
            print(f"  {time.time()-t0:5.2f}s  token = "
                  f"{cur[:24] + '...' if cur else '无'}")
        page.wait_for_timeout(40)

    print("\n=== 注入探针捕获到的操作 ===")
    for e in page.evaluate("()=>window.__tokenLog || []"):
        print(f"  {e['op']:7} {e['extra']}")

    print(f"\n最终 token: {page.evaluate('()=>localStorage.getItem(\"auth-token\")')!r}")
    browser.close()
