"""读 console 的口令，并给「口令被人在页面上改过了」一个能落地的提示。

背景：页面 ⚙ 设置面板支持改登录口令。改完之后，
`.artifacts-secrets.env` 里 `ARTIFACTS_CONSOLE_PASSWORD` 就是**过期值**了
（启动链路根本没有代码读它写回用户库，console 只在用户库为空时才 bootstrap）。
自检脚本却都靠它登录 —— 不处理的话，它们会在用户改完口令后突然全线红，
看起来像成果台坏了，其实只是钥匙换了。

所以：登录失败必须说清楚「是哪一种原因、接下来怎么办」。
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

SECRETS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".artifacts-secrets.env")

_HINT = (
    "登录失败。若你刚在成果台页面右上角 ⚙ 里改过登录口令，那么 "
    "{path} 里的 ARTIFACTS_CONSOLE_PASSWORD 已经是过期值：\n"
    "  · 把新口令写回该文件，或临时用 ARTIFACTS_CONSOLE_PASSWORD='你的新口令' 覆盖；\n"
    "  · 改口令不需要重启 console，用户库里已是新值；\n"
    "  · 想彻底换一把，用 console_server.py --add-user <用户名> 重新建账号。\n"
)


def secret(name: str, path: str = SECRETS_PATH) -> str:
    """从 secrets 文件读一个值。环境变量优先，方便临时覆盖。"""
    env = os.environ.get(name)
    if env:
        return env
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def login(base: str, user: str, password: str, timeout: int = 10):
    """POST /api/login。失败时把「口令过期」这件事说清楚，而不是抛个 401 让人猜。

    返回 urllib 的响应；成功时其 headers 里带 pdc_console Cookie。
    """
    body = json.dumps({"username": user, "password": password}).encode()
    req = urllib.request.Request(
        f"{base}/api/login", data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise SystemExit(f"✗ console 登录被拒（401）：{_HINT.format(path=SECRETS_PATH)}")
        raise