#!/usr/bin/env python3
"""登录拿到 token，然后把前端启动时会调用的每个接口都打一遍，
看哪一个返回 401 —— 那一个就是把用户弹回登录页的元凶。

用法: python3 scripts/probe_post_login.py [网关地址]
"""
import json
import subprocess
import sys

GATEWAY = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5186"
DIRECT = "http://127.0.0.1:3001"

# 前端登录后/启动时真正会调的接口（见 src/utils/api.js）
PATHS = [
    ("GET", "/api/auth/status", False),
    ("GET", "/api/auth/user", True),
    ("GET", "/api/user/onboarding-status", True),
    ("GET", "/api/user/runtime-status", True),
    ("GET", "/api/user/git-config", True),
    ("GET", "/api/config", True),
]


def curl(args):
    out = subprocess.run(
        ["curl", "-s", "--max-time", "8", *args],
        capture_output=True, text=True,
    )
    return out.stdout


def login(base):
    body = json.dumps({"username": "Marc", "password": "qwertyuiop"})
    raw = curl(["-X", "POST", f"{base}/api/auth/login",
                "-H", "Content-Type: application/json", "-d", body])
    try:
        return json.loads(raw).get("token", "")
    except Exception:  # noqa: BLE001
        return ""


for label, base in (("直连 3001", DIRECT), (f"网关 {GATEWAY}", GATEWAY)):
    token = login(base)
    print(f"\n=== {label} ===")
    print(f"  登录: {'拿到 token' if token else '失败!'}")
    if not token:
        continue
    for method, path, needs_auth in PATHS:
        args = ["-X", method, f"{base}{path}", "-w", "\n%{http_code}"]
        if needs_auth:
            args += ["-H", f"Authorization: Bearer {token}"]
        raw = curl(args)
        body, _, code = raw.rpartition("\n")
        flag = "  <-- 401！" if code == "401" else ""
        print(f"  {code}  {path}{flag}")
        if code == "401":
            print(f"       body: {body[:160]}")
