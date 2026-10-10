#!/usr/bin/env python3
"""只读：解析 purge 备份里的 artifacts.json，统计每条成果的归属与来源。

purge_artifacts.py 备份的是 `repr(rows)`，这里用 ast.literal_eval 反序列化。
用法：
    python3 scripts/inspect_purge_backup.py [/tmp/artifacts-purge-backup-XXXX]
"""
from __future__ import annotations

import ast
import os
import sys
from collections import Counter

COLS = ["id", "run_id", "agent", "kind", "title", "sub", "version", "parent_id",
        "status", "project", "stored_path", "file_name", "mime", "size",
        "thumb_path", "html_url", "meta_json", "source_json", "ts", "updated_at"]


def load_rows(path):
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read().strip()
    return ast.literal_eval(raw)


def main() -> int:
    d = sys.argv[1] if len(sys.argv) > 1 else None
    if not d:
        cands = sorted((os.path.join("/tmp", n) for n in os.listdir("/tmp")
                        if n.startswith("artifacts-purge-backup")), reverse=True)
        if not cands:
            print("找不到 /tmp/artifacts-purge-backup*")
            return 2
        d = cands[0]
    print(f"备份目录 {d}")
    rows = load_rows(os.path.join(d, "artifacts.json"))
    print(f"成果条数 {len(rows)}")
    print()

    print("== agent 分布 ==")
    for k, v in Counter(r[2] for r in rows).most_common():
        print(f"  {k!r:<28} {v}")
    print()

    print("== kind 分布 ==")
    for k, v in Counter(r[3] for r in rows).most_common():
        print(f"  {k!r:<20} {v}")
    print()

    print("== project 分布 ==")
    for k, v in Counter((r[9] or "") for r in rows).most_common(15):
        print(f"  {k!r:<46} {v}")
    print()

    print("== run_id 非空且能对上某个会话的 ==")
    pc = [r for r in rows if "PilotCode" in (r[9] or "") or "PilotCode" in (r[17] or "")]
    print(f"带 PilotCode 字样的成果 {len(pc)} 条")
    for r in pc[:20]:
        print(f"  {r[0][:38]:<40} run_id={r[1]!r} kind={r[3]} title={(r[4] or '')[:40]!r}")
    print()

    print("== run_id 为空的比例 ==")
    empty = sum(1 for r in rows if not r[1])
    print(f"  空 run_id {empty}/{len(rows)}")
    print()

    print("== 最近 15 条（按 updated_at）==")
    for r in sorted(rows, key=lambda x: (x[19] or x[18] or ""), reverse=True)[:15]:
        print(f"  {(r[19] or r[18] or '')[:19]}  {r[0][:26]:<28} agent={r[2]!r:<14} kind={r[3]:<10} {(r[4] or '')[:36]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
