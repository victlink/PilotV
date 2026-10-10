#!/usr/bin/env python3
"""生成闭环验证用的演示成果（页面 / 图片 / 视频 / PDF / 三维占位）。

    python3 scripts/make_demo_assets.py

产出在 demo/ 下，纯本地生成，不依赖任何外部素材。
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.join(os.path.dirname(HERE), "demo")

LANDING = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>成果台闭环演示落地页</title>
<style>
 body{margin:0;font:16px/1.6 system-ui,sans-serif;background:#0b1020;color:#e9eef9}
 .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
 h1{font-size:32px;margin:0 0 12px}
 .hero{background:linear-gradient(135deg,#1f6feb,#7c3aed);border-radius:16px;padding:28px}
 .kpi{display:flex;gap:16px;margin-top:24px}
 .kpi div{flex:1;background:#151c30;border-radius:12px;padding:18px}
 .kpi b{display:block;font-size:28px}
 .muted{color:#98a5c3}
 button{background:#1f6feb;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:15px}
</style></head>
<body><div class="wrap">
 <div class="hero" id="hero"><h1 id="title">成果台闭环演示</h1>
 <p id="subtitle">这条落地页用于验证「发布 → 框选标注 → 返工 → 新版本继承标注」全链路。</p>
 <button id="cta" onclick="document.getElementById('kpi').style.opacity=.5">订阅周报</button></div>
 <div class="kpi" id="kpi">
  <div><b id="k1">1,284</b><span class="muted">标注总数</span></div>
  <div><b id="k2">96%</b><span class="muted">采纳率</span></div>
  <div><b id="k3">12min</b><span class="muted">平均返工</span></div>
 </div>
</div></body></html>
"""


def make_chart_png(path: str):
    from PIL import Image, ImageDraw
    w, h = 1280, 800
    im = Image.new("RGB", (w, h), (11, 16, 32))
    d = ImageDraw.Draw(im)
    d.text((48, 40), "Weekly active agents", fill=(233, 238, 249))
    bars = [220, 340, 180, 430, 510, 380, 620, 540, 700, 760]
    bw, gap = 90, 40
    x0 = 80
    for i, v in enumerate(bars):
        x = x0 + i * (bw + gap)
        d.rectangle([x, h - 120 - v, x + bw, h - 120], fill=(31, 111, 235))
    d.line([60, h - 120, w - 60, h - 120], fill=(152, 165, 195), width=2)
    d.text((48, h - 100), "标注回流 → 返工 → 再发布（M1 闭环）", fill=(152, 165, 195))
    im.save(path, "PNG")
    print("生成", path)


def make_video(path: str):
    if os.path.isfile(path):
        print("已存在", path)
        return
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
           "-i", "color=c=#0b1020:s=960x540:d=3:r=24",
           "-vf", "drawtext=text='Artifacts Console':fontcolor=white:fontsize=40:x=(w-tw)/2:y=(h-th)/2",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", path]
    try:
        subprocess.run(cmd, check=True, timeout=120)
        print("生成", path)
    except Exception as exc:
        print("跳过视频（ffmpeg 不可用或缺 drawtext）:", exc)


def make_pdf(path: str):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (1240, 1754), (250, 250, 252))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 1240, 160], fill=(31, 111, 235))
    d.text((60, 60), "成果台 · 评审纪要", fill=(255, 255, 255))
    for i in range(14):
        d.rectangle([60, 240 + i * 46, 60 + 520 - (i % 4) * 90, 258 + i * 46],
                    fill=(203, 213, 225))
    d.text((60, 1000), "Open issues: 3", fill=(148, 163, 184))
    im.save(path, "PDF", resolution=150)
    print("生成", path)


def main():
    os.makedirs(DEMO, exist_ok=True)
    html_path = os.path.join(DEMO, "landing.html")
    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(LANDING)
    print("生成", html_path)
    make_chart_png(os.path.join(DEMO, "chart.png"))
    make_video(os.path.join(DEMO, "clip.mp4"))
    make_pdf(os.path.join(DEMO, "spec.pdf"))
    glb = os.path.join(DEMO, "widget.glb")
    if not os.path.isfile(glb):
        # 最小合法 GLB（空场景），只为验证 model3d 分支能登记并渲染占位缩略图
        import struct
        js = struct.pack("<III", 0x4E4F534A, 2, 12 + 8)
        js += struct.pack("<II", 0, 0)
        json_chunk = b'{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[]}]}'
        json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
        js += struct.pack("<I", len(json_chunk)) + b"JSON" + json_chunk
        bin_data = b"\x00\x00\x00\x00"
        js += struct.pack("<I", len(bin_data)) + b"BIN\x00" + bin_data
        total = 12 + len(js)
        glb_hdr = b"glTF" + struct.pack("<II", 2, total)
        with open(glb, "wb") as fh:
            fh.write(glb_hdr + js)
        print("生成", glb)
    else:
        print("已存在", glb)


if __name__ == "__main__":
    sys.exit(main())
