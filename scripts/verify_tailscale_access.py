#!/usr/bin/env python3
"""从 Tailscale 地址当一次「远端客户端」：验成果台是不是真能用。

验四件事（都要过才算能用）：
  1. 匿名访问：页面能打开（空壳 + 登录框），但 API 一律 401 —— 页面公开不等于数据公开
  2. 登录能拿到 Cookie，用它能打开成果台页面并拿到成果
  3. Bearer token 能直接调 API（给外部 agent 用，不用 Cookie）
  4. 成果台自己的运维接口在（notify / health），说明挂载的是最新代码
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = []


def check(ok, name, detail=""):
    RESULTS.append((bool(ok), name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    return bool(ok)


def code(url, headers=None, method="GET", data=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)
    except Exception as e:
        return 0, str(e).encode(), {}


def secret(name, default=""):
    """从 .artifacts-secrets.env 读值（不打印值本身）。"""
    path = os.path.join(ROOT, ".artifacts-secrets.env")
    if not os.path.isfile(path):
        return default
    for line in open(path, encoding="utf-8"):
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    return default


def main():
    # verify_tailscale_access 只读探测访问面，不发布成果，无需护栏。
    ts = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True).stdout.split()
    if not ts:
        print("  [SKIP] 没有 tailscale 地址")
        return 0
    base = f"http://{ts[0]}:8799"
    print(f"\n[以远端身份访问 {base}]", flush=True)

    st, body, _ = code(f"{base}/artifacts.html")
    check(st == 200 and b'id="artGate"' in body,
          "匿名能打开页面（空壳 + 登录框）", f"HTTP {st} {len(body)}B")
    check(st != 401, "匿名不再只看到 JSON unauthorized",
          "" if st != 401 else "页面仍被 console 鉴权挡在门外")

    st, _, _ = code(f"{base}/api/artifacts?limit=1")
    check(st == 401, "匿名调 API 被挡住（页面公开不等于数据公开）", f"HTTP {st}")

    user, pw = "artifacts", secret("ARTIFACTS_CONSOLE_PASSWORD")
    st, body, hdrs = code(f"{base}/api/login", method="POST",
                          headers={"Content-Type": "application/json"},
                          data=json.dumps({"username": user, "password": pw}).encode())
    if st != 200:
        # 先说清是不是「口令已在页面上改过」，否则这条 FAIL 会被误读成成果台挂了
        print("提示：登录没成功。若刚在 ⚙ 面板改过登录口令，"
              ".artifacts-secrets.env 里的值已过期，"
              "请把新口令写回该文件（细节见 RUNBOOK §0.3）。")
    check(st == 200, "登录成功", f"HTTP {st} {body[:40]!r}")
    cookie = (hdrs.get("Set-Cookie") or hdrs.get("set-cookie") or "").split(";")[0]
    check(bool(cookie), "拿到登录 Cookie", f"{cookie.split('=')[0]}=…")
    if not cookie:
        return 1

    st, body, _ = code(f"{base}/artifacts.html", headers={"Cookie": cookie})
    check(st == 200 and b"<" in body[:200], "带 Cookie 能打开成果台页面", f"HTTP {st} {len(body)}B")

    st, body, _ = code(f"{base}/api/artifacts?limit=3", headers={"Cookie": cookie})
    try:
        items = json.loads(body).get("artifacts", [])
    except Exception:
        items = []
    check(st == 200 and isinstance(items, list), "带 Cookie 能读成果列表", f"HTTP {st} 共 {len(items)} 条")

    token = secret("ARTIFACTS_TOKEN")
    st, body, _ = code(f"{base}/api/artifacts?limit=3",
                       headers={"Authorization": f"Bearer {token}"})
    try:
        items2 = json.loads(body).get("artifacts", [])
    except Exception:
        items2 = []
    check(st == 200 and isinstance(items2, list), "Bearer token 能读成果列表（给外部 agent）",
          f"HTTP {st} 共 {len(items2)} 条")

    st, body, _ = code(f"{base}/api/artifacts/health", headers={"Cookie": cookie})
    check(st == 200 and json.loads(body).get("ok") is True, "health 正常",
          f"HTTP {st} 卡片 {json.loads(body).get('stats', {}).get('total', '?')} 张")

    st, body, _ = code(f"{base}/api/artifacts/notify", headers={"Cookie": cookie})
    try:
        nt = json.loads(body)
    except Exception:
        nt = {}
    check(st == 200 and "enabled" in nt, "notify 接口在（说明跑的是最新代码）",
          f"HTTP {st} enabled={nt.get('enabled')}")

    passed = sum(1 for ok, _, _ in RESULTS if ok)
    print("\n" + "=" * 56)
    print(f"结果：{passed} 通过 / {len(RESULTS) - passed} 失败（共 {len(RESULTS)} 项）")
    if passed != len(RESULTS):
        for ok, name, detail in RESULTS:
            if not ok:
                print(f"  ✗ {name} — {detail}")
        return 1
    print("Tailscale 上真能用 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
