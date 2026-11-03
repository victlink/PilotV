#!/usr/bin/env python3
"""把成果台里的真实过程视频转成网页能直接播的 mp4 + webp 封面。

源片是成果台（127.0.0.1:8799）里 PilotV 真跑出来的交付物：1080p60、无音轨，
网页上没必要 60 帧，统一降到 720p30 + crf30 + faststart。
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

BASE = pathlib.Path("/tmp/vids")
OUT = pathlib.Path("/home/marc/PilotV/site/assets")

# (源文件, 输出名, 中文名)
CLIPS = [
    ("art_69fbb9.mp4", "cad-model-build", "建模"),
    ("art_8d2df7.mp4", "cad-verify", "验证"),
    ("art_218df5.mp4", "cad-delivery", "交付"),
    ("art_e39cde.mp4", "cad-report", "报告"),
    ("art_862ece.mp4", "cad-freecad-start", "开工"),
]


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print("失败:", " ".join(cmd[:6]), proc.stderr[-400:])
        sys.exit(1)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for src, name, label in CLIPS:
        src_path = BASE / src
        if not src_path.exists():
            print("缺源片，跳过:", src_path)
            continue
        mp4 = OUT / f"{name}.mp4"
        webp = OUT / f"{name}.webp"
        run(["ffmpeg", "-y", "-i", str(src_path),
             "-vf", "scale=1280:720:flags=lanczos,fps=30",
             "-c:v", "libx264", "-preset", "slow", "-crf", "30",
             "-pix_fmt", "yuv420p", "-profile:v", "main", "-movflags", "+faststart",
             "-an", str(mp4)])
        # 封面取第 1/4 处，避开开头黑场
        dur = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(mp4)],
            capture_output=True, text=True).stdout.strip())
        at = max(1.0, round(dur * 0.28, 2))
        run(["ffmpeg", "-y", "-ss", str(at), "-i", str(mp4), "-frames:v", "1",
             "-vf", "scale=800:-2", "-c:v", "libwebp", "-quality", "76",
             "-compression_level", "6", str(webp)])
        size_kb = mp4.stat().st_size // 1024
        print(f"{label:4s} {mp4.name:22s} {size_kb:5d}KB  封面 {webp.stat().st_size // 1024:4d}KB  {at}s")


if __name__ == "__main__":
    main()
