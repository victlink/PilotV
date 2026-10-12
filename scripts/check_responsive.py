#!/usr/bin/env python3
"""成果台横竖屏 / 多端自适应核查（含平板转屏一致性）。

只读诊断：不改任何项目文件。用项目自带的 CDP 客户端起 Chrome，按设备档位
真实模拟（含触摸设备 mobile:true，any-pointer:coarse 才会命中），
量布局 + 截图（截图落 /tmp）。

关键一项「转屏一致性」：在同一个标签页里先按竖屏尺寸量一次，再原地切成
横屏量一次，比较布局骨架（几列 / 左栏是栅格列还是盖层 / 标注栏是常驻列还是
抽屉）以及抽屉的开关状态是否跟着转屏存活 —— 转屏只该改尺寸，不该换骨架。

用法:
    python3 scripts/check_responsive.py
    ARTIFACTS_SHOTS=1 python3 scripts/check_responsive.py
    ARTIFACTS_URL=http://127.0.0.1:8799/artifacts.html python3 scripts/check_responsive.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from artifacts_cdp import _Cdp, ensure_browser  # noqa: E402

URL = os.environ.get("ARTIFACTS_URL", "http://127.0.0.1:8799/artifacts.html")
SHOTS = os.environ.get("ARTIFACTS_SHOTS", "0") == "1"
SHOT_DIR = "/tmp/artifacts-shots"
NAV_TIMEOUT = 20

# (名称, 宽, 高, 是否触摸设备)
PROFILES = [
    ("桌面 1920x1080", 1920, 1080, False),
    ("桌面窄窗 1100x700", 1100, 700, False),
    ("iPadPro13 竖 1032x1376", 1032, 1376, True),
    ("iPadPro13 横 1376x1032", 1376, 1032, True),
    ("iPadPro11 竖 834x1194", 834, 1194, True),
    ("iPadPro11 横 1194x834", 1194, 834, True),
    ("iPad mini 竖 744x1133", 744, 1133, True),
    ("iPad mini 横 1133x744", 1133, 744, True),
    ("iPhone15 竖 393x852", 393, 852, True),
    ("iPhone15 横 852x393", 852, 393, True),
    ("安卓小屏 360x740", 360, 740, True),
]

# 旋转组：同一台设备转屏，必须保持同一套骨架
ROTATE_GROUPS = [
    ("iPadPro13", 1032, 1376, 1376, 1032),
    ("iPadPro11", 834, 1194, 1194, 834),
    ("iPad mini", 744, 1133, 1133, 744),
    ("iPhone15", 393, 852, 852, 393),
]

MEASURE_JS = r"""
(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {w: Math.round(r.width), h: Math.round(r.height),
            pos: getComputedStyle(el).position, disp: getComputedStyle(el).display};
  };
  const body = document.querySelector('.art-body');
  const de = document.documentElement;
  const tb = document.querySelector('.art-topbar');
  const anno = document.querySelector('.art-anno');
  const cols = body ? getComputedStyle(body).gridTemplateColumns : '';
  return JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    cols, colCount: cols.trim() ? cols.trim().split(/\s+/).length : 0,
    coarse: matchMedia('(any-pointer: coarse)').matches,
    ptrCoarse: matchMedia('(pointer: coarse)').matches,
    maxTouch: navigator.maxTouchPoints,
    side: box('.art-side'),
    stage: box('.art-stage'),
    anno: box('.art-anno'),
    annoOpen: anno ? anno.classList.contains('open') : false,
    annoToggleShown: (() => { const b = document.querySelector('#btnAnnoToggle');
                               return b ? getComputedStyle(b).display !== 'none' : false; })(),
    topbarOverflow: tb ? tb.scrollWidth - tb.clientWidth : 0,
    hOverflow: de.scrollWidth - de.clientWidth,
    shellH: (() => { const s = document.querySelector('.art-shell');
                     return s ? Math.round(s.getBoundingClientRect().height) : 0; })(),
    bodyClass: body ? body.className : '',
  });
})()
"""


class Page:
    """一个标签页，支持反复切尺寸 —— 用来做「原地转屏」。"""

    def __init__(self, cdp, sid):
        self.cdp = cdp
        self.sid = sid

    async def set_viewport(self, w, h, touch):
        await self.cdp.call("Emulation.setDeviceMetricsOverride", session=self.sid, params={
            "width": w, "height": h, "deviceScaleFactor": 2 if touch else 1,
            "mobile": touch,
            "screenWidth": w, "screenHeight": h,
            "screenOrientation": {"type": "portraitPrimary" if h >= w else "landscapePrimary",
                                  "angle": 0}})
        # mobile:true 本身就会把主指针变成 coarse；这条只是额外的触摸事件开关。
        # Emulation 是页级域，必须带 session —— 不带会报 "wasn't found"。
        try:
            await self.cdp.call("Emulation.setTouchEmulationEnabled",
                                {"enabled": touch, "maxTouchPoints": 5}, session=self.sid)
        except Exception as exc:
            print(f"  ! setTouchEmulationEnabled 失败: {exc}")
        await asyncio.sleep(0.45)     # 让 resize / matchMedia 的监听先跑完

    async def eval(self, expr):
        r = await self.cdp.call("Runtime.evaluate",
                                {"expression": expr, "returnByValue": True,
                                 "awaitPromise": True}, session=self.sid)
        raw = (r.get("result") or {}).get("value")
        try:
            return json.loads(raw)
        except Exception:
            return raw

    async def shot(self, path):
        import base64
        r = await self.cdp.call("Page.captureScreenshot", {"format": "png"},
                                session=self.sid, timeout=30)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(r.get("data") or ""))


async def open_page(ws_url):
    from websockets.asyncio.client import connect
    ws = await connect(ws_url, max_size=64 * 1024 * 1024, open_timeout=10)
    cdp = _Cdp(ws)
    tid = (await cdp.call("Target.createTarget", {"url": "about:blank"})).get("targetId", "")
    sid = (await cdp.call("Target.attachToTarget", {"targetId": tid, "flatten": True})).get("sessionId")
    await cdp.call("Page.enable", session=sid)
    await cdp.call("Runtime.enable", session=sid)
    return cdp, tid, Page(cdp, sid)


async def close_page(cdp, tid):
    if cdp is None:
        return
    try:
        if tid:
            await cdp.call("Target.closeTarget", {"targetId": tid}, timeout=5)
    except Exception:
        pass
    await cdp.aclose()


def skeleton(d):
    """布局骨架签名：几列 + 左栏形态 + 标注栏形态。"""
    side = d.get("side") or {}
    return (f"{d.get('colCount')}列",
            "盖层" if side.get("pos") == "fixed" else "栅格列",
            "抽屉" if (d.get("anno") or {}).get("pos") == "fixed" else "常驻列")


async def load(cdp, page):
    # 先复位触摸状态：触摸模拟是浏览器级的，上一轮跑到手机档位之后会留下
    # 「any-pointer:coarse」的残影，让这一轮的桌面档位被当成平板量。
    try:
        await cdp.call("Emulation.setTouchEmulationEnabled",
                       {"enabled": False, "maxTouchPoints": 1}, session=page.sid)
    except Exception:
        pass
    await cdp.call("Emulation.setDeviceMetricsOverride", session=page.sid, params={
        "width": 1920, "height": 1080, "deviceScaleFactor": 1, "mobile": False})
    await asyncio.sleep(0.2)
    await cdp.call("Page.navigate", {"url": URL}, session=page.sid, timeout=NAV_TIMEOUT)
    try:
        await cdp.wait_event("Page.loadEventFired", NAV_TIMEOUT)
    except Exception:
        pass
    await asyncio.sleep(0.5)


async def main() -> int:
    ws_url = await ensure_browser()
    if not ws_url:
        print("拉不起 Chrome，放弃")
        return 1

    rows = []
    cdp = tid = None
    only = os.environ.get("ARTIFACTS_ONLY", "")     # 只跑名字里含该关键词的档位
    profiles = [p for p in PROFILES if not only or only in p[0]]
    try:
        cdp, tid, page = await open_page(ws_url)
        await load(cdp, page)
        for name, w, h, touch in profiles:
            await page.set_viewport(w, h, touch)
            d = await page.eval(MEASURE_JS)
            d["name"] = name
            if SHOTS:
                p = os.path.join(SHOT_DIR, f"{'T' if touch else 'M'}{w}x{h}.png")
                await page.shot(p)
                d["shot"] = p
            rows.append(d)
    finally:
        await close_page(cdp, tid)

    print(f"{'设备':<26}{'触摸':<9}{'列宽定义':<28}{'左栏':<7}{'标注栏':<7}"
          f"{'舞台高':>7}{'顶栏溢':>7}{'横溢':>6}  备注")
    print("-" * 122)
    for d in rows:
        if "error" in d:
            print(f"{d['name']:<26}{d['error']}")
            continue
        colcount, side_f, anno_f = skeleton(d)
        notes = []
        if not d.get("annoToggleShown"):
            notes.append("◨隐藏")
        if d.get("topbarOverflow", 0) > 0 or d.get("hOverflow", 0) > 0:
            notes.append("溢出!")
        touch_f = f"{'coarse' if d.get('ptrCoarse') else 'fine'}·any={int(bool(d.get('coarse')))}·{d.get('maxTouch', 0)}点"
        print(f"{d['name']:<26}{touch_f:<9}{d['cols']:<28}"
              f"{side_f:<7}{anno_f:<7}{(d.get('stage') or {}).get('h', 0):>7}"
              f"{d.get('topbarOverflow', 0):>7}{d.get('hOverflow', 0):>6}  {' '.join(notes)}")

    # ---------------- 平板转屏一致性：同一标签页原地转屏 ----------------
    print("\n转屏一致性（同一标签页原地转屏，比较骨架 + 抽屉状态）：")
    cdp = tid = None
    try:
        cdp, tid, page = await open_page(ws_url)
        await load(cdp, page)
        for dev, pw, ph, lw, lh in ROTATE_GROUPS:
            await page.set_viewport(pw, ph, True)
            a = await page.eval(MEASURE_JS)
            await page.eval("(() => {const h=document.querySelector('.art-anno-head');"
                            "if(h) h.click(); return 1;})()")
            a_open = await page.eval(
                "!!document.querySelector('.art-anno').classList.contains('open')")
            await page.set_viewport(lw, lh, True)
            b = await page.eval(MEASURE_JS)
            b_open = await page.eval(
                "!!document.querySelector('.art-anno').classList.contains('open')")
            sa, sb = skeleton(a), skeleton(b)
            mark = "✅ 骨架一致" if sa == sb else "❌ 骨架变了 " + str(sa) + " -> " + str(sb)
            print(f"  {dev:<10} 竖 {pw}x{ph}: {'/'.join(sa)} 抽屉开={a_open}"
                  f"  →  横 {lw}x{lh}: {'/'.join(sb)} 抽屉开={b_open}   {mark}")
            if sa == sb and a_open != b_open:
                print(f"  {dev:<10} ⚠ 抽屉开关状态在转屏后丢失（{a_open} → {b_open}）")
    finally:
        await close_page(cdp, tid)

    if SHOTS:
        print(f"\n截图目录 = {SHOT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))