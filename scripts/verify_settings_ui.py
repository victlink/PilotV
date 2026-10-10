#!/usr/bin/env python3
"""在真实浏览器里验设置面板（页面级）。

验的是「看得见、点得动、提示对」：
  1. 顶栏有常驻的设置入口（不是藏在别处）
  2. 点开面板能拉到当前账号
  3. 面板里没有令牌 / 会话密钥明文
  4. 旧口令填错 → 服务端那句「旧口令不对」透出来，不是静默失败
  5. 两次不一致 → 前端先拦下，请求根本没发出去
  6. 真改成功 → 提示对 + 输入框清空 + 按钮恢复
  7. Escape / 关闭按钮 都能关掉

**真改口令那一步跑在本脚本自己起的隔离 console 上**（自己的用户库、自己的会话
密钥、自己的数据目录，进程退出即消失）。生产 artifacts 账号一个字节都不动 ——
拿生产账号做「改坏了怎么办」的实验是蠢事。

跑法：python3 scripts/verify_settings_ui.py [输出截图路径]
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ARTIFACTS_CDP_PORT", "9334")

import artifacts_cdp as cdp_mod            # noqa: E402
from isolated_console import isolated_console  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/artifacts-settings-panel.png"
FAILS: list[str] = []


def check(ok, name, detail=""):
    if not ok:
        FAILS.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


async def js(cdp, sid, expr):
    """在页面里跑一段 JS，返回其值（Promise 自动 await）。"""
    res = await cdp.call("Runtime.evaluate", session=sid,
                         params={"expression": expr, "returnByValue": True,
                                 "awaitPromise": True})
    if res.get("exceptionDetails"):
        raise RuntimeError("页面里 JS 炸了：" +
                           json.dumps(res["exceptionDetails"], ensure_ascii=False)[:300])
    return res.get("result", {}).get("value")


async def flow(cdp, sid, base, iso):
    new_pw = "ui-new-password-" + os.urandom(3).hex()

    await cdp.call("Page.enable", session=sid)
    await cdp.call("Network.enable", session=sid)
    await cdp.call("Page.navigate", {"url": f"{base}/artifacts.html"}, session=sid)
    try:
        await cdp.wait_event("Page.loadEventFired", 25)
    except Exception:
        pass
    await asyncio.sleep(2.0)

    # 登录：必须在页面上下文里打，否则 Cookie 进不了这个浏览器的 jar
    st = await js(cdp, sid, """(async () => {
        const r = await fetch('/api/login', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(%s)});
        return r.status;
    })()""" % json.dumps({"username": iso.user, "password": iso.password}))
    check(st == 200, "浏览器里登录成功（隔离账号）", f"HTTP {st}")
    await js(cdp, sid, "location.reload()")
    await asyncio.sleep(2.5)

    print("[1 顶栏有常驻入口]")
    entry = json.loads(await js(cdp, sid, """(() => {
        const b = document.getElementById('btnSettings');
        if (!b) return JSON.stringify({exists: false});
        const r = b.getBoundingClientRect();
        return JSON.stringify({exists: true,
          inBar: !!b.closest('.art-topbar'),
          vis: getComputedStyle(b).display !== 'none' && r.width > 0 && r.height > 0,
          title: b.title});
    })()"""))
    check(entry.get("exists") and entry.get("inBar") and entry.get("vis"),
          "设置按钮在顶栏且看得见", json.dumps(entry, ensure_ascii=False))

    print("[2 打开面板，能拉到账号]")
    await js(cdp, sid, "document.getElementById('btnSettings').click()")
    await asyncio.sleep(1.2)
    check(bool(await js(cdp, sid, "!document.getElementById('settingsPanel').hidden")),
          "面板打开")
    me_user = (await js(cdp, sid,
                        "document.getElementById('meUser').textContent.trim()")) or ""
    check(me_user == iso.user, "面板显示当前用户名", repr(me_user))
    via = await js(cdp, sid, "document.getElementById('meVia').textContent.trim()")
    check("Cookie" in (via or ""), "标明登录方式是 Cookie", repr(via))

    print("[3 面板里没有密钥明文]")
    text = await js(cdp, sid, "document.getElementById('settingsPanel').innerText")
    tok = os.environ.get("ARTIFACTS_TOKEN", "")
    check(not (tok and tok in (text or "")), "面板不出现 API 令牌明文")
    check("令牌" in (text or "") and "已配置" in (text or ""),
          "令牌只报「有没有配」")

    shot = await cdp.call("Page.captureScreenshot", session=sid, params={"format": "png"})
    with open(OUT, "wb") as fh:
        fh.write(base64.b64decode(shot["data"]))
    print(f"  截图（面板打开）：{OUT}")

    print("[4 旧口令填错 → 服务端原话透出来]")
    await js(cdp, sid, """(() => {
        document.getElementById('pwOld').value = 'definitely-wrong';
        document.getElementById('pwNew').value = 'brand-new-password-1';
        document.getElementById('pwConfirm').value = 'brand-new-password-1';
        document.getElementById('pwForm').dispatchEvent(
          new Event('submit', {cancelable: true, bubbles: true}));
        return true;
    })()""")
    await asyncio.sleep(1.5)
    msg = await js(cdp, sid, "document.getElementById('pwMsg').textContent.trim()")
    check("旧口令不对" in (msg or ""), "旧口令错的提示是服务端那句", repr(msg))
    kept = await js(cdp, sid, "document.getElementById('pwNew').value")
    check(kept == "brand-new-password-1", "失败后不清空输入（方便改了重试）")

    print("[5 两次不一致 → 前端先拦]")
    sent = await js(cdp, sid, """(async () => {
        let hit = 0;
        const of = window.fetch;
        window.fetch = (...a) => { if (String(a[0]).includes('/password')) hit++; return of(...a); };
        document.getElementById('pwOld').value = 'x';
        document.getElementById('pwNew').value = 'aaaaaaaaaaaaaaa';
        document.getElementById('pwConfirm').value = 'bbbbbbbbbbbbbbb';
        document.getElementById('pwForm').dispatchEvent(
          new Event('submit', {cancelable: true, bubbles: true}));
        await new Promise(r => setTimeout(r, 900));
        window.fetch = of;
        return hit;
    })()""")
    check(int(sent or 0) == 0, "不一致时压根没发请求", f"发出 {sent} 次")
    msg = await js(cdp, sid, "document.getElementById('pwMsg').textContent.trim()")
    check("不一致" in (msg or ""), "提示说的是「不一致」", repr(msg))

    print("[6 真改口令（隔离 console 上）]")
    await js(cdp, sid, """(() => {
        document.getElementById('pwOld').value = %s;
        document.getElementById('pwNew').value = %s;
        document.getElementById('pwConfirm').value = %s;
        document.getElementById('pwForm').dispatchEvent(
          new Event('submit', {cancelable: true, bubbles: true}));
        return true;
    })()""" % (json.dumps(iso.password), json.dumps(new_pw), json.dumps(new_pw)))
    await asyncio.sleep(2.0)
    msg = (await js(cdp, sid,
                    "document.getElementById('pwMsg').textContent.trim()")) or ""
    check("已改好" in msg, "成功提示出现", repr(msg[:50]))
    check("其它设备" in msg, "提示说清「别的设备仍有效」，不假装把人踢了",
          repr(msg[-50:]))
    check(await js(cdp, sid, "document.getElementById('pwNew').value") == "",
          "成功后输入框清空")
    check((await js(cdp, sid,
                    "document.getElementById('pwSubmit').textContent.trim()")) == "改口令",
          "按钮从「提交中…」恢复")

    print("[7 关闭方式]")
    await js(cdp, sid,
             "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))")
    await asyncio.sleep(0.4)
    check(bool(await js(cdp, sid, "document.getElementById('settingsPanel').hidden")),
          "Escape 能关")
    await js(cdp, sid, "document.getElementById('btnSettings').click()")
    await asyncio.sleep(0.4)
    await js(cdp, sid, "document.getElementById('btnSettingsClose').click()")
    await asyncio.sleep(0.4)
    check(bool(await js(cdp, sid, "document.getElementById('settingsPanel').hidden")),
          "关闭按钮能关")
    return 0


async def main():
    with isolated_console() as iso:
        async def guarded(cdp, sid):
            try:
                return await flow(cdp, sid, iso.base, iso)
            except Exception:
                import traceback
                traceback.print_exc()
                return 1
        rc = await cdp_mod._with_page(f"{iso.base}/artifacts.html", guarded)
    if FAILS or rc != 0:
        print("\n结果：没通过" + ("" if rc == 0 else "（流程中途异常，上面有 traceback）"))
        return 1
    print("\n设置面板页面级全通 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))