"""页面回归用的一次性服务：只挂成果台，不带 console 的登录鉴权。

为什么需要它：
    /artifacts-static/* 与 /static/* 走 console 自己的鉴权，只有 /api/artifacts 对回环放行。
    console 若没有 CONSOLE_SESSION_SECRET（随机密钥），自动化没法造登录态。
    回归要验的是「前端 ↔ 成果台 API ↔ SSE」，这一层与 console 鉴权无关，
    所以单起一个进程来验，不去动正在跑的 console。

跑法：python3 scripts/serve_test.py [--port 8899]
"""
import argparse
import os
import sys

from aiohttp import web

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import artifacts_console  # noqa: E402

# 只服务 PilotV 自己的 static/。
# 原来这里默认指向 /vol3/1000/Work/PilotDeck/PilotCode，既跨了项目，
# 那个路径下也根本没有 static/ 子目录 —— 结果这条路由 404 掉一切。
# PilotV 是独立项目，不该对别的仓库有隐式依赖；页面真正用的静态资源由
# artifacts_console 的 /artifacts-static 提供，本来就走本仓库的 static/。
STATIC_ROOT = os.environ.get("PILOTV_STATIC", os.path.join(HERE, "static"))


async def static_(request):
    rel = request.match_info.get("path", "")
    path = os.path.normpath(os.path.join(STATIC_ROOT, rel))
    if not path.startswith(STATIC_ROOT):        # 别让 ../ 逃出 static/
        return web.Response(status=404, text="not found")
    if os.path.isfile(path):
        return web.FileResponse(path)
    return web.Response(status=404, text=f"not found: {rel}")


def build_app():
    app = web.Application()
    app.router.add_get("/static/{path:.*}", static_)
    artifacts_console.mount(app)
    # 自检：成果页要用的静态资源与 API 必须注册上（历史上少一个逗号就静默失效过）
    paths = {r.resource.canonical for r in app.router.routes()}
    for need in ("/artifacts-static/{name}", "/api/artifacts", "/api/artifacts/workspace"):
        assert need in paths, f"{need} 没注册上"
    print(f"[serve_test] 路由自检通过（{len(paths)} 条）", flush=True)
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    web.run_app(build_app(), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
