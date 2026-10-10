#!/usr/bin/env python3
"""验「人在浏览器里」这条真实路径（不预置 Cookie，从零开始当第一次打开的人）。

问题背景：console 没有登录页，未登录打开 /artifacts.html 曾经只甩一行
{"error": "unauthorized"} 的 JSON，人根本没法登进去。这里模拟真实浏览器的
四步：打开页面 → 闸门是否弹出 → 敲错口令 → 敲对口令进成果台。
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import asyncio
import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("ARTIFACTS_CDP_PORT", "9333")

import artifacts_cdp as cdp_mod  # noqa: E402

# 必须用非回环地址测「未登录」：127.0.0.1 属于回环豁免，怎么都不需要 Cookie，
# 那样测出来的「页面正常」是假象。人实际是从 Tailscale 地址打开的。
def _default_base():
    import subprocess
    try:
        ip = subprocess.run(["tailscale", "ip", "-4"], capture_output=True,
                            text=True).stdout.split()[0]
        return f"http://{ip}:8799"
    except Exception:
        return "http://127.0.0.1:8799"


BASE = os.environ.get("ARTIFACTS_BASE", _default_base())
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/artifacts-login-gate.png"
FAILS = []


def check(ok, name, detail=""):
    if not ok:
        FAILS.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def secret(name):
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        ".artifacts-secrets.env")
    for line in open(path, encoding="utf-8"):
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    return ""


async def eval_js(cdp, sid, expr):
    res = await cdp.call("Runtime.evaluate", session=sid,
                         params={"expression": expr, "returnByValue": True, "awaitPromise": True})
    return res.get("result", {}).get("value")


async def main():
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。
    try:
        assert_test_server(BASE, os.environ.get("ARTIFACTS_TOKEN"))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    pw = secret("ARTIFACTS_CONSOLE_PASSWORD")

    async def flow(cdp, sid):
        # 1) 完全没登录态地打开页面
        await cdp.call("Network.enable", session=sid)
        await cdp.call("Network.clearBrowserCookies", session=sid)
        await cdp.call("Network.deleteCookies", session=sid,
                         params={"name": "pdc_console", "url": BASE + "/"})
        await cdp.call("Page.navigate", {"url": f"{BASE}/artifacts.html"}, session=sid)
        try:
            await cdp.wait_event("Page.loadEventFired", 25)
        except Exception:
            pass
        await asyncio.sleep(2.5)

        # 先确认「真的没登录」：共享 chrome profile 会留 Cookie，页面看着正常也可能是登着的
        anon = await eval_js(cdp, sid, "fetch('/api/artifacts?limit=1').then(r => r.status)")
        check(int(anon or 0) == 401, "前置条件：当前确实是未登录态", f"API 返回 {anon}")

        is_app = await eval_js(cdp, sid, r"""(() => {
            const need = ['artGate', 'btnRefresh', 'btnTheme'];
            const miss = need.filter(id => !document.getElementById(id));
            return JSON.stringify({miss, title: document.title,
                                   jsonish: /^\s*[{[]/.test(document.body.innerText)});
        })()""")
        info = json.loads(is_app)
        check(not info["miss"] and not info["jsonish"],
              "打开页面看到的是成果台应用，不是 JSON 报错", json.dumps(info, ensure_ascii=False))
        gate_shown = await eval_js(cdp, sid, "!document.getElementById('artGate').hidden")
        check(bool(gate_shown), "登录闸门自动弹出")
        items = await eval_js(cdp, sid, "document.querySelectorAll('.art-card').length")
        check(int(items or 0) == 0, "未登录时列表里一条成果都没有",
              f"DOM 里 {items} 个条目")
        _pre_items = int(items or 0)

        shot = await cdp.call("Page.captureScreenshot", session=sid,
                              params={"format": "png"})
        with open(OUT, "wb") as fh:
            fh.write(base64.b64decode(shot["data"]))
        print(f"  截图（未登录 → 闸门）：{OUT}")

        # 2) 故意敲错口令
        await eval_js(cdp, sid, r"""(() => {
            document.getElementById('artGateUser').value = 'artifacts';
            document.getElementById('artGatePass').value = 'wrong-password-on-purpose';
            document.getElementById('artGateForm').dispatchEvent(
              new Event('submit', {cancelable: true, bubbles: true}));
            return true;
        })()""")
        await asyncio.sleep(1.5)
        err = await eval_js(cdp, sid,
                            "(document.getElementById('artGateErr').textContent || '').trim()")
        check(bool(err), "口令错了有明确提示", repr(err))

        # 3) 敲对口令 → 应该直接进成果台
        await eval_js(cdp, sid, r"""(() => {
            document.getElementById('artGatePass').value = %s;
            document.getElementById('artGateForm').dispatchEvent(
              new Event('submit', {cancelable: true, bubbles: true}));
            return true;
        })()""" % json.dumps(pw))
        await asyncio.sleep(3.0)
        after_items = await eval_js(cdp, sid, "document.querySelectorAll('.art-card').length")
        check(int(after_items or 0) > int(_pre_items or 0),
              "登录后成果流真的灌进来了", f"{_pre_items} → {after_items} 张卡片")
        gate_gone = await eval_js(cdp, sid, "document.getElementById('artGate').hidden")
        text = await eval_js(cdp, sid, "document.body.innerText.slice(0, 160)")
        check(bool(gate_gone), "登录成功后闸门消失")
        check("成果" in (text or ""), "登录后进到成果台首屏", repr((text or "")[:60]))

        shot = await cdp.call("Page.captureScreenshot", session=sid,
                              params={"format": "png"})
        with open(OUT.replace(".png", "-after.png"), "wb") as fh:
            fh.write(base64.b64decode(shot["data"]))
        print(f"  截图（登录后 → 成果台）：{OUT.replace('.png', '-after.png')}")
        return 0

    async def guarded(cdp, sid):
        try:
            return await flow(cdp, sid)
        except Exception:
            import traceback
            traceback.print_exc()
            return 1

    rc = await cdp_mod._with_page(f"{BASE}/artifacts.html", guarded)
    if rc is None:
        print("  [FAIL] CDP 流程没跑起来")
        return 1
    if FAILS or rc != 0:
        if FAILS:
            print("\n结果：" + "、".join(FAILS) + " 没通过")
        else:
            print("\n结果：流程中途异常退出（上面有 traceback）")
        return 1
    print("\n浏览器真实路径全通 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))