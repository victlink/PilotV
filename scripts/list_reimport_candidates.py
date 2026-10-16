#!/usr/bin/env python3
"""列出「按新规则现在能进成果台」的 logo 成果，供人工确认后再真导入。

为什么不直接导：往成果台写东西是不可逆的。项目自己的注释记着一次教训 ——
目录导入把整个站点灌进去，左栏被几百条 shot.png 淹没。所以先把名单打出来，
确认过再发。

用法：
    python3 scripts/list_reimport_candidates.py            # 只统计，按目录分组
    python3 scripts/list_reimport_candidates.py --json     # 机器可读
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import artifacts_console as console  # noqa: E402
import artifacts_deliver as deliver  # noqa: E402

TARGET_SUFFIX = (".svg", ".png", ".html", ".pdf", ".glb", ".mp4")
SKIP_DIR_PARTS = {".git", "node_modules", "__pycache__", "dist", "build"}
KEYWORDS = ("logo", "brand", "icon", "pilotv", "mark")


def candidates(root: str) -> list[dict]:
    rows = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIR_PARTS and not d.startswith(".")]
        for name in sorted(filenames):
            ext = os.path.splitext(name)[1].lower()
            if ext not in TARGET_SUFFIX:
                continue
            full = os.path.join(dirpath, name)
            low = (name + dirpath).lower()
            if not any(k in low for k in KEYWORDS):
                continue
            kind = console._kind_for(full, ext)
            verdict, why = deliver.classify(kind, full)
            if verdict != "final":
                continue
            rows.append({
                "path": os.path.relpath(full, root),
                "kind": kind,
                "title": os.path.splitext(name)[0],
                "bytes": os.path.getsize(full),
            })
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?",
                    default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rows = candidates(os.path.abspath(a.root))
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    by_dir = collections.Counter(os.path.dirname(r["path"]) or "." for r in rows)
    by_kind = collections.Counter(r["kind"] for r in rows)
    total_mb = sum(r["bytes"] for r in rows) / 1024 / 1024

    print(f"现在能进成果台的 logo/品牌类成果：{len(rows)} 个，合计 {total_mb:.1f} MB")
    print("按类型：", dict(by_kind))
    print()
    print("按目录（条数 / 合计 MB）：")
    for d, n in by_dir.most_common():
        mb = sum(r["bytes"] for r in rows if (os.path.dirname(r["path"]) or ".") == d) / 1024 / 1024
        print(f"  {n:4}  {mb:6.1f}  {d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
