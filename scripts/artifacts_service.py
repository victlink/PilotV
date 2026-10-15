"""成果台 · 生产启动器（每台设备各装一套时的入口）。

为什么不用 scripts/serve_test.py：那个是**页面回归用的一次性服务**，它自己就写明
了「不带 console 的登录鉴权」，默认只绑 127.0.0.1，还带着一套路由自检断言。
拿它当正式服务，等于把「回归工具」变成「生产进程」——将来改回归脚本就可能改到线上。

这个启动器是给**独立部署**用的：
  - 监听默认 127.0.0.1；要跨机访问必须显式 --host 0.0.0.0，此时**强制要求 token**，
    否则等于把成果（往往含未公开的设计稿、代码）裸奔到网上。
  - token 从环境 ARTIFACTS_TOKEN 读；没配就随机生成一份并打印出来，
    只在「绑回环」时允许匿名。
  - 数据目录默认 <仓库>/.artifacts-data，可用 ARTIFACTS_DATA_DIR 挪走。

跑法：
  python3 scripts/artifacts_service.py                       # 本机自用
  python3 scripts/artifacts_service.py --host 0.0.0.0 \
      --token-file ~/.config/artifacts-console/token        # 同局域网访问
"""
from __future__ import annotations

import argparse
import os
import secrets
import sys

from aiohttp import web

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import artifacts_console  # noqa: E402


def build_app() -> web.Application:
    """只挂成果台。页面本身靠 console 登录态，独立部署时由 token 兜住。"""
    app = web.Application(client_max_size=64 * 1024 * 1024)
    artifacts_console.mount(app)
    return app


def main() -> int:
    ap = argparse.ArgumentParser(description="成果台服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("ARTIFACTS_PORT", "8801")))
    ap.add_argument("--token", default=os.environ.get("ARTIFACTS_TOKEN", ""))
    ap.add_argument("--token-file", default=os.environ.get("ARTIFACTS_TOKEN_FILE", ""),
                    help="从文件读 token；比命令行/环境变量安全（不留在 ps 和 shell 历史里）")
    args = ap.parse_args()

    token = args.token
    if args.token_file:
        try:
            with open(os.path.expanduser(args.token_file), encoding="utf-8") as fh:
                token = fh.read().strip()
        except OSError as e:
            print(f"[artifacts] 读不到 token 文件 {args.token_file}：{e}", file=sys.stderr)
            return 2

    # 绑到回环以外就必须有鉴权。这里直接拒绝启动，不给「先跑起来再说」留口子。
    if args.host not in ("127.0.0.1", "localhost", "::1") and not token:
        print("[artifacts] 拒绝启动：监听非回环地址却没配 token。\n"
              "           用 --token-file 指定，或设 ARTIFACTS_TOKEN 后重试。", file=sys.stderr)
        return 2

    if not token:
        token = secrets.token_urlsafe(24)
        print(f"[artifacts] 本机自用模式，本次随机 token：{token}")
        print("[artifacts] 需要跨设备访问就固定它：export ARTIFACTS_TOKEN=...")

    os.environ["ARTIFACTS_TOKEN"] = token
    data_dir = os.environ.get("ARTIFACTS_DATA_DIR") or os.path.join(HERE, ".artifacts-data")
    print(f"[artifacts] 数据目录 {data_dir}")
    print(f"[artifacts] 监听 http://{args.host}:{args.port}/  （成果视图在 PilotV 前端里）")

    web.run_app(build_app(), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())