#!/usr/bin/env python3
"""对真实 PilotVLogo 组件做浏览器实拍。

不复述组件、不手抄等价物：先用 react-dom/server 渲染真正的 TSX，再让
Chromium 把 16s 循环用负 animation-delay 定格在若干相位逐格拍下来。

Snap 版 Chromium 有沙箱，读不到工作区和 /tmp —— 这里直接复用
render_brand_icons.scratch_root() 探测出的可读写目录，不自己猜。

用法：
    python3 scripts/shot_brand_component.py [--out 输出目录]
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UI = REPO / 'pilotdeck-mobile/upstream-official/ui'
RENDER = '/tmp/pv-harness/render.mts'
sys.path.insert(0, str(REPO / 'scripts'))
import render_brand_icons as rbi  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(Path.home() / 'pv-brand-shots'))
    args = ap.parse_args()

    if not Path(RENDER).exists():
        print(f'缺少渲染脚本 {RENDER}', file=sys.stderr)
        return 2

    print('1/3 渲染组件 -> HTML')
    proc = subprocess.run(
        ['node', '--import', 'tsx', RENDER], cwd=UI, capture_output=True, text=True
    )
    if proc.returncode != 0:
        print(proc.stderr[-2000:], file=sys.stderr)
        return 1
    print('   ', proc.stdout.strip())

    chrome = rbi.find_chrome()
    scratch = rbi.scratch_root(chrome)
    scratch.mkdir(parents=True, exist_ok=True)
    print(f'2/3 chromium={chrome}\n    可读写目录={scratch}')

    page = scratch / 'pilotv-component.html'
    shutil.copy('/tmp/pv-harness/index.html', page)
    shot = scratch / 'pilotv-component.png'
    if shot.exists():
        shot.unlink()

    cmd = [
        chrome, '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--force-device-scale-factor=2', '--window-size=1180,1560',
        '--virtual-time-budget=5000', f'--screenshot={shot}', page.as_uri(),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=180)

    if not shot.exists():
        print('截图失败：', res.stderr[-1500:], file=sys.stderr)
        return 1
    print(f'3/3 截图 {shot.stat().st_size} 字节 -> {shot}')

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    final = out / 'pilotv-component.png'
    shutil.copy(shot, final)
    print(f'    已复制到 {final}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
