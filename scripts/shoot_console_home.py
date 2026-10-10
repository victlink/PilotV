#!/usr/bin/env python3
"""截一张成果台首页的真图，确认「人在浏览器里看到的东西」是对的。

不只是 curl 200：登录 → 首屏渲染 → 卡片有没有出来，肉眼可见才算数。
复用成果台自己的 CDP 工具（artifacts_cdp），不额外拉浏览器。
"""
import asyncio
import base64
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from console_secrets import login, secret  # noqa: E402
os.environ.setdefault("ARTIFACTS_CDP_PORT", "9333")   # 复用物化器那个 chrome

import artifacts_cdp as cdp_mod  # noqa: E402

BASE = os.environ.get("ARTIFACTS_BASE", "http://127.0.0.1:8799")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/artifacts-console-home.png"
JS_PROBE = r"""
(() => {
  const cards = document.querySelectorAll('[class*=card], [data-artifact-id]');
  const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
  // 只认登录闸门本身可见，不看有没有 password 输入框：
  // ⚙ 设置面板里也有口令输入框（默认藏在抽屉里），拿它判断会永远误报「停在登录页」。
  const gate = document.getElementById('artGate');
  const gateShown = !!gate && !gate.hidden && gate.getClientRects().length > 0;
  return JSON.stringify({
    title: document.title,
    cards: cards.length,
    head: text.slice(0, 240),
    hasLoginForm: gateShown,
  });
})()
"""


# 口令读取与登录统一走 scripts/console_secrets.py：
# 页面 ⚙ 改过口令后，.artifacts-secrets.env 里的值会过期，
# 那里登录失败会直接说明原因和怎么办，而不是抛一个裸 401。


async def main():
    pw = secret("ARTIFACTS_CONSOLE_PASSWORD")
    with login(BASE, "artifacts", pw) as r:
        cookie = r.headers.get("Set-Cookie", "").split(";")[0]
    name, value = cookie.split("=", 1)
    print(f"登录拿到 Cookie：{name}=…（{len(value)} 字符）")

    async def probe(cdp, sid):
        try:
            await cdp.call("Network.enable", session=sid)
            await cdp.call("Network.setCookie", session=sid, params={
                "name": name, "value": value, "url": BASE + "/", "httpOnly": True})
            await cdp.call("Page.navigate", {"url": f"{BASE}/artifacts.html"}, session=sid)
            try:
                await cdp.wait_event("Page.loadEventFired", 25)
            except Exception:
                pass
            await asyncio.sleep(2.0)      # 等首屏把卡片拉出来
            res = await cdp.call("Runtime.evaluate", session=sid,
                                 params={"expression": JS_PROBE, "returnByValue": True})
            if "value" not in res.get("result", {}):
                print("evaluate 原始返回:", json.dumps(res, ensure_ascii=False)[:400])
                return 1
            info = json.loads(res["result"]["value"])
            shot = await cdp.call("Page.captureScreenshot", session=sid,
                                  params={"format": "png", "captureBeyondViewport": False})
            with open(OUT, "wb") as fh:
                fh.write(base64.b64decode(shot["data"]))
            print(f"标题：{info['title']}")
            print(f"页面卡片数：{info['cards']}")
            print(f"是不是停在登录页：{info['hasLoginForm']}")
            print(f"首屏文字：{info['head'][:160]}")
            print(f"截图：{OUT}")
            return 0 if (info["cards"] > 0 and not info["hasLoginForm"]) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1

    rc = await cdp_mod._with_page(f"{BASE}/artifacts.html", probe)
    return rc if rc is not None else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))