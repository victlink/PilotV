#!/usr/bin/env python3
"""验「改登录口令」这条高危路径（隔离用户库，绝不碰生产的 artifacts 账号）。

要过的十项：
  1. 没有 Cookie 时：me / 改口令都 401
  2. 有 Cookie 但用 Bearer token 来改：403 —— 令牌和回环都不是「网页登录态」
  3. 旧口令错：403，且不写库
  4. 新口令太短 / 两次不一致 / 和旧的一样 / 和用户名一样：全 400
  5. 改成功：200
  6. 旧口令立刻登不上了
  7. 新口令能登上，拿到的是同一个账号
  8. 别的账号（admin）口令不受影响，仍能登录
  9. 改口令不把口令写进审计日志
 10. 改完当前 Cookie 仍然有效（会话不由口令签名，改口令≠踢人）
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONSOLE_DIR = "/vol3/1000/Work/PilotDeck/PilotCode"
TMP = "/tmp/artifacts-settings-test"
FAILS: list[str] = []


def check(ok, name, detail=""):
    if not ok:
        FAILS.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def call(base, path, method="GET", body=None, cookie=None, token=None, origin=None):
    req = urllib.request.Request(base + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    if cookie:
        req.add_header("Cookie", cookie)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            return r.status, json.loads(r.read().decode() or "{}"), r.headers
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}"), e.headers
        except json.JSONDecodeError:
            return e.code, {"raw": raw[:120]}, e.headers


def login(base, user, pw):
    st, data, hdrs = call(base, "/api/login", "POST", {"username": user, "password": pw})
    cookie = None
    for part in (hdrs.get("Set-Cookie") or "").split(","):
        if part.strip().startswith("pdc_console="):
            cookie = part.strip().split(";")[0]
    return st, data, cookie


def users_of(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    subprocess.run(["rm", "-rf", TMP], check=False)
    os.makedirs(TMP, exist_ok=True)
    users_path = os.path.join(TMP, "users.json")
    token = "test-token-" + secrets.token_hex(8)
    old_pw = "old-password-" + secrets.token_hex(4)
    new_pw = "new-password-" + secrets.token_hex(4)
    admin_pw = "admin-password-" + secrets.token_hex(4)

    # 造一个隔离用户库：两个账号，别的进程碰不到
    sys.path.insert(0, CONSOLE_DIR)
    import console_server as cs
    # 用户名要 ≥10 位，否则「新口令不能和用户名一样」那条规则永远排在
    # 「新口令至少 10 位」后面，永远走不到 —— 测试看着绿，其实没验到。
    me_user = "reviewer-longname"
    users = {me_user: cs.hash_password(old_pw), "admin": cs.hash_password(admin_pw)}
    with open(users_path, "w", encoding="utf-8") as fh:
        json.dump(users, fh)
    os.chmod(users_path, 0o600)

    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    env = dict(os.environ)
    env.update({
        "CONSOLE_USER_FILE": users_path,
        "CONSOLE_SESSION_SECRET": "test-secret-" + secrets.token_hex(8),
        "ARTIFACTS_TOKEN": token,
        "ARTIFACTS_DATA_DIR": os.path.join(TMP, "data"),
        "ARTIFACTS_MCP_URL": "",           # 侧车不参与这个测试
    })
    # console 的 normalize_devices 硬性要求至少一台设备、每台设备至少一个 app，
    # devices 留空直接 ConfigError 起步。塞一个指向成果台自己的空壳 web 条目。
    cfg = os.path.join(TMP, "console.yaml")
    with open(cfg, "w", encoding="utf-8") as fh:
        fh.write(
            "bind: [loopback]\n"
            f"port: {port}\n"
            "proxy_port_base: 3700\n"
            "devices:\n"
            "- id: artifacts\n"
            "  name: 成果台\n"
            "  network: direct\n"
            "  host: 127.0.0.1\n"
            "  apps:\n"
            "  - id: artifacts-page\n"
            "    kind: web\n"
            "    name: 成果台\n"
            f"    url: http://127.0.0.1:{port}/artifacts.html\n"
            "im:\n  enabled: false\n")

    proc = subprocess.Popen(
        [sys.executable, "console_server.py", "--config", cfg],
        cwd=CONSOLE_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(80):
            try:
                if call(base, "/health")[0] in (200, 401):
                    break
            except Exception:
                time.sleep(0.25)
        else:
            print("  [FAIL] 测试 console 没起来")
            print(proc.stdout.read(2000).decode(errors="replace"))
            return 1

        print("\n[1 没有 Cookie 就不许碰设置]")
        st, d, _ = call(base, "/api/artifacts/me")
        check(st == 401, "匿名查 me 被挡住", f"HTTP {st}")
        st, d, _ = call(base, "/api/artifacts/password", "POST",
                        {"old_password": old_pw, "new_password": new_pw,
                         "new_password_confirm": new_pw})
        check(st == 401, "匿名改口令被挡住", f"HTTP {st}")

        print("\n[2 Bearer 令牌不是网页登录态]")
        st, _, _ = call(base, "/api/artifacts/password", "POST",
                        {"old_password": old_pw, "new_password": new_pw,
                         "new_password_confirm": new_pw}, token=token)
        check(st in (401, 403), "拿 token 改口令被挡", f"HTTP {st}")
        st, d, _ = call(base, "/api/artifacts/me", token=token)
        check(st == 401, "拿 token 查 me 也被挡（面板不该给 agent 看）", f"HTTP {st}")
        st, _, _ = call(base, "/api/artifacts?limit=1", token=token)
        check(st == 200, "但 token 仍能正常登记/读取成果（没搞坏既有路径）", f"HTTP {st}")

        print("\n[3 正常登录，拿 Cookie]")
        st, d, cookie = login(base, me_user, old_pw)
        check(st == 200 and cookie, "旧口令登录成功", f"HTTP {st}")
        st, me, _ = call(base, "/api/artifacts/me", cookie=cookie)
        check(st == 200 and me.get("username") == me_user, "me 认出了当前账号",
              json.dumps(me, ensure_ascii=False)[:150])
        check("token" not in json.dumps(me).lower() or
              me.get("api_token_configured") is True,
              "me 不回显 token 明文（只报有没有配）")

        print("\n[4 各种非法输入都要挡]")
        cases = [
            ("旧口令不对", {"old_password": "wrong", "new_password": new_pw,
                        "new_password_confirm": new_pw}, 403),
            ("新口令太短", {"old_password": old_pw, "new_password": "abc123",
                        "new_password_confirm": "abc123"}, 400),
            ("两次输入不一致", {"old_password": old_pw, "new_password": new_pw,
                          "new_password_confirm": new_pw + "x"}, 400),
            ("和旧口令一样", {"old_password": old_pw, "new_password": old_pw,
                         "new_password_confirm": old_pw}, 400),
            ("和用户名一样", {"old_password": old_pw, "new_password": me_user,
                         "new_password_confirm": me_user}, 400),
        ]
        for name, body, want in cases:
            st, d, _ = call(base, "/api/artifacts/password", "POST", body, cookie=cookie)
            check(st == want, f"{name} 被挡", f"HTTP {st} {d.get('error', '')}")
            if name == "和用户名一样":
                check("用户名" in (d.get("error") or ""),
                      "用户名规则自己触发了（不是被长度规则蹭到的）", d.get("error", ""))
        check(users_of(users_path)[me_user]["hash"] == users[me_user]["hash"],
              "上面五轮下来用户库一个字节没动")

        print("\n[4b 跨站请求]");
        evil = {"old_password": old_pw, "new_password": new_pw,
                "new_password_confirm": new_pw}
        # Cookie 是 SameSite=Lax，浏览器跨站 POST 压根不会带上它；
        # 服务端这第二道 Origin 校验是给「属性哪天被放宽」或「同机另一个端口
        # 起了个恶意页面」兜底的。这里模拟那种「Cookie 真的被带上了」的最坏情况。
        st, d, _ = call(base, "/api/artifacts/password", "POST", evil,
                        cookie=cookie, origin="http://evil.example.com")
        check(st == 403, "带 Cookie 的跨站改口令被挡", f"HTTP {st} {d.get('error', '')}")
        st, d, _ = call(base, "/api/artifacts/password", "POST", evil,
                        cookie=cookie, origin=f"http://127.0.0.1:{port}")
        check(st == 200, "同源 Origin 不误伤（面板自己就是这么发请求的）",
              f"HTTP {st} {d.get('error', '')}")
        # 上面这条真的把口令改了，接着用它继续后面的阶段
        cookie, old_pw, new_pw = cookie, new_pw, "new-password-" + secrets.token_hex(4)
        st, _, cookie2 = login(base, me_user, old_pw)
        check(st == 200, "同源改密后新口令立刻能用", f"HTTP {st}")
        cookie = cookie2

        print("\n[5 改口令]")
        st, d, _ = call(base, "/api/artifacts/password", "POST",
                        {"old_password": old_pw, "new_password": new_pw,
                         "new_password_confirm": new_pw}, cookie=cookie)
        check(st == 200 and d.get("ok"), "改成功", f"HTTP {st} {d.get('error', '')}")
        after = users_of(users_path)[me_user]
        check(after["hash"] != users[me_user]["hash"], "库里的哈希真的换了")
        check("salt" in after and after["salt"] != users[me_user]["salt"], "换了新 salt")
        check(os.stat(users_path).st_mode & 0o777 == 0o600, "用户库权限仍是 0600")

        print("\n[6 新口令生效、旧口令失效]")
        st, _, _ = login(base, me_user, old_pw)
        check(st == 401, "旧口令登不上了", f"HTTP {st}")
        st, d2, cookie2 = login(base, me_user, new_pw)
        check(st == 200 and d2.get("username") == me_user, "新口令能登上", f"HTTP {st}")

        print("\n[7 不伤别人]")
        st, _, _ = login(base, "admin", admin_pw)
        check(st == 200, "admin 账号不受影响，仍能登录", f"HTTP {st}")
        check(users_of(users_path)["admin"] == users["admin"], "admin 的哈希没被动过")

        print("\n[8 审计与边界]")
        store_path = os.path.join(TMP, "data", "artifacts.db")
        if os.path.exists(store_path):
            import sqlite3
            con = sqlite3.connect(store_path)
            rows = con.execute(
                "SELECT event, actor, payload_json FROM audit WHERE event LIKE '%password%'"
            ).fetchall()
            con.close()
            check(bool(rows), "改口令留了审计事件",
                  "; ".join(f"{r[0]}/{r[1]}" for r in rows))
            blob = " ".join((r[2] or "") for r in rows)
            check(new_pw not in blob and old_pw not in blob, "审计里没有口令明文")
        else:
            check(False, "审计库不存在", store_path)
        st, me2, _ = call(base, "/api/artifacts/me", cookie=cookie)
        check(st == 200, "改完口令当前 Cookie 仍有效（改口令≠踢人，UI 里要说清）",
              f"HTTP {st}")

        print("\n[9 重启后口令还在不在 —— 文档承诺了，就得真验]")
        # 这是用户最容易被坑的一点：页面上改完口令，以为重启 console 又被
        # 启动脚本里那个「初值」覆盖回去，于是不敢改。
        # 真正要证的是：重启读的是用户库里那个新哈希，不是别的什么地方的值。
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        proc2 = subprocess.Popen(
            [sys.executable, "console_server.py", "--config", cfg],
            cwd=CONSOLE_DIR, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            for _ in range(80):
                try:
                    if call(base, "/health")[0] in (200, 401):
                        break
                except Exception:
                    time.sleep(0.25)
            st, _, _ = login(base, me_user, old_pw)
            check(st == 401, "重启后旧口令依然登不上（没被启动初值覆盖回去）", f"HTTP {st}")
            st, d3, cookie3 = login(base, me_user, new_pw)
            check(st == 200 and d3.get("username") == me_user,
                  "重启后新口令依然能登录（页面改的真的落库了）", f"HTTP {st}")
            st, me3, _ = call(base, "/api/artifacts/me", cookie=cookie3)
            check(st == 200 and me3.get("username") == me_user, "重启后设置面板照常可用")
        finally:
            proc2.terminate()
            try:
                proc2.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc2.kill()
        print("提示：用户库非空时 console 不会重跑 bootstrap"
              "（console_server.py: if not load_users(): bootstrap_admin()），"
              "所以页面改的口令不会被 .artifacts-secrets.env 里的旧值盖掉。")

        print("\n" + "=" * 50)
        if FAILS:
            print("结果：" + "、".join(FAILS) + " 没通过")
            return 1
        print("结果：全部通过 ✓")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())