"""起一个「隔离的成果台 console」给验证脚本用。

为什么要有这个：改登录口令是高危动作，拿生产账号 `artifacts` 做实验 ——
改坏了就是现场把人关在门外，测试本身成了事故。所以验证改口令必须跑在一台
自己的 console 上：自己的 CONSOLE_USER_FILE、自己的会话密钥、自己的数据目录。
进程退出，隔离环境连同里面的口令一起消失。

用法：
    with isolated_console(port=8899) as iso:
        iso.base        # http://127.0.0.1:8899
        iso.user        # 种子账号名
        iso.password    # 种子口令
        iso.users_file  # 隔离用户库路径
"""
from __future__ import annotations

import contextlib
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONSOLE_DIR = "/vol3/1000/Work/PilotDeck/PilotCode"


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _get(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


class isolated_console:                      # noqa: N801  当上下文管理器用
    def __init__(self, port=None, user="reviewer-longname",
                 password=None, tmpdir="/tmp/artifacts-isolated-console"):
        self.port = port or _free_port()
        self.user = user
        # 用户名要够长（≥10 位），否则「新口令不能和用户名一样」那条规则
        # 永远排在「至少 10 位」后面，走不到 —— 测试看着绿，其实没验到。
        self.password = password or ("seed-password-" + secrets.token_hex(4))
        self.tmpdir = tmpdir
        self.base = f"http://127.0.0.1:{self.port}"
        self.users_file = os.path.join(tmpdir, "users.json")
        self.proc = None

    def __enter__(self):
        subprocess.run(["rm", "-rf", self.tmpdir], check=False)
        os.makedirs(self.tmpdir, exist_ok=True)
        if CONSOLE_DIR not in sys.path:
            sys.path.insert(0, CONSOLE_DIR)
        import console_server as cs
        with open(self.users_file, "w", encoding="utf-8") as fh:
            json.dump({self.user: cs.hash_password(self.password)}, fh)
        os.chmod(self.users_file, 0o600)

        cfg = os.path.join(self.tmpdir, "console.yaml")
        with open(cfg, "w", encoding="utf-8") as fh:
            fh.write(
                "bind: [loopback]\n"
                f"port: {self.port}\n"
                "proxy_port_base: 3700\n"
                # console 的 normalize_devices 硬性要求至少一台设备、
                # 每台设备至少一个 app，留空直接 ConfigError 起步。
                "devices:\n"
                "- id: artifacts\n"
                "  name: 成果台\n"
                "  network: direct\n"
                "  host: 127.0.0.1\n"
                "  apps:\n"
                "  - id: artifacts-page\n"
                "    kind: web\n"
                "    name: 成果台\n"
                f"    url: http://127.0.0.1:{self.port}/artifacts.html\n"
                "im:\n  enabled: false\n")

        env = dict(os.environ)
        env.update({
            "CONSOLE_USER_FILE": self.users_file,
            "CONSOLE_SESSION_SECRET": "test-secret-" + secrets.token_hex(8),
            "ARTIFACTS_TOKEN": "test-token-" + secrets.token_hex(8),
            "ARTIFACTS_DATA_DIR": os.path.join(self.tmpdir, "data"),
            "ARTIFACTS_NOTIFY_WEBHOOK": "",
            "ARTIFACTS_WATCH_INTERVAL": "0",
        })
        self.proc = subprocess.Popen(
            [sys.executable, "console_server.py", "--config", cfg],
            cwd=CONSOLE_DIR, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(120):
            if _get(self.base, "/health") in (200, 401):
                return self
            time.sleep(0.25)
        out = self.proc.stdout.read(2000).decode(errors="replace") if self.proc.stdout else ""
        raise RuntimeError("隔离 console 起不来：\n" + out)

    def __exit__(self, *exc):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        with contextlib.suppress(OSError):
            subprocess.run(["rm", "-rf", self.tmpdir], check=False)
        return False
