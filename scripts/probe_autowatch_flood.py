#!/usr/bin/env python3
"""自动收录「历史回灌」干跑：只统计会收什么，不写任何数据。

回答一个问题：如果现在就用默认配置（ARTIFACTS_SESSION_BACKFILL=1）上线，
第一轮会把历史 transcript 里的多少个文件收进成果台？会不会把成果台灌爆？

全程只读：store 指向临时目录，真实 ARTIFACTS_DATA_DIR 不碰。
用法: python3 scripts/probe_autowatch_flood.py
"""
from __future__ import annotations

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

PILOT = os.environ.get("PILOTDECK_HOME") or os.path.expanduser("~/.pilotdeck")

os.environ["PILOTDECK_HOME"] = PILOT
tmp = tempfile.mkdtemp(prefix="flood-probe-")
os.environ["ARTIFACTS_DATA_DIR"] = os.path.join(tmp, "data")

import artifacts_console as c          # noqa: E402
import artifacts_store                  # noqa: E402

store = artifacts_store.ArtifactStore(os.environ["ARTIFACTS_DATA_DIR"])
ing = c.SessionIngester(store, lambda aid: None, interval=999)

rows_total = 0
files_total = 0
reasons: dict[str, int] = {}


def tally(reason: str) -> None:
    reasons[reason] = reasons.get(reason, 0) + 1


for path, sid, cwd in ing._iter_transcripts():
    # 绕过增量游标，全量读（干跑的目的就是看全量有多少）
    ing._state[path] = [0]
    for row in ing._read_new_rows(path):
        rows_total += 1
        for e in row.get("artifacts") or []:
            files_total += 1
            name = e.get("name") or ""
            rel = e.get("path") or name
            ext = os.path.splitext(name)[1].lower()
            if ext not in c.KIND_BY_EXT:
                tally("扩展名不是成果类型")
                continue
            src = rel if os.path.isabs(rel) else os.path.join(cwd, rel)
            if not os.path.isfile(src):
                tally("文件已不存在")
                continue
            try:
                if os.path.getsize(src) < ing.min_bytes:
                    tally("小于 min_bytes")
                    continue
            except OSError:
                tally("stat 失败")
                continue
            v, why = c._classify(c.KIND_BY_EXT[ext], src)
            tally("判定 final（会被收录）" if v == "final" else f"判定 aux: {why[:40]}")

print(f"transcripts : {len(ing._state)}")
print(f"file_artifacts 行: {rows_total}")
print(f"记录的条目数     : {files_total}\n")
for reason, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
    print(f"  {n:5d}  {reason}")
print(f"\n=> 首轮回灌会新增 {reasons.get('判定 final（会被收录）', 0)} 条成果")
print(f"   (临时数据目录 {tmp})")
