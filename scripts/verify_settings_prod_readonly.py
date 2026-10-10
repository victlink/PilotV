"""只读地看一眼**生产**设置面板：入口在不在、抽屉打不打得开、账号信息读不读得到。

刻意**不改口令**：生产 `artifacts` 账号是用户自己的钥匙，自动化去改它属于越权。
这里只发 GET（读 me），顺带确认面板里没有明文密钥。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import artifacts_cdp as cdp_mod  # noqa: E402
from console_secrets import login, secret  # noqa: E402

BASE = os.environ.get("ARTIFACTS_BASE",
                      "http://100.90.196.104:8799").rstrip("/")
FAILS: list[str] = []


def check(ok, name, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


async def eval_js(cdp, sid, expr):
    res = await cdp.call("Runtime.evaluate", session=sid,
                         params={"expression": expr, "returnByValue": True,
                                 "awaitPromise": True})
    if res.get("exceptionDetails"):
        raise RuntimeError(res["exceptionDetails"].get("text", "js 异常"))
    return res.get("result", {}).get("value")


PROBE = r"""
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  const gate = document.getElementById('artGate');
  out.loginGateVisible = !!gate && !gate.hidden && gate.getClientRects().length > 0;
  const btn = document.getElementById('btnSettings');
  out.settingsButtonExists = !!btn;
  out.settingsButtonVisible = !!btn && btn.getClientRects().length > 0;
  if (!btn) return JSON.stringify(out);
  btn.click();
  const panel = document.getElementById('settingsPanel');
  for (let i = 0; i < 60 && panel.hidden; i++) await sleep(50);
  out.panelVisible = !panel.hidden;
  // 关键：账号信息是 fetch 回来后才填的。点开就立刻读，读到的是
  // 「读取中…」占位符 —— 那是测试自己没等，不是面板坏了。
  const userEl = document.getElementById('meUser');
  for (let i = 0; i < 100 && (userEl.textContent || '').includes('读取中'); i++) {
    await sleep(100);
  }
  out.meUser = (userEl.textContent || '').trim();
  out.meVia = (document.getElementById('meVia')?.textContent || '').trim();
  out.meArtifacts = (document.getElementById('meArtifacts')?.textContent || '').trim();
  out.meToken = (document.getElementById('meToken')?.textContent || '').trim();
  out.meNotify = (document.getElementById('meNotify')?.textContent || '').trim();
  const txt = panel.innerText || '';
  // 面板里不该出现任何看起来像秘密的东西
  out.leaksSecret = /sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10}|pdc_console=|SESSION_SECRET/.test(txt);
  out.hasPwForm = !!document.getElementById('pwForm');
  out.hasLogout = !!document.getElementById('btnLogout');
  out.pwFieldsFilled = ['pwOld', 'pwNew', 'pwConfirm']
    .some(id => (document.getElementById(id)?.value || '').length > 0);
  // 关掉，确认两种关闭方式里的一种可用
  document.getElementById('btnSettingsClose').click();
  await sleep(200);
  out.closesAgain = panel.hidden;
  return JSON.stringify(out);
})()
"""


async def main():
    pw = secret("ARTIFACTS_CONSOLE_PASSWORD")
    if not pw:
        print("✗ 读不到 ARTIFACTS_CONSOLE_PASSWORD，无法登录生产面板")
        return 2
    cookie = None
    with login(BASE, "artifacts", pw) as r:
        cookie = r.headers.get("Set-Cookie", "").split(";")[0]
    name, value = cookie.split("=", 1)
    print(f"登录生产拿到 Cookie：{name}=…（{len(value)} 字符）")

    async def probe(cdp, sid):
        await cdp.call("Network.enable", session=sid)
        await cdp.call("Network.setCookie", session=sid, params={
            "name": name, "value": value, "domain": BASE.split("//", 1)[1],
            "path": "/"})
        await cdp.call("Page.navigate", {"url": f"{BASE}/artifacts.html"}, session=sid)
        try:
            await cdp.wait_event("Page.loadEventFired", 25)
        except Exception:
            pass
        await asyncio.sleep(2.5)
        raw = await eval_js(cdp, sid, PROBE)
        info = json.loads(raw)
        # 一条条落成 PASS/FAIL，脚本不该只丢一句「有问题」
        check(not info["loginGateVisible"], "已登录时不该出现登录闸门")
        check(info["settingsButtonExists"], "顶栏有 ⚙ 设置入口")
        check(info["settingsButtonVisible"], "⚙ 入口肉眼可见")
        check(info["panelVisible"], "点开设置抽屉成功")
        check(info["meUser"] == "artifacts", "读到当前用户名", info["meUser"])
        check(bool(info["meVia"]), "读到登录方式", info["meVia"])
        check(info["meArtifacts"].isdigit(),
              "读到成果总数", info["meArtifacts"])
        # 「非空」是假阳性：占位符「—」也非空。必须看起来像个真的「有无」结论。
        check(info["meToken"].startswith(("已配置", "未配置")) and
              info["meNotify"].startswith(("已配置", "未配置")),
              "令牌/推送只报有无", f"令牌={info['meToken']} 推送={info['meNotify']}")
        check(not info["leaksSecret"], "面板里没有任何明文密钥")
        check(info["hasPwForm"] and info["hasLogout"], "改密表单和退出入口都在")
        check(not info["pwFieldsFilled"], "口令框是空的（没替用户填任何东西）")
        check(info["closesAgain"], "✕ 能关掉抽屉")
        return info

    rc = await cdp_mod._with_page(f"{BASE}/artifacts.html", probe)
    if rc is None:
        print("✗ 浏览器没起来，页面级检查没做成（不是面板的锅）")
        return 2
    if FAILS:
        print(f"生产设置面板：{len(FAILS)} 项没过 —— " + "、".join(FAILS))
        return 1
    print("生产设置面板：只读检查全部通过 ✓（未修改任何生产口令）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))