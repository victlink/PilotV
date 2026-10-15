#!/usr/bin/env python3
"""成果台 · 一台设备装一套。

做的事只有四件，但顺序有讲究 —— 先体检再落配置，别把插件清单指到一个起不来的地址上：
  1. 体检：把「缺了会怎样」一起列出来，而不是笼统说「依赖没装」
  2. 写这台设备的数据目录（默认仓库内 .artifacts-data）
  3. 生成本机 MCP 插件清单，指向 127.0.0.1:<port>
  4. 打印 systemd 单元片段，让它开机自起

用法：
  python3 scripts/install_device.py                     # 体检 + 写插件清单
  python3 scripts/install_device.py --port 8801 --data-dir ~/.local/share/artifacts
  python3 scripts/install_device.py --check-only        # 只体检，不改任何东西
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

# (命令, 缺了会怎样) —— 说人话，别只说「未找到」
CHECKS = [
    (["python3", "-c", "import aiohttp; print(aiohttp.__version__)"], "必需",
     "成果台服务和 MCP 侧车都靠它，起不来。装：pip install aiohttp"),
    (["node", "--version"], "必需", "MCP 侧车是 .mjs。没 node 就完全没有 MCP 接入。"),
    (["pdftoppm", "-v"], "图纸 PDF 栅格化", "缺了 PDF 图纸只能退回浏览器自带阅读器（常显示成黑框）。"),
    (["ffprobe", "-version"], "视频时长/帧率", "缺了视频标注就没有时间点和帧号。"),
    (["ffmpeg", "-version"], "视频首帧", "缺了视频没有首帧缩略图。"),
]

SIDECAR_SRC = [
    "process.env.PILOTDECK_SRC",
    "~/PilotDeck-src",
    "~/src/PilotDeck",
    "/opt/PilotDeck",
]


def which(cmd: str) -> str | None:
    return shutil.which(cmd)


def check_deps(verbose: bool) -> bool:
    """逐项体检。返回 True = 必需的都有。"""
    fatal = False
    print("依赖体检")
    for cmd, level, why in CHECKS:
        exe = cmd[0]
        path = which(exe)
        if path:
            ver = ""
            try:
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
                first = (out.stdout or out.stderr or "").strip().splitlines()
                if first:
                    ver = first[0][:52]
            except Exception:
                pass
            print(f"  ✓ {exe:<10} {ver}")
        else:
            mark = "✗" if level == "必需" else "!"
            if level == "必需":
                fatal = True
            print(f"  {mark} {exe:<10} 缺（{level}）—— {why}")
    if verbose:
        print("\nMCP SDK 查找顺序（PILOTDECK_SRC 优先）")
        for c in SIDECAR_SRC[1:]:
            p = os.path.expanduser(c)
            sdk = os.path.join(p, "node_modules/@modelcontextprotocol/sdk/dist/esm")
            print(f"  {'✓' if os.path.isdir(sdk) else '·'} {sdk}")

    # Chromium 的查找规则很绕（先翻 Playwright 缓存目录，再找 PATH 上的几个名字），
    # 跟实际渲染走的是同一段代码。这里直接调用它，不要另抄一份清单 ——
    # 抄一份的结果就是「体检说缺、跑起来却好好的」，这种假警报比不体检更糟。
    try:
        import artifacts_cdp
        chrome = artifacts_cdp._chrome_binary()  # noqa: SLF001 —— 同一个仓库内复用
    except Exception:
        chrome = ""
    if chrome:
        print(f"  ✓ {'chromium':<10} {chrome}")
    else:
        print(f"  ! {'chromium':<10} 缺（页面截图）—— 缺了网页成果没有缩略图，"
              "三维/图纸预览也没法出图。\n"
              "    装 Playwright 的 chromium：python3 -m playwright install chromium")

    return not fatal


def write_plugin(port: int, host: str = "127.0.0.1") -> str:
    """写本机 PilotDeck 的插件清单。每台设备各装一套，所以地址固定回环。"""
    base = os.path.expanduser("~/.pilotdeck/plugins/artifacts")
    os.makedirs(base, exist_ok=True)
    path = os.path.join(base, "plugin.json")
    manifest = {
        "name": "artifacts",
        "version": "1.0.0",
        "description": "成果台：把产出的页面/图片/视频/图纸/三维成果登记到评审台，"
                       "人在画面上框选标注，agent 可拉回意见返工",
        "mcpServers": {"artifacts": {"url": f"http://{host}:{port}/api/artifacts-mcp"}},
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return path


SYSTEMD = """[Unit]
Description=PilotV 成果台
After=network.target

[Service]
Type=simple
WorkingDirectory={repo}
Environment=ARTIFACTS_DATA_DIR={data}
ExecStart={python} {repo}/scripts/artifacts_service.py --port {port}
Restart=on-failure

[Install]
WantedBy=default.target
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="在当前设备上装一套成果台")
    ap.add_argument("--port", type=int, default=8801)
    ap.add_argument("--data-dir", default=os.path.join(HERE, ".artifacts-data"))
    ap.add_argument("--check-only", action="store_true", help="只体检，不写任何文件")
    ap.add_argument("--systemd", action="store_true", help="额外打印 systemd 单元")
    args = ap.parse_args()

    print(f"成果台安装体检（仓库 {HERE}）\n")
    ok = check_deps(verbose=not args.check_only)
    if not ok:
        print("\n必需的依赖还缺着，先补齐再装 —— 现在写插件清单只会指到一个起不来的地址。")
        return 1
    if args.check_only:
        print("\n（--check-only：没有改动任何文件）")
        return 0

    data = os.path.abspath(os.path.expanduser(args.data_dir))
    os.makedirs(data, exist_ok=True)
    print(f"\n数据目录 {data}")

    path = write_plugin(args.port)
    print(f"插件清单 {path}")
    with open(path, encoding="utf-8") as fh:
        print("  " + json.dumps(json.load(fh)["mcpServers"], ensure_ascii=False))

    print("\n启动")
    print(f"  ARTIFACTS_DATA_DIR={data} python3 {HERE}/scripts/artifacts_service.py --port {args.port}")

    if args.systemd:
        unit = SYSTEMD.format(repo=HERE, data=data, port=args.port, python=sys.executable)
        print("\n开机自起（写进 ~/.config/systemd/user/artifacts-console.service）：\n")
        print("\n".join("# " + ln for ln in unit.splitlines()))
        print("\n然后：systemctl --user daemon-reload && systemctl --user enable --now artifacts-console")

    print("\n还差一步：验证插件真能连上（用 PilotDeck 本体的解析器和 McpClient）")
    print(f"  node artifacts-mcp.mjs &")
    print(f"  PILOTDECK_SRC=<你的 PilotDeck 源码目录> node scripts/verify_plugin.mjs {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())