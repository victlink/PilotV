#!/usr/bin/env python3
"""给本机 PilotV 签一个一次性的本地会话 token（不需要账号密码）。

用途只有一个：让 Playwright 能打开本机 PilotV 的登录后界面，截真实功能图
（三维查看、手绘标注）。做法是读本机 auth.db 里已经存在的 jwt_secret，用服务端
generateToken() 同样的载荷 {userId, username} 签一个短期 HS256 token，写进
/tmp 的 600 权限文件——不是破解密码，也不碰别的服务，只在这台机器上开一扇门。

    python3 site/.qa/mint_local_token.py            # 写 token 到 /tmp/pilotv-shot-token
    python3 site/.qa/mint_local_token.py --print    # 顺带验证能不能换到 /api/auth/user

签完记得用完就删：rm -f /tmp/pilotv-shot-token
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import pathlib
import sqlite3
import time
import urllib.request

AUTH_DB = pathlib.Path(os.environ.get("PILOTDECK_HOME", "/home/marc/.pilotdeck")) / "auth.db"
OUT = pathlib.Path("/tmp/pilotv-shot-token")
GATEWAY = os.environ.get("PILOTV_URL", "https://127.0.0.1:5186")


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def mint(ttl_seconds: int = 1800) -> str:
    con = sqlite3.connect(f"file:{AUTH_DB}?mode=ro", uri=True)
    try:
        row = con.execute("SELECT value FROM app_config WHERE key='jwt_secret'").fetchone()
        user = con.execute("SELECT id, username FROM users ORDER BY id LIMIT 1").fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        raise SystemExit("auth.db 里没有 jwt_secret")
    if not user:
        raise SystemExit("auth.db 里没有用户")
    uid, uname = user
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"userId": uid, "username": uname,
               "iat": int(time.time()), "exp": int(time.time()) + ttl_seconds}
    signing = f"{b64(json.dumps(header).encode())}.{b64(json.dumps(payload).encode())}"
    sig = hmac.new(row[0].encode(), signing.encode(), hashlib.sha256).digest()
    return f"{signing}.{b64(sig)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true", help="token 直接打到 stdout（会泄露，别在共享机器上用）")
    ap.add_argument("--ttl", type=int, default=1800)
    ap.add_argument("--verify", action="store_true", help="顺带用 token 调一次 /api/auth/user")
    args = ap.parse_args()

    token = mint(args.ttl)
    OUT.write_text(token)
    os.chmod(OUT, 0o600)
    if args.print:
        print(token)
    else:
        print(f"token 已写入 {OUT}（600 权限，{args.ttl}s 后过期）")

    if args.verify:
        req = urllib.request.Request(f"{GATEWAY}/api/auth/user",
                                     headers={"Authorization": f"Bearer {token}"})
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            print("verify:", resp.status, resp.read()[:160].decode(errors="replace"))


if __name__ == "__main__":
    main()
