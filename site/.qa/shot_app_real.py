#!/usr/bin/env python3
"""在真实运行的 PilotV 前端里截「三维模型查看」和「手绘标注」的真图。

截图不是拼的也不是画的：走网关 https://127.0.0.1:5186/ 打开真应用，
选中真会话里的成果，让真的 model-viewer 把 glb 渲染出来，再用真鼠标拖动旋转、
用真手指路径画一条笔迹，最后截真界面。脚本结束前把自己加的标注删掉。

    python3 site/.qa/shot_app_real.py --session "三维成果展示与交互标注" \
        --artifact "连接法兰 STEP" --out review/app-3d.png

参数：
  --url        网关地址（默认 https://127.0.0.1:5186/）
  --session    会话标题关键字（必填）
  --artifact   成果标题关键字（3D 图必填）
  --out        输出 png
  --width/--height  视口（默认 1440x900）
  --rotate     三维水平拖动像素（默认 170）
  --zoom       滚轮档数（默认 -1）
  --ink        在这张图上画笔迹（配合 --note 文本，结束前删除）
  --note       标注正文（给了 --ink 就必须给）
  --keep-note  不删除标注（默认会删，避免把测试数据留在正式库）
"""
from __future__ import annotations

import argparse
import json
import pathlib
import urllib.parse
import re

from playwright.sync_api import sync_playwright

CHROME_FLAGS = ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


def open_session(page, url: str, session: str, session_id: str = "", project: str = "",
                 args_backend: str = "http://127.0.0.1:3001") -> None:
    # 会话 id 直接进路由最稳：侧栏默认只露前几条，"Show more" 又是按项目分组的，
    # 靠点按钮找经常找不着。会话 id 形如 web:s_xxxx，要 URL 编码。
    if session_id:
        slug = urllib.parse.quote(session_id, safe="")
        # 必须带 ?d=：网关按 cookie 记住上次选的设备，少了这个参数可能落到别的
        # 后端上，令牌对不上就只剩登录页。
        target = (f"{url.rstrip('/')}/p/{project}/c/{slug}"
                  f"?d={urllib.parse.quote(args_backend, safe='')}")
        page.goto(target, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)
    else:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
    # 会话页加载完成的信号：右侧竖排的「对话/文件/成果」按钮条。
    page.get_by_role("button", name="对话", exact=True).first.wait_for(timeout=60000)
    page.wait_for_timeout(2000)
    if session_id:
        return
    # 会话列表默认只露前几条，目标常常藏在 "Show more" 后面；项目也可能没展开。
    for _ in range(6):
        node = page.get_by_text(session, exact=False).first
        if node.is_visible():
            break
        for name in ("显示更多|Show more|展开", "PilotV|General conversation"):
            more = page.get_by_role("button", name=name).first
            if more.is_visible():
                more.click()
                page.wait_for_timeout(600)
                break
        else:
            break
    node = page.get_by_text(session, exact=False).first
    node.wait_for(state="visible", timeout=60000)
    node.click(timeout=60000)
    page.get_by_role("button", name="对话", exact=True).first.wait_for(timeout=60000)
    page.wait_for_timeout(2000)


def open_artifacts_tab(page) -> None:
    # 「对话/文件/成果」是右侧竖排的按钮条，没有 nav 地标，只能整页找。
    page.get_by_role("button", name="成果", exact=True).first.click(timeout=30000)
    page.wait_for_timeout(3000)


