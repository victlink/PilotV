#!/usr/bin/env python3
"""在真实运行的 PilotV 前端里录一段产品演示视频。

不是录屏拼图，是真的开一个 Chromium 录下真实操作：
打开真应用 → 进项目组 → 成果页选中三维成果 → 真鼠标拖动旋转 + 滚轮缩放
→ 切手绘工具，在模型上真画一笔 → 写标注 → 确认提交 → 批注出现在右侧面板。

Playwright 录出来的是 webm，再用 ffmpeg 转成网页友好的 H.264 mp4 + 一张封面。

用法:
  python3 site/.qa/rec_app_video.py --session "三维成果展示与交互标注" \
      --artifact "连接法兰 STEP" --out site/assets/demo-3d-annotate.mp4

参数:
  --url 网关地址（默认 https://127.0.0.1:5186/）
  --session 会话标题关键字（必填）  --artifact 成果标题关键字（必填）
  --out 输出 mp4（必填）            --width/--height 录制视口（默认 1440x810）
  --fps 输出帧率（默认 30）         --crf 画质（默认 30，越小越清晰体积越大）
  --poster-at 封面取第几秒（默认 10）
  --ink 录制手绘标注环节            --note 标注文字（配 --ink）
  --keep-note 录完保留标注（默认录完自动清掉测试标注）
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import shot_app_real as S  # 复用登录态注入 / 会话选择 / 成果选择

PROJECTS = ["PilotV", "CAD", "设备管理", "3D", "sub2api", "pilotcode", "aistudio",
            "VICTLINK-AI", "OBS", "General conversation", "PilotStudio"]


def seed_token_script(token: str, keys: list[str]) -> str:
    data = json.dumps({"token": token, "keys": keys}, ensure_ascii=False)
    return (
        f"(() => {{ try {{ const s = {data}; const o = {{}};"
        f" for (const k of s.keys) o[k] = s.token;"
        f" localStorage.setItem('pilotdeck-tokens', JSON.stringify(o));"
        f" }} catch (e) {{}} }})()"
    )


def expand_sidebar(page, session: str, projects: list[str]) -> None:
    """侧栏默认按项目折叠且每组只露前几条：先把项目一个个展开、把 Show more 全点开。"""
    for proj in projects:
        btn = page.get_by_role("button", name=re.compile(f"^{re.escape(proj)}$")).first
        try:
            if not btn.is_visible(timeout=3000):
                continue
            btn.click(timeout=3000)
        except Exception:
            continue
        page.wait_for_timeout(900)
        for _ in range(6):
            more = page.get_by_role("button", name=re.compile("Show more|显示更多")).all()
            clicked = False
            for m in more:
                try:
                    if m.is_visible():
                        m.click(timeout=3000)
                        page.wait_for_timeout(500)
                        clicked = True
                        break
                except Exception:
                    continue
            if not clicked:
                break
        if page.get_by_text(session, exact=False).first.is_visible():
            return


def drag_rotate(page, cx: int, cy: int, dx: int, steps: int = 40, pause: int = 16) -> None:
    page.mouse.move(cx, cy)
    page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(cx + dx * i / steps, cy - abs(dx) * 0.12 * i / steps)
        page.wait_for_timeout(pause)
    page.mouse.up()


def draw_stroke(page, x0: float, y0: float, x1: float, y1: float, steps: int = 26) -> None:
    page.mouse.move(x0, y0)
    page.mouse.down()
    for i in range(1, steps + 1):
        t = i / steps
        page.mouse.move(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
        page.wait_for_timeout(22)
    page.mouse.up()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://127.0.0.1:5186/")
    ap.add_argument("--session", required=True)
    ap.add_argument("--artifact", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=810)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--crf", type=int, default=30)
    ap.add_argument("--poster-at", type=float, default=10.0)
    ap.add_argument("--ink", action="store_true")
    ap.add_argument("--note", default="倒角再深一点，R2")
    ap.add_argument("--keep-note", action="store_true")
    ap.add_argument("--token-file", default="/tmp/pilotv-shot-token")
    ap.add_argument("--backend", default="http://127.0.0.1:3001")
    ap.add_argument("--session-id", default="")
    ap.add_argument("--project", default="home-marc-PilotV")
    ap.add_argument("--mint", action="store_true")
    args = ap.parse_args()

    if args.mint:
        subprocess.run(["python3", str(pathlib.Path(__file__).with_name("mint_local_token.py"))],
                       check=True, timeout=120)

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    video_dir = pathlib.Path(tempfile.mkdtemp(prefix="pilotv-rec-"))
    created: list[tuple[str, str]] = []
    errors: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=S.CHROME_FLAGS)
        ctx = browser.new_context(
            viewport={"width": args.width, "height": args.height},
            ignore_https_errors=True,
            has_touch=True,
            record_video_dir=str(video_dir),
            record_video_size={"width": args.width, "height": args.height},
        )
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))

        token = pathlib.Path(args.token_file).read_text().strip()
        keys = sorted({args.backend, args.url.split("://", 1)[-1].split("/")[0], args.url, "auth-token"})
        page.add_init_script(seed_token_script(token, keys))
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        backend = page.evaluate("() => (window.__PILOTV__ && window.__PILOTV__.backend) || ''")
        if backend and backend not in keys:
            page.add_init_script(seed_token_script(token, sorted(set(keys) | {backend})))
            page.reload(wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)

        # 有 session id 就直接进路由；没有就把侧栏的项目和 Show more 全展开再点
        if args.session_id:
            S.open_session(page, args.url, args.session, args.session_id, args.project, args.backend)
        else:
            S.open_session(page, args.url, args.session, "", args.project, args.backend)
            expand_sidebar(page, args.session, PROJECTS)
            node = page.get_by_text(args.session, exact=False).first
            node.wait_for(state="visible", timeout=60000)
            node.click()
            page.get_by_role("button", name="对话", exact=True).first.wait_for(timeout=60000)
            page.wait_for_timeout(2500)
        S.open_artifacts_tab(page)
        page.wait_for_timeout(8000)

        picked = False
        for attempt in range(3):
            try:
                S.pick_artifact(page, args.artifact)
                picked = True
                break
            except Exception as e:
                print(f"找成果第 {attempt + 1} 次失败:", str(e)[:120])
                page.wait_for_timeout(5000)
        if not picked:
            page.screenshot(path="/tmp/rec-fail-artifacts.png")
            print("现场:", "/tmp/rec-fail-artifacts.png")
            print("页面正文:", " ".join(page.locator("body").inner_text().split())[:600])

        # 1) 让模型转起来、加载完，稳定在最好看的一帧
        page.screenshot(path="/tmp/rec-after-pick.png")
        probe = page.evaluate(
            "() => ({mv: document.querySelectorAll('model-viewer').length,"
            " canvas: document.querySelectorAll('canvas').length,"
            " iframe: document.querySelectorAll('iframe').length,"
            " viewer3d: document.querySelectorAll('.viewer-3d,[class*=viewer]').length,"
            " url: location.href})")
        print("选中成果后:", probe)
        page.wait_for_timeout(7000)

        # 2) 真拖动旋转 + 滚轮缩放：慢一点，录像里才看得清
        mv = page.locator("model-viewer").first
        mv.wait_for(state="visible", timeout=30000)
        box = mv.bounding_box() or {"x": 200, "y": 150, "width": 900, "height": 600}
        cx = int(box["x"] + box["width"] / 2)
        cy = int(box["y"] + box["height"] / 2)
        drag_rotate(page, cx, cy, 150)
        page.wait_for_timeout(1500)
        drag_rotate(page, cx, cy, -120)
        page.wait_for_timeout(1200)
        page.mouse.move(cx, cy)
        page.mouse.wheel(0, -420)
        page.wait_for_timeout(2000)

        # 3) 手绘标注：切工具、在模型上画、写意见、提交
        if args.ink:
            try:
                pen = page.get_by_role("button", name="手绘", exact=True).first
                pen.click()
                page.wait_for_timeout(1500)
                canvas = page.locator('[data-testid="ink-canvas"]').first
                canvas.wait_for(state="visible", timeout=15000)
                cb = canvas.bounding_box()
                x0, y0 = cb["x"] + cb["width"] * 0.34, cb["y"] + cb["height"] * 0.56
                draw_stroke(page, x0, y0, x0 + cb["width"] * 0.30, y0 - cb["height"] * 0.20)
                page.wait_for_timeout(900)
                draw_stroke(page, x0 + 10, y0 + 40, x0 + cb["width"] * 0.26, y0 + cb["height"] * 0.06)
                page.wait_for_timeout(1200)
                field = page.locator("#artifact-note-draft").first
                field.click()
                page.wait_for_timeout(500)
                for ch in args.note:
                    field.type(ch)
                    page.wait_for_timeout(70)
                page.wait_for_timeout(1200)
                save = page.get_by_role("button", name="保存标注").first
                if save.count() == 0:
                    save = page.get_by_role("button", name="确认提交").first
                # 提交时顺手记下这条标注的 id，录完删掉，别把测试数据留在真会话里
                with page.expect_response(
                    lambda r: "/annotations" in r.url and r.request.method == "POST",
                    timeout=20000,
                ) as resp:
                    save.click()
                aid = re.search(r"/api/artifacts/([^/]+)/annotations", resp.value.url)
                try:
                    payload = resp.value.json()
                except Exception:
                    payload = {}
                nid = payload.get("id") or payload.get("annotationId")
                if aid and nid:
                    created.append((aid.group(1), str(nid)))
                page.wait_for_timeout(3500)
            except Exception as e:  # 录制过程里的可选项失败不要毁掉整段录像
                print("手绘环节跳过:", str(e)[:200])

        page.wait_for_timeout(2500)

        # 清理录出来的测试标注（必须在关浏览器之前走 API）
        for aid, nid in created:
            if args.keep_note:
                continue
            try:
                page.request.delete(f"{args.url.rstrip('/')}/api/artifacts/{aid}/annotations/{nid}")
                print(f"已清理测试标注 {aid}/{nid}")
            except Exception as e:
                print("清理标注失败:", str(e)[:120])

        page.close()
        raw_video = pathlib.Path(page.video.path())
        ctx.close()
        browser.close()

        poster = out.with_suffix(".jpg")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(raw_video),
             "-vf", "fps=30,scale=1280:-2", "-c:v", "libx264", "-profile:v", "high",
             "-pix_fmt", "yuv420p", "-crf", str(args.crf), "-movflags", "+faststart",
             "-an", str(out)],
            check=True, timeout=600,
        )
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", str(args.poster_at), "-i", str(out),
             "-frames:v", "1", "-q:v", "4", str(poster)],
            check=True, timeout=120,
        )

    shutil.rmtree(video_dir, ignore_errors=True)
    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0:nk=1", str(out)], capture_output=True, text=True).stdout.strip()
    print(f"成片 {out} {out.stat().st_size // 1024} KB  时长 {float(dur):.1f}s")
    print(f"封面 {poster} {poster.stat().st_size // 1024} KB")
    if errors:
        print("页面报错:", " | ".join(errors[:4]))


if __name__ == "__main__":
    main()
