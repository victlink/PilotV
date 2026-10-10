#!/usr/bin/env python3
"""CDP 客户端：真机截图 + 标注重新锚定。

为什么需要它（成果台最核心的技术点）：
    页面类成果返工后版式会变，但标注意图不变。
    只存归一化 rect 的话，改版后标注就飘了 —— 闭环断在最后一步。
    所以锚点双存（rect + selector），DOM 还在时用 selector 重新量一次。

两个入口：
    screenshot(url, artifact_id)        -> PNG 路径（列表缩略图）
    resolve_rects(url, selectors)       -> {selector: 归一化 rect}

约定：
    * 浏览器复用优先：已有 CDP 端口就连上，没有才自己拉一个 headless Chrome。
    * 任何异常都吞掉返回 None —— 截图/锚定属于「锦上添花」，
      不能让物化队列卡住（降级成占位图 + 旧 rect 照样能评审）。
"""
from __future__ import annotations

import asyncio
import base64
import glob
import json
import os
import time
import urllib.request

try:                                    # aiohttp 已在项目里，优先用它探端口
    from aiohttp import ClientSession, ClientTimeout
except Exception:                       # pragma: no cover
    ClientSession = None

DATA_DIR = os.environ.get(
    "ARTIFACTS_DATA_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".artifacts-data"),
)
CDP_PORT = int(os.environ.get("ARTIFACTS_CDP_PORT", "9222"))
VIEWPORT = (int(os.environ.get("ARTIFACTS_VIEW_W", "1280")),
            int(os.environ.get("ARTIFACTS_VIEW_H", "800")))
NAV_TIMEOUT = float(os.environ.get("ARTIFACTS_CDP_NAV_TIMEOUT", "20"))

# 找 Chrome 的顺序：playwright 缓存 → 系统安装
_CHROME_GLOBS = (
    "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome",
    "~/.cache/ms-playwright/chromium-*/chrome-linux/chrome",
    "~/.cache/ms-playwright/chrome-*/chrome-linux64/chrome",
)


# --------------------------------------------------------------------- 浏览器