def pick_artifact(page, keyword: str) -> None:
    """成果列表是一个 <select>（标题写着「选择成果」），不是卡片列表，按选项挑。"""
    picks = page.locator("select")
    for i in range(picks.count()):
        labels = picks.nth(i).evaluate(
            "el => Array.from(el.options).map(o => ({v: o.value, t: o.textContent || ''}))")
        hit = next((o for o in labels if keyword in o["t"] and o["v"]), None)
        if hit:
            picks.nth(i).select_option(hit["v"])
            page.wait_for_timeout(4500)
            return
    target = page.get_by_text(keyword, exact=False).first
    target.wait_for(state="visible", timeout=30000)
    target.click()
    page.wait_for_timeout(2500)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://127.0.0.1:5186/")
    ap.add_argument("--session", required=True)
    ap.add_argument("--artifact", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--rotate", type=int, default=170)
    ap.add_argument("--zoom", type=int, default=-1)
    ap.add_argument("--ink", action="store_true")
    ap.add_argument("--note", default="")
    ap.add_argument("--keep-note", action="store_true")
    ap.add_argument("--token-file", default="/tmp/pilotv-shot-token")
    ap.add_argument("--backend", default="http://127.0.0.1:3001")
    ap.add_argument("--session-id", default="")
    ap.add_argument("--project", default="home-marc-PilotV")
    ap.add_argument("--mint", action="store_true",
                    help="先重新签一枚本机会话令牌（默认令牌 30 分钟就过期）")
    args = ap.parse_args()

    if args.mint:
        import subprocess
        subprocess.run(["python3", str(pathlib.Path(__file__).with_name("mint_local_token.py"))],
                       check=True, timeout=120)

    if args.ink and not args.note:
        raise SystemExit("--ink 需要同时给 --note")
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    created: list[tuple[str, str]] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=CHROME_FLAGS)
        ctx = browser.new_context(viewport={"width": args.width, "height": args.height},
                                  device_scale_factor=2, ignore_https_errors=True,
                                  has_touch=True)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(e.message[:160]))

        # 登录态：前端把 JWT 放在 localStorage['pilotdeck-tokens'] 里，键名是
        # window.__PILOTV__.backend（回退 window.location.origin），见
        # ui/src/components/auth/deviceTokens.ts 的 readTokenFor()。
        # 只写 'auth-token' 不够——请求头读的是后端键。
        # init script 是覆盖式写入，reload 时会重跑，所以后端键必须在这里一次写全，
        # 否则刷新后又被抹成只剩 'auth-token'，前端直接退回登录页。
        token = pathlib.Path(args.token_file).read_text().strip()
        seed_keys = sorted({args.backend, args.url.split("://", 1)[-1].split("/")[0],
                            args.url, "auth-token"})

        # 注意：Python 版 add_init_script(script) 不接参数，值只能拼进脚本文本；
        # 早先写成函数+参数的形式，脚本其实从没执行过，页面一直停在登录页。
        def seed_script(keys: list[str]) -> str:
            data = json.dumps({"token": token, "keys": keys}, ensure_ascii=False)
            return (f"(() => {{ try {{ const s = {data}; const o = {{}};"
                    f" for (const k of s.keys) o[k] = s.token;"
                    f" localStorage.setItem('pilotdeck-tokens', JSON.stringify(o));"
                    f" }} catch (e) {{}} }})()")

        page.add_init_script(seed_script(seed_keys))
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        # 页面配置里的 backend 未必等于 --backend，缺键就在补齐后刷新一次。
        backend = page.evaluate("() => (window.__PILOTV__ && window.__PILOTV__.backend) || ''")
        if backend and backend not in seed_keys:
            page.add_init_script(seed_script(sorted(set(seed_keys) | {backend})))
            page.reload(wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)

        try:
            open_session(page, args.url, args.session, args.session_id, args.project,
                        args.backend)
            open_artifacts_tab(page)
            pick_artifact(page, args.artifact)
        except Exception:
            page.screenshot(path=str(out.with_suffix('.fail.png')))
            print('失败现场:', out.with_suffix('.fail.png'))
            print('页面正文:', ' '.join(page.locator('body').inner_text().split())[:400])
            raise

        if args.ink:
            # 手绘：先切到手绘笔（InkOverlay 只在 tool==='ink' 时挂载），再在画布上走真实指针路径。
            pen = page.get_by_role("button", name="手绘", exact=True).first
            pen.wait_for(state="visible", timeout=20000)
            pen.click()
            canvas = page.locator('[data-testid="ink-canvas"]').first
            canvas.wait_for(state="visible", timeout=15000)
            box = canvas.bounding_box()
            if not box:
                raise SystemExit("手绘画布没有尺寸")
            x0 = box["x"] + box["width"] * 0.22
            y0 = box["y"] + box["height"] * 0.55
            page.mouse.move(x0, y0)
            page.mouse.down()
            for i in range(1, 22):
                import math
                page.mouse.move(x0 + box["width"] * 0.030 * i,
                                y0 + box["height"] * 0.10 * math.sin(i / 2.4))
                page.wait_for_timeout(14)
            page.mouse.up()
            page.wait_for_timeout(500)
            field = page.locator("#artifact-note-draft")
            if field.is_visible():
                field.fill(args.note)
                page.wait_for_timeout(200)
                with page.expect_response(
                        lambda r: "/annotations" in r.url and r.request.method == "POST",
                        timeout=20000) as resp:
                    page.get_by_role("button", name="保存标注").click()
                payload = resp.value.json()
                aid = re.search(r"/api/artifacts/([^/]+)/annotations", resp.value.url)
                nid = (payload.get("annotation") or {}).get("id") or payload.get("id")
                if aid and nid:
                    created.append((aid.group(1), str(nid)))
                page.wait_for_timeout(1500)

        if args.artifact.lower().find("3d") >= 0 or True:
            mv = page.locator("model-viewer").first
            if mv.count() and mv.is_visible():
                try:
                    page.wait_for_function(
                        "() => { const m = document.querySelector('model-viewer');"
                        " return !!m && (m.loaded === true || m.hasAttribute('loaded')); }",
                        timeout=45000)
                except Exception as exc:
                    print(f"WARN  等三维模型加载超时: {exc}")
                page.wait_for_timeout(3000)
                # STEP 加载出来的默认机位常常贴着模型（只剩一条边），这里重置视角。
                try:
                    state = page.evaluate(
                        "async () => { const m = document.querySelector('model-viewer');"
                        " if (!m) return 'no-model';"
                        " try { m.cameraOrbit = '35deg 72deg 150%'; } catch (e) {}"
                        " try { m.cameraTarget = 'auto'; } catch (e) {}"
                        " if (m.jumpCameraToGoal) m.jumpCameraToGoal();"
                        " if (m.dollyOut) { for (let i = 0; i < 5; i++) { await m.dollyOut(0.3); } }"
                        " return 'ok'; }")
                    print("三维机位:", state)
                except Exception as exc:
                    print("WARN  重置三维机位失败:", exc)
                page.wait_for_timeout(2500)
                mbox = mv.bounding_box()
                if mbox and args.rotate:
                    cx = mbox["x"] + mbox["width"] / 2
                    cy = mbox["y"] + mbox["height"] / 2
                    page.mouse.move(cx, cy)
                    page.mouse.down()
                    page.mouse.move(cx + args.rotate, cy - 46, steps=26)
                    page.mouse.up()
                    page.wait_for_timeout(1000)
                if mbox and args.zoom:
                    page.mouse.move(cx, cy)
                    page.mouse.wheel(0, args.zoom * 220)
                    page.wait_for_timeout(1400)

        page.screenshot(path=str(out), timeout=30000)
        print(f"截图 {out} {out.stat().st_size // 1024} KB")
        if errors:
            print("页面报错:", " | ".join(errors[:4]))

        for aid, nid in created:
            if args.keep_note:
                print(f"保留标注 {aid}/{nid}")
                continue
            page.request.delete(f"{args.url.rstrip('/')}/api/artifacts/{aid}/annotations/{nid}")
            print(f"已清理测试标注 {aid}/{nid}")
        browser.close()


if __name__ == "__main__":
    main()
