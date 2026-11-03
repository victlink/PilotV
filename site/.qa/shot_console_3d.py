#!/usr/bin/env python3
"""在真实运行的成果台上截「三维模型查看」的真图。

不用拼图、不用画示意图：打开本机成果台 http://127.0.0.1:8799/，选中一个三维成果，
等 model-viewer 把 glb 真的渲染出来，再用真鼠标拖动转个角度、滚轮推近，然后截图。
截图里要有真实界面（左侧成果树、右侧标注栏、模型提示条），这样读者看到的就是真功能。

    python3 site/.qa/shot_console_3d.py --artifact-id art_289bb1 --out review/3d-view.png

参数：
  --url          成果台地址（默认 http://127.0.0.1:8799/）
  --artifact-id  要打开的三维成果 id（必填）
  --out          输出 png（默认 review/3d-view.png）
  --width/--height  视口尺寸（默认 1440x900）
  --rotate       水平拖动像素（默认 180，正数向右转）
  --zoom         滚轮档数（默认 -1，即推近）
  --no-side      只截舞台区域（默认截整页）
"""
from __future__ import annotations

import argparse
import pathlib

from playwright.sync_api import sync_playwright


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8799/")
    ap.add_argument("--artifact-id", required=True)
    ap.add_argument("--out", default="review/3d-view.png")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--rotate", type=int, default=180)
    ap.add_argument("--zoom", type=int, default=-1)
    ap.add_argument("--no-side", action="store_true")
    args = ap.parse_args()

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True,
                                     args=["--no-sandbox", "--use-gl=swiftshader",
                                           "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": args.width, "height": args.height},
                                device_scale_factor=2)
        problems: list[str] = []
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e.message}"))
        page.goto(args.url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector(".art-node-artifact", timeout=20000)

        node = page.locator(f'.art-node-artifact[data-id="{args.artifact_id}"]')
        if node.count() == 0:
            # 树默认按项目分组，成果可能被折叠着：先搜关键字展开。
            print(f"WARN  树上没直接看到 {args.artifact_id}，尝试展开项目分组")
            page.locator('.art-project-head, .art-node-head').first.click()
            page.wait_for_timeout(400)
            if node.count() == 0:
                browser.close()
                raise SystemExit(f"找不到成果 {args.artifact_id}")
        node.first.click()
        page.wait_for_timeout(600)

        mv = page.locator(".art-render model-viewer")
        mv.wait_for(state="attached", timeout=25000)
        # 等模型真的加载完：model-viewer 加载后会带 loaded 属性/类，
        # 只等「元素出现」会拍到一块灰底。
        try:
            page.wait_for_function(
                "() => { const m = document.querySelector('.art-render model-viewer');"
                " return !!m && (m.loaded === true || m.hasAttribute('loaded')"
                " || !!m.shadowRoot?.querySelector('canvas')); }",
                timeout=40000)
        except Exception as exc:
            print(f"WARN  等模型加载超时: {exc}")
        page.wait_for_timeout(2500)  # 让自动转起来一点，帧不是空的

        box = mv.bounding_box()
        if box:
            cx = box["x"] + box["width"] / 2
            cy = box["y"] + box["height"] / 2
            if args.rotate:
                page.mouse.move(cx, cy)
                page.mouse.down()
                page.mouse.move(cx + args.rotate, cy - 40, steps=24)
                page.mouse.up()
                page.wait_for_timeout(900)
            if args.zoom:
                page.mouse.move(cx, cy)
                page.mouse.wheel(0, args.zoom * 240)
                page.wait_for_timeout(1200)

        target = page.locator("#stage") if args.no_side else page
        target.screenshot(path=str(out), timeout=30000)
        kb = out.stat().st_size / 1024
        print(f"截图 {out} ({out.stat().st_size} bytes, {kb:.0f} KB)")
        if problems:
            print("页面报错:", "; ".join(problems[:5]))
        browser.close()


if __name__ == "__main__":
    main()