def _browser_ws(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as resp:
        return json.load(resp)["webSocketDebuggerUrl"]


def _chrome_binary() -> str:
    for pat in _CHROME_GLOBS:
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        if hits:
            return hits[-1]
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        for d in os.environ.get("PATH", "").split(os.pathsep):
            cand = os.path.join(d, name)
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                return cand
    return ""


_proc = None


async def ensure_browser(port: int = CDP_PORT):
    """返回 browser 级 ws url；端口不通就自己拉一个 headless Chrome。"""
    global _proc
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, lambda: _browser_ws(port))
    except Exception:
        pass
    binary = _chrome_binary()
    if not binary:
        return ""
    profile = os.path.join(DATA_DIR, f"chrome-profile-{port}")
    os.makedirs(profile, exist_ok=True)
    # profile 必须按端口分目录。共用一个目录时：跑测试（9333）会撞上还在跑的
    # 那个浏览器（9334），两个 Chromium 抢同一个 profile 的 SingletonLock，
    # 后启动的那个直接 Aborting，整条渲染回归红成「浏览器起不来」——
    # 看着像渲染坏了，其实是测试自己打架。
    # 走到这里说明该端口上没有人在听（上面的 _browser_ws 刚探过），
    # 所以这个 profile 里的锁只可能是上次异常退出留下的残留，清掉安全。
    for junk in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        try:
            os.unlink(os.path.join(profile, junk))
        except OSError:
            pass
    _proc = await asyncio.create_subprocess_exec(
        binary,
        "--headless=new",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
        "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-extensions",
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    loop = asyncio.get_running_loop()
    for _ in range(100):                # 冷启动给到 15 秒，别赌机器速度
        await asyncio.sleep(0.15)
        if _proc.returncode is not None:
            return ""                   # 进程自己退了（端口占用/profile 锁等）
        try:
            return await loop.run_in_executor(None, lambda: _browser_ws(port))
        except Exception:
            continue
    try:                               # 起不来就别留着僵尸进程
        _proc.terminate()
    except Exception:
        pass
    _proc = None
    return ""


async def stop_browser():
    global _proc
    if _proc and _proc.returncode is None:
        try:
            _proc.terminate()
            await asyncio.wait_for(_proc.wait(), 5)
        except Exception:
            pass
    _proc = None


# --------------------------------------------------------------------- 会话


def _counter_gen():
    n = 0
    while True:
        n += 1
        yield n


_counter = _counter_gen()


class _Cdp:
    """极简 CDP 客户端：一个后台读循环 + 按 id 分发。

    不引第三方 CDP 库：协议就三件事（发方法、等响应、等事件），
    自己写反而没有版本兼容包袱。
    """

    def __init__(self, ws):
        self.ws = ws
        self._pending: dict[int, asyncio.Future] = {}
        self._waiters: list[tuple[str, asyncio.Future]] = []
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        try:
            async for raw in self.ws:
                try:
                    data = json.loads(raw)
                except Exception:
                    continue
                mid = data.get("id")
                if mid is not None:
                    fut = self._pending.pop(mid, None)
                    if fut is not None and not fut.done():
                        if "error" in data:
                            fut.set_exception(RuntimeError(f"CDP error: {data['error']}"))
                        else:
                            fut.set_result(data.get("result") or {})
                    continue
                method = data.get("method") or ""
                for name, fut in list(self._waiters):
                    if fut.done():
                        self._waiters.remove((name, fut))
                    elif method == name:
                        fut.set_result(data.get("params") or {})
        except Exception:
            pass

    async def call(self, method, params=None, *, session=None, timeout=30):
        msg_id = next(_counter)
        fut = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        msg = {"id": msg_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        await self.ws.send(json.dumps(msg))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    async def wait_event(self, method, timeout):
        fut = asyncio.get_running_loop().create_future()
        self._waiters.append((method, fut))
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            if (method, fut) in self._waiters:
                self._waiters.remove((method, fut))

    async def aclose(self):
        self._reader.cancel()
        try:
            await self.ws.close()
        except Exception:
            pass


async def _with_page(url, fn, *, viewport=VIEWPORT):
    """开一个标签页跑 fn(cdp, session_id)，跑完必关 —— 标签页漏关会拖垮浏览器。"""
    from websockets.asyncio.client import connect

    ws_url = await ensure_browser()
    if not ws_url:
        return None
    cdp = None
    target_id = ""
    try:
        ws = await connect(ws_url, max_size=64 * 1024 * 1024, open_timeout=10)
        cdp = _Cdp(ws)
        target_id = (await cdp.call("Target.createTarget", {"url": "about:blank"})).get("targetId", "")
        sid = (await cdp.call("Target.attachToTarget",
                               {"targetId": target_id, "flatten": True})).get("sessionId")
        await cdp.call("Page.enable", session=sid)
        await cdp.call("Runtime.enable", session=sid)
        await cdp.call("Emulation.setDeviceMetricsOverride", session=sid, params={
            "width": viewport[0], "height": viewport[1],
            "deviceScaleFactor": 1, "mobile": False})
        await cdp.call("Page.navigate", {"url": url}, session=sid, timeout=NAV_TIMEOUT)
        await cdp.wait_event("Page.loadEventFired", NAV_TIMEOUT)   # 超时不算失败
        await asyncio.sleep(0.3)          # 给首屏渲染一点时间再量
        return await fn(cdp, sid)
    except Exception:
        return None
    finally:
        if cdp is not None:
            if target_id:
                try:
                    await cdp.call("Target.closeTarget", {"targetId": target_id}, timeout=5)
                except Exception:
                    pass
            await cdp.aclose()


_JS_MEASURE = r"""
(() => {
  const out = {};
  const de = document.documentElement;
  const vw = Math.max(1, de.clientWidth || window.innerWidth || 1);
  const vh = Math.max(1, de.clientHeight || window.innerHeight || 1);
  const full = {w: de.scrollWidth || vw, h: de.scrollHeight || vh};
  for (const sel of window.__ARTIFACT_SELECTORS__ || []) {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (!el) continue;
    el.scrollIntoView({block: 'center', inline: 'nearest'});
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) continue;
    out[sel] = {
      // 归一化到整页坐标：标注是给「整页」用的，翻滚不影响命中
      x: Math.max(0, Math.min(1, (r.left + window.scrollX) / full.w)),
      y: Math.max(0, Math.min(1, (r.top + window.scrollY) / full.h)),
      w: Math.max(0, Math.min(1, r.width / full.w)),
      h: Math.max(0, Math.min(1, r.height / full.h)),
      text: (el.textContent || '').trim().slice(0, 60),
    };
  }
  out.__full__ = full;
  return JSON.stringify(out);
})()
"""


# --------------------------------------------------------------------- 对外接口


async def run_script(url: str, script: str, *, wait_js: str = "",
                     wait_timeout: int = 20, screenshot_path: str = "",
                     viewport=VIEWPORT) -> dict:
    """打开页面跑一段 JS，把返回值拿回来（可选等条件成立、可选截图）。

    验收前端「点了会怎样」时用这个：断言写在 Python 里，页面里只负责点一下。
    不用第三方 CDP 库，自己拼 Runtime.evaluate 就够。
    """
    import base64

    async def fn(cdp, sid):
        if wait_js:
            t0 = asyncio.get_running_loop().time()
            while asyncio.get_running_loop().time() - t0 < wait_timeout:
                probe = await cdp.call("Runtime.evaluate",
                                      {"expression": f"!!({wait_js})", "returnByValue": True},
                                      session=sid)
                if (probe.get("result") or {}).get("value"):
                    break
                await asyncio.sleep(0.25)
        res = await cdp.call("Runtime.evaluate",
                             {"expression": script, "awaitPromise": True,
                              "returnByValue": True}, session=sid)
        value = (res.get("result") or {}).get("value")
        if screenshot_path:
            shot = await cdp.call("Page.captureScreenshot", {"format": "png"},
                                  session=sid, timeout=30)
            os.makedirs(os.path.dirname(os.path.abspath(screenshot_path)) or ".", exist_ok=True)
            with open(screenshot_path, "wb") as fh:
                fh.write(base64.b64decode(shot.get("data") or ""))
        return {"value": value, "screenshot": screenshot_path if screenshot_path else ""}

    return await _with_page(url, fn, viewport=viewport) or {}


async def resolve_rects(url: str, selectors, *, viewport=VIEWPORT):
    """重新量一组 selector 的归一化 rect。

    返回 (rects, page_ok)：
        rects 里没有的 selector = 元素真没了；
        page_ok=False = 页面压根没打开（别把这两种混为一谈，
        否则服务器没起就会把一批标注误判成"元素已删除"）。
    """
    sels = [s for s in dict.fromkeys(selectors or []) if s]
    if not sels or not url:
        return {}, False

    async def run(cdp, sid):
        lit = json.dumps(sels, ensure_ascii=False)
        expr = f"window.__ARTIFACT_SELECTORS__ = {lit};\n{_JS_MEASURE}"
        res = await cdp.call("Runtime.evaluate", session=sid, params={
            "expression": expr, "returnByValue": True, "awaitPromise": False})
        raw = (res.get("result") or {}).get("value")
        data = json.loads(raw) if raw else {}
        full = data.get("__full__") or {}
        ok = bool(full.get("w") and full.get("h"))
        rects = {k: v for k, v in data.items() if k != "__full__" and isinstance(v, dict)}
        return (rects, ok)

    got = await _with_page(url, run, viewport=viewport)
    return got if got else ({}, False)


async def screenshot(url: str, artifact_id: str, *, viewport=VIEWPORT) -> str:
    """整页截图存 PNG，返回路径；失败返回空串（调用方落占位图）。"""
    if not url:
        return ""

    async def run(cdp, sid):
        res = await cdp.call("Page.captureScreenshot", session=sid,
                             params={"format": "png", "captureBeyondViewport": False})
        return (res.get("data") or "")

    data_b64 = await _with_page(url, run, viewport=viewport)
    if not data_b64:
        return ""
    out_dir = os.path.join(DATA_DIR, "shots")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{artifact_id}.png")
    try:
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(data_b64))
    except Exception:
        return ""
    return path


# 掐掉自测时的 __main__ 噪音：python3 artifacts_cdp.py 只做一次冒烟
if __name__ == "__main__":               # pragma: no cover
    import sys
    url = sys.argv[1] if len(sys.argv) > 1 else "about:blank"
    t0 = time.time()
    rects, ok = asyncio.run(resolve_rects(url, ["body", "h1"]))
    print("page_ok:", ok)
    print("rects:", json.dumps(rects, ensure_ascii=False)[:300])
    print("耗时 %.1fs" % (time.time() - t0))
