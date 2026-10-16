#!/usr/bin/env python3
"""复现：PilotV logo 成果为什么进不了成果台。

对仓库里现存的 logo 相关产物逐个跑 artifacts_deliver.classify()，
看 verdict 是 final 还是 aux；aux 的会直接被丢弃（不发布）。

用法：
    python3 scripts/repro_logo_aux.py [根目录]
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import artifacts_console as console  # noqa: E402
import artifacts_deliver as deliver  # noqa: E402

# 只看 logo / 品牌相关产物，其余噪音太大。
TARGET_SUFFIX = (".svg", ".png", ".html", ".pdf", ".glb", ".mp4")
SKIP_DIR_PARTS = {".git", "node_modules", "__pycache__", "dist", "build"}


def main() -> int:
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else
                           os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    rows = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIR_PARTS and not d.startswith(".")]
        for name in sorted(filenames):
            ext = os.path.splitext(name)[1].lower()
            if ext not in TARGET_SUFFIX:
                continue
            if not any(k in name.lower() or k in dirpath.lower()
                       for k in ("logo", "brand", "icon", "pilotv", "mark")):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            kind = console.KIND_BY_EXT.get(ext)
            if kind is None:
                rows.append((rel, "—", "不在 KIND_BY_EXT 里（watcher/导入根本不会扫）"))
                continue
            verdict, why = deliver.classify(kind, full)
            rows.append((rel, verdict, f"[{kind}] {why}"))

    final = [r for r in rows if r[1] == "final"]
    lost = [r for r in rows if r[1] != "final"]
    print(f"扫描到 {len(rows)} 个 logo/品牌类产物：final {len(final)}，被丢弃 {len(lost)}\n")
    print("--- 会被丢弃（成果页面看不到的就是这些）---")
    for rel, verdict, why in lost:
        print(f"  {verdict:4}  {rel}\n        {why}")
    print("\n--- 能进成果台 ---")
    for rel, verdict, why in final:
        print(f"  {verdict:5} {rel}\n        {why}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
