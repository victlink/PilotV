#!/usr/bin/env python3
"""M4-IM：验证成果台事件能推到 IM webhook，且推送永不影响成果台本身。

用本地一个假 webhook 服务当 IM：收到什么、什么时候收到，全部记账。
覆盖：
  1. artifact.added / status / dispatched 三类事件都能推
  2. 文案带 agent、标题、状态、链接
  3. agents 白名单能过滤掉噪音
  4. webhook 挂掉时：发布照样成功，只在 status 里记 failed
  5. 不配 webhook 时完全零行为（默认关）
  6. 事件回调不阻塞发布请求（耗时 < 阈值）
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import json
import os
import socket
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

RESULTS = []


def check(ok, name, detail=""):
    RESULTS.append((bool(ok), name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""),
          flush=True)
    return bool(ok)


class Sink:
    """假 IM 机器人。"""

    def __init__(self, respond=None):
        self.msgs: list[dict] = []
        self.respond = respond or (lambda: (200, {"code": 0}))
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                try:
                    outer.msgs.append({"payload": json.loads(raw.decode("utf-8")),
                                       "query": self.path.split("?")[1] if "?" in self.path else ""})
                except Exception:
                    outer.msgs.append({"payload": {"_raw": raw.decode("utf-8", "replace")},
                                       "query": ""})
                code, body = outer.respond()
                out = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *a):
                pass

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}/hook"
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()

    def wait(self, n=1, timeout=6.0):
        end = time.time() + timeout
        while time.time() < end and len(self.msgs) < n:
            time.sleep(0.05)
        return len(self.msgs) >= n


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _serve(app, port: int):
    """在后台线程里跑一个 aiohttp 应用（复用 scripts/serve_test.py 的装配）。"""
    import asyncio
    from aiohttp import web

    async def _run():
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", port)
        await site.start()
        while True:
            await asyncio.sleep(3600)

    asyncio.run(_run())


def wait_http(url, timeout=25.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                return r.status == 200
        except Exception:
            time.sleep(0.2)
    return False


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def get(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode())


def main():
    # verify_notify 自己起临时端口的服务，不连正式成果台，无需护栏。
    os.environ["ARTIFACTS_DATA_DIR"] = os.environ.get("VERIFY_NOTIFY_DATA") or \
        os.environ.get("ARTIFACTS_DATA_DIR") or "/tmp/verify-notify-data"
    os.makedirs(os.environ["ARTIFACTS_DATA_DIR"], exist_ok=True)
    data_dir = os.environ["ARTIFACTS_DATA_DIR"]
    sink = Sink().start()

    print("\n[1] 三类事件都能推，文案对", flush=True)
    os.environ["ARTIFACTS_NOTIFY_WEBHOOK"] = sink.url
    os.environ["ARTIFACTS_NOTIFY_BASE_URL"] = "http://console.example:8899"
    os.environ["ARTIFACTS_NOTIFY_EVENTS"] = "artifact.added,artifact.status,artifact.dispatched"
    os.environ.pop("ARTIFACTS_NOTIFY_AGENTS", None)

    import artifacts_notify
    import artifacts_store
    store = artifacts_store.ArtifactStore(data_dir)
    nt = artifacts_notify.Notifier().start()
    store.bus.add_listener(nt.on_event)

    art = store.create({"agent": "opencode", "kind": "page", "title": "登录页落地",
                        "note": "第一版"})
    check(sink.wait(1), "artifact.added 有推送", f"收到 {len(sink.msgs)} 条")
    if sink.msgs:
        text = sink.msgs[0]["payload"].get("content", {}).get("text", "")
        check(sink.msgs[0]["payload"].get("msg_type") == "text", "飞书 text 消息格式")
        check("opencode" in text and "登录页落地" in text, "文案带 agent 与标题", text.split("\n")[0])
        check(f"http://console.example:8899/artifacts.html#{art['id']}" in text,
              "文案带可点链接", text.split("\n")[-1])

    store.set_status(art["id"], "ready")
    store.set_status(art["id"], "reviewing")
    store.set_status(art["id"], "approved")
    check(sink.wait(4), "状态变更也推", f"收到 {len(sink.msgs)} 条")
    texts = [m["payload"].get("content", {}).get("text", "") for m in sink.msgs]
    check(any("已通过" in t for t in texts), "状态文案可读", next(t for t in texts if "→" in t).split("\n")[0])

    # Sink.wait(n) 的语义是「等累计条数到 n」，而 msgs 是**累积**的。
    # 前面 4 条早就到了，这里再 wait(4) 会立刻返回 —— 根本没等 dispatch 那条，
    # 断言就成了「碰运气有没有赶上」。要等的是**新增**一条，所以记下当前条数再 +1。
    before = len(sink.msgs)
    store.dispatch(art["id"], actor="me", note="按钮对比度不够")
    check(sink.wait(before + 1), "返工派发也推",
          f"收到 {len(sink.msgs)} 条（推前 {before}）")
    new_msgs = sink.msgs[before:]
    check(any("返工" in m["payload"].get("content", {}).get("text", "") for m in new_msgs),
          "返工文案正确",
          repr([m["payload"].get("content", {}).get("text", "")[:40] for m in new_msgs]))
    check(nt.status()["sent"] >= 4 and nt.status()["failed"] == 0,
          "status 记账准确", json.dumps(nt.status(), ensure_ascii=False)[:120])

    print("\n[2] 白名单过滤噪音", flush=True)
    nt.agents = {"claude"}                        # 只留 claude 的
    before = len(sink.msgs)
    store.create({"agent": "opencode", "kind": "page", "title": "噪音页"})
    store.create({"agent": "claude", "kind": "doc", "title": "留我"})
    check(sink.wait(before + 1, timeout=3), "非白名单被过滤", f"只推了 {len(sink.msgs) - before} 条")
    check(all("噪音页" not in m["payload"].get("content", {}).get("text", "") for m in sink.msgs),
          "噪音没发出去")
    nt.agents = set()

    print("\n[3] webhook 挂掉不影响成果台", flush=True)
    os.environ["ARTIFACTS_NOTIFY_WEBHOOK"] = "http://127.0.0.1:1/dead"
    nt.webhook = "http://127.0.0.1:1/dead"
    t0 = time.time()
    art2 = store.create({"agent": "opencode", "kind": "page", "title": "断网也要发得出去"})
    dt = time.time() - t0
    check(bool(art2.get("id")), "推送通道挂了，发布照样成功", f"{dt * 1000:.0f}ms")
    check(dt < 1.0, "推送没有阻塞请求", f"{dt * 1000:.0f}ms")
    deadline = time.time() + 8
    while time.time() < deadline and nt.status()["failed"] == 0:
        time.sleep(0.1)
    check(nt.status()["failed"] >= 1, "失败被记账而不是消失", nt.status()["last_error"])

    print("\n[4] 默认关：没有 webhook 就是零行为", flush=True)
    os.environ.pop("ARTIFACTS_NOTIFY_WEBHOOK", None)
    off = artifacts_notify.Notifier()
    before = len(sink.msgs)
    off.on_event("artifact.added", {"artifact": {"id": "x", "title": "不该出现"}})
    check(off.enabled is False and len(sink.msgs) == before, "不配就不推")

    print("\n[5] 业务错误码也算失败", flush=True)
    bad = Sink(respond=lambda: (200, {"code": 19021, "msg": "sign match fail"})).start()
    nt.webhook = bad.url
    ok = nt.send_now("x")
    check(ok is False, "HTTP 200 但业务报错 → 判失败", nt.status()["last_error"])
    bad.stop()

    print("\n[6] 真跑一遍 HTTP 服务", flush=True)
    os.environ["ARTIFACTS_NOTIFY_WEBHOOK"] = sink.url
    port = free_port()
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import serve_test
    thd = threading.Thread(target=_serve, args=(serve_test.build_app(), port), daemon=True)
    thd.start()
    base = f"http://127.0.0.1:{port}"
    ok = wait_http(f"{base}/api/artifacts/health")
    check(ok, "console 起来且 health 通")
    if ok:
        st = get(f"{base}/api/artifacts/notify")
        check(st.get("enabled") is True, "notify 状态接口报告已启用", json.dumps(st, ensure_ascii=False)[:110])
        t = post(f"{base}/api/artifacts/notify/test", {"text": "集成测试消息"})
        check(t.get("ok") is True, "测试消息能发出去")
        before = len(sink.msgs)
        created = post(f"{base}/api/artifacts", {"agent": "verify-notify", "kind": "page",
                                                  "title": "走 HTTP 进来的"})
        check(bool(created.get("id")), "HTTP 登记成功", json.dumps(created, ensure_ascii=False)[:80])
        check(sink.wait(before + 1), "真实发布触发推送")
        check(nt.status()["dropped"] == 0, "没有丢消息")

    sink.stop()

    passed = sum(1 for ok, _, _ in RESULTS if ok)
    print("\n" + "=" * 56)
    print(f"结果：{passed} 通过 / {len(RESULTS) - passed} 失败（共 {len(RESULTS)} 项）")
    if passed != len(RESULTS):
        print("\n失败项：")
        for ok, name, detail in RESULTS:
            if not ok:
                print(f"  ✗ {name} — {detail}")
        sys.exit(1)
    print("全部通过 ✓")


if __name__ == "__main__":
    # 必须把 main() 的返回值交给 SystemExit：护栏拒绝时 return 3，
    # 直接 main() 会把返回值丢掉、退出码恒为 0，回归脚本会以为这套「通过了」。
    raise SystemExit(main() or 0)
