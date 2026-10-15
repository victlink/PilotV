#!/usr/bin/env python3
"""PilotV 成果台服务：让本项目不依赖 PilotCode 里的 console_server 也能独立跑。

背景（为什么需要这个文件）：
  成果台的 API 与页面本来由 PilotDeck 的宿主 console（console_server.py）挂载。
  那样部署等于「本项目 + 一个外部宿主」两处代码，换机器就得对着别的目录猜路径。
  这里提供最小可用的自宿主：挂同一套 artifacts_console，挂同一批静态资源，
  数据、密钥、端口都可用环境变量指定 —— 只装本项目就能起。

安全边界（有意为之，不要在没读这段的情况下改 bind 默认值）：
  - 默认只监听回环。此时唯一入口是本机前端代理，暴露面与现在线上 5186 一致。
  - 要让局域网/Tailscale 直连必须显式 --bind 0.0.0.0，且必须设置 ARTIFACTS_TOKEN，
    否则拒绝启动：没有令牌的话，成果接口对任何能连上的人都是敞开的。
  - Bearer 令牌由 artifacts_console 自己校验（_authorized），这里不另写一套鉴权。

用法：
  python3 service/serve_artifacts.py [--host 127.0.0.1] [--port 8799]
环境变量：
  ARTIFACTS_DATA_DIR  成果存储目录，默认 <项目根>/.artifacts-data
  ARTIFACTS_TOKEN     对外暴露时必填的访问令牌
  CONSOLE_ROOT        通知里回链用的根地址，默认本项目根目录
"""
from __future__ import annotations

import argparse
import os
import sys

from aiohttp import web

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import artifacts_console  # noqa: E402  (需要先补 sys.path)

HEALTH_BODY = {
    "service": "pilotv-artifacts",
    "data_dir": artifacts_console.DATA_DIR,
    "authenticated": bool(os.environ.get("ARTIFACTS_TOKEN")),
}


def build_app() -> web.Application:
    app = web.Application(client_max_size=256 * 1024 * 1024)
    # store / materializer 由 mount() 注入 app["store"] 等，这里不用自己造。
    artifacts_console.mount(app, console_root=ROOT)

    async def health(_request: web.Request) -> web.Response:
        return web.json_response(HEALTH_BODY)

    async def root(_request: web.Request) -> web.Response:
        # 独立成果台页面已删除；成果页在 PilotV 前端里，这里只报服务身份。
        return web.json_response(HEALTH_BODY)

    app.router.add_get("/healthz", health)
    app.router.add_get("/", root)
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PilotV 成果台服务")
    parser.add_argument("--host", default="127.0.0.1", help="默认只监听回环")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ARTIFACTS_PORT", "8799")))
    parser.add_argument(
        "--token-file",
        default="",
        help="从文件读令牌。每台设备各装一套时用它，而不是把令牌写在命令行上——"
             "命令行对同机任何进程都可见（ps），文件可以只给自己读。",
    )
    args = parser.parse_args(argv)

    exposed = args.host not in ("127.0.0.1", "localhost", "::1")
    token = os.environ.get("ARTIFACTS_TOKEN", "")
    if args.token_file:
        try:
            with open(args.token_file, "r", encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError as exc:
            print(f"读令牌文件失败：{args.token_file}（{exc}）", file=sys.stderr)
            return 2
    if exposed and not token:
        print(
            f"拒绝启动：--host {args.host} 会让成果接口对外可达，但没有令牌。"
            "\n  令牌就是这一层唯一的门禁 —— 要么用 ARTIFACTS_TOKEN / --token-file 补上，"
            "要么改回 127.0.0.1。",
            file=sys.stderr,
        )
        return 2
    # artifacts_console 自己读这个变量做鉴权，所以令牌必须落回环境里。
    if token:
        os.environ["ARTIFACTS_TOKEN"] = token

    os.environ.setdefault("CONSOLE_ROOT", ROOT)
    print(f"成果台 {args.host}:{args.port}  数据目录 {artifacts_console.DATA_DIR}  "
          f"对外可达={'是' if exposed else '否'} 令牌={'已配置' if token else '未配置'}", flush=True)
    web.run_app(build_app(), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())