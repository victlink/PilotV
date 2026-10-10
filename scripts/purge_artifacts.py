#!/usr/bin/env python3
"""清空成果台正式数据目录里的全部成果（记录 + 物化文件 + 测试脚手架）。

背景：.artifacts-data 里 416 条成果全部是本项目回归脚本造的测试件
（import 193 / publish_artifact 111 / verify_loop 96），没有一条真实产出。
用户已明确授权「直接删除」。

刻意保留（不是成果数据，删了会牵连别的东西）：
  chrome-profile/   176M 浏览器 profile，诊断截图用的
  diag/             诊断截图与日志
  *.pid / *.log     sidecar / 端口转发的运行时文件
  artifacts.db      数据库文件本身（只清表，不删文件 —— 删了要重建 schema）

用法：
  python3 scripts/purge_artifacts.py --dry-run   # 只列清单
  python3 scripts/purge_artifacts.py --yes       # 真删（先备份到 /tmp）
"""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, ".artifacts-data")
DB = os.path.join(DATA, "artifacts.db")

# 不属于成果数据、不参与清理
KEEP_PREFIX = ("chrome-profile", "diag")
KEEP_NAME = {"sidecar.pid", "sidecar.log", "forward-8899.pid", "forward-8899.log",
             "artifacts.db", "artifacts.db-wal", "artifacts.db-shm"}
# 一定清：物化文件与缩略图
ALWAYS = {"files", "thumbs"}


def targets() -> list[str]:
    out = []
    for name in sorted(os.listdir(DATA)):
        if name in KEEP_NAME or name.startswith(KEEP_PREFIX):
            continue
        if name in ALWAYS:
            out.append(name)
            continue
        # 其余是回归脚手架：probe-* dbg-* anno-* m3-* m3ui-* watch-fixture* reanchor-* shots
        if any(name.startswith(p) for p in
               ("probe-", "dbg-", "anno-", "m3-", "m3ui-", "watch-fixture",
                "reanchor-", "shots", "uploads")):
            out.append(name)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="真删；不给就只列清单")
    ap.add_argument("--backup", default="/tmp/artifacts-purge-backup")
    args = ap.parse_args()

    if not os.path.isdir(DATA):
        print(f"没有 {DATA}", file=sys.stderr)
        return 1

    tgt = targets()
    print(f"数据目录 {DATA}")
    print(f"将清理 {len(tgt)} 个目录：" + ", ".join(tgt))
    con = sqlite3.connect(DB)
    before = {t: con.execute(f"select count(*) from {t}").fetchone()[0]
              for t in ("artifacts", "annotations", "audit", "watch_sources")}
    print("将清空的表（当前行数）：" + ", ".join(f"{k}={v}" for k, v in before.items()))
    con.close()
    print("保留：" + ", ".join(KEEP_PREFIX) + "、*.pid、*.log、artifacts.db")

    if not args.yes:
        print("\n（--dry-run：什么都没删）")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = f"{args.backup}-{stamp}"
    os.makedirs(bak, exist_ok=True)
    print(f"\n[1/4] 备份到 {bak}")
    con = sqlite3.connect(DB)
    with open(os.path.join(bak, "artifacts.db.sql"), "w", encoding="utf-8") as fh:
        fh.write(con.execute("select group_concat(sql) from sqlite_master").fetchone()[0] or "")
    for t in before:
        with open(os.path.join(bak, f"{t}.json"), "w", encoding="utf-8") as fh:
            rows = con.execute(f"select * from {t}").fetchall()
            fh.write(repr(rows))
    con.close()
    for name in ("files", "thumbs"):
        src = os.path.join(DATA, name)
        if os.path.isdir(src):
            with tarfile.open(os.path.join(bak, f"{name}.tar"), "w") as tf:
                tf.add(src, arcname=name)
    print(f"      备份完成（{sum(os.path.getsize(os.path.join(bak, f)) for f in os.listdir(bak))//1024} KB）")

    print("[2/4] 清表")
    con = sqlite3.connect(DB)
    con.execute("pragma foreign_keys=off")
    for t in ("annotations", "watch_sources", "audit", "artifacts"):
        con.execute(f"delete from {t}")
    con.commit()
    con.execute("vacuum")
    after = {t: con.execute(f"select count(*) from {t}").fetchone()[0] for t in before}
    con.close()
    print("      清完行数：" + ", ".join(f"{k}={v}" for k, v in after.items()))

    print("[3/4] 删目录")
    freed = 0
    for name in tgt:
        p = os.path.join(DATA, name)
        if os.path.isdir(p):
            freed += int(subprocess.run(["du", "-sk", p], capture_output=True,
                                        text=True).stdout.split()[0]) * 1024
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p):
            freed += os.path.getsize(p)
            os.remove(p)
    print(f"      释放约 {freed // 1024 // 1024} MB")

    print("[4/4] 收尾")
    print(f"      数据目录现为 {sum(os.path.getsize(os.path.join(DATA, f)) for f in os.listdir(DATA) if os.path.isfile(os.path.join(DATA, f))) // 1024} KB（仅剩 db 与日志）")
    print(f"      备份留在 {bak}，确认没问题后可自行删除")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())