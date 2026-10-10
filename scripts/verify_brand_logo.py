#!/usr/bin/env python3
"""验成果台顶栏 logo：点了不许把人踢出成果台（页面级）。

背景：logo 原本是 ``<button id="btnConsole">`` + ``location.href = '/'``。
成果台与 PilotCode console 跑在同一台 console 上（8799），``'/'`` 就是
PilotCode 微麟智码首页 —— 点一下 logo，成果台直接被换成控制台首页，
而那个首页里只有成果台自己那一条凑数用的 app 条目，纯属死路。

现在 logo 是纯标识：点了不跳、不刷新，也不再长得像能点。

跑法：python3 scripts/verify_brand_logo.py [--api http://127.0.0.1:PORT]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("ARTIFACTS_CDP_PORT", "9335")

import artifacts_cdp as cdp_mod            # noqa: E402

FAILS: list[str] = []

# 页面里做的事：先在 window 上留个哨兵（整页重载会把它冲掉），
# 再点 logo，等 1.2 秒看有没有跳走。
# 用 b.click() 而不是坐标点击：logo 是不是按钮都会派发 click，
# 但按钮特有的「点完页面就没了」在坐标点击下反而测不出来。
_CLICK_PROBE = r"""
(async () => {
  window.__brandProbe = 'alive';
  const b = document.querySelector('.art-topbar .brand');
  if (!b) return JSON.stringify({err: '顶栏没有 .brand 元素'});
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  const info = {
    tag: b.tagName,
    cursor: cs.cursor,
    title: b.getAttribute('title') || '',
    visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
    text: (b.innerText || '').trim().replace(/\s+/g, ' '),
  };
  const before = location.href;
  b.click();
  await new Promise(r2 => setTimeout(r2, 1200));
  return JSON.stringify({before, after: location.href,
                         sentinel: window.__brandProbe || '', info});
})()
"""


def check(ok, name, detail=""):
    if not ok:
        FAILS.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


async def js(cdp, sid, expr):
    res = await cdp.call("Runtime.evaluate", session=sid,
                         params={"expression": expr, "returnByValue": True,
                                 "awaitPromise": True})
    if res.get("exceptionDetails"):
        raise RuntimeError("页面里 JS 炸了：" +
                           json.dumps(res["exceptionDetails"], ensure_ascii=False)[:300])
    return (res.get("result") or {}).get("value")


async def flow(cdp, sid, base):
    await cdp.call("Page.enable", session=sid)
    await cdp.call("Page.navigate", {"url": f"{base}/artifacts.html"}, session=sid)
    try:
        await cdp.wait_event("Page.loadEventFired", 25)
    except Exception:
        pass
    await asyncio.sleep(2.0)

    print("[1 logo 还在顶栏，看得见]")
    info_raw = await js(cdp, sid, """(() => {
        const b = document.querySelector('.art-topbar .brand');
        if (!b) return JSON.stringify({err: '顶栏没有 .brand 元素'});
        const r = b.getBoundingClientRect();
        return JSON.stringify({tag: b.tagName,
          visible: getComputedStyle(b).display !== 'none' && r.width > 0 && r.height > 0,
          text: (b.innerText || '').trim().replace(/\\s+/g, ' ')});
    })()""")
    info = json.loads(info_raw)
    check(info.get("visible") and "成果台" in (info.get("text") or ""),
          "顶栏 logo 可见且写着「成果台」", json.dumps(info, ensure_ascii=False))

    print("[2 点 logo 不跳走]")
    try:
        raw = await js(cdp, sid, _CLICK_PROBE)
        res = json.loads(raw) if raw else {"err": "页面没有返回结果"}
    except Exception as exc:                      # 点完整个执行上下文没了 = 跳了
        res = {"err": "点击后页面上下文消失（已跳走）: " + str(exc)[:160]}
    if res.get("err"):
        check(False, "点 logo 仍停在成果台", res["err"])
        return 0
    check(res.get("after") == res.get("before") and
          (res.get("after") or "").endswith("/artifacts.html"),
          "点 logo 仍停在成果台",
          f"{res.get('before')} → {res.get('after')}")
    check(res.get("sentinel") == "alive", "点 logo 没有整页重载", repr(res.get("sentinel")))

    print("[3 logo 是纯标识，不像能点]")
    el = res.get("info") or {}
    check(el.get("tag") not in ("BUTTON", "A"), "不是按钮/链接", f"<{el.get('tag')}>")
    check(el.get("cursor") != "pointer", "光标不是 pointer", repr(el.get("cursor")))
    return 0


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("ARTIFACTS_API",
                                                     "http://127.0.0.1:8899"))
    args = ap.parse_args()
    base = args.api.rstrip("/")

    async def guarded(cdp, sid):
        try:
            return await flow(cdp, sid, base)
        except Exception:
            import traceback
            traceback.print_exc()
            return 1

    rc = await cdp_mod._with_page(f"{base}/artifacts.html", guarded)
    if rc is None:
        print("浏览器没起来或页面打不开，验不了（页面：%s/artifacts.html）" % base)
        return 2
    if FAILS or rc != 0:
        print("\n结果：没通过" + ("" if rc == 0 else "（流程中途异常，上面有 traceback）"))
        return 1
    print("\n顶栏 logo 全通 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
