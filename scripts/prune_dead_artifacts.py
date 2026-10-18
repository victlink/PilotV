#!/usr/bin/env python3
"""清理来源文件已不存在的成果（默认 dry-run，--apply 才真删）。

只删「没有会话归属 + 来源文件已不在磁盘」的那一批：brand/ 迁走后剩下的 6 条 svg。
有归属的成果即使来源文件挪了位置也不动 —— 归属还是对的，只是文件换了个地方，
那是另一回事，不该在这里顺手删掉用户的成果。

用法：
    python3 scripts/prune_dead_artifacts.py            # 只看会删什么
    python3 scripts/prune_dead_artifacts.py --apply    # 真删（先自动备份）
"""
import argparse
import json
import os
import shutil
import sqlite3
import sys
import time

DB = os.path.expanduser(os.environ.get(
    "ARTIFACTS_DB", "~/pilotv-artifacts/data/artifacts.db"))
# 一并清掉的从表（都不带自己的主键约束，得手工跟着删）
CHILD_TABLES = ("annotations", "audit", "watch_sources")


def source_path(row) -> str:
    try:
        return (json.loads(row["source_json"] or "{}") or {}).get("path") or ""
    except Exception:
        return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真删（默认只报告）")
    ap.add_argument("--db", default=DB)
    args = ap.parse_args()

    if not os.path.isfile(args.db):
        print(f"找不到成果库：{args.db}")
        return 1

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row

    # 只看「无归属」：有归属的成果即便来源挪了位置也留着
    rows = con.execute(
        "SELECT id, run_id, file_name, mime, source_json, stored_path, ts "
        "FROM artifacts WHERE run_id IS NULL OR run_id=''").fetchall()

    dead, alive = [], []
    for r in rows:
        p = source_path(r)
        # stored_path 是成果台自己的副本；优先看原始来源路径
        (alive if (p and os.path.exists(p)) else dead).append((r, p))

    owned_dead = con.execute(
        "SELECT id, file_name FROM artifacts WHERE run_id IS NOT NULL AND run_id<>''").fetchall()
    owned_gone = []
    for r in owned_dead:
        try:
            p = (json.loads(r["source_json"] or "{}") or {}).get("path") or ""
        except Exception:
            p = ""
        if p and not os.path.exists(p):
            owned_gone.append((r, p))

    deleted_state = con.execute(
        "SELECT count(*) FROM artifacts WHERE status='deleted'").fetchone()[0]

    print(f"成果库：{args.db}")
    print(f"无归属成果 {len(rows)} 条 → 来源仍在 {len(alive)} / 来源已消失 {len(dead)}")
    print(f"（另有标记为 deleted 的成果 {deleted_state} 条，未计入）\n")

    if dead:
        print("将删除（无归属 + 来源文件已不存在）：")
        for r, p in dead:
            print(f"  {r['id']}  {str(r['file_name'])[:34]:36s} {r['mime'][:22]:24s} {p}")
    else:
        print("没有可清理的条目。")

    if owned_gone:
        print(f"\n另有 {len(owned_gone)} 条【有归属】成果的来源文件也不在了 —— 一律不动：")
        for r, p in owned_gone[:10]:
            print(f"  {r['id']}  {str(r['file_name'])[:30]:32s} {p[:70]}")

    if not args.apply:
        print("\n这是 dry-run。加 --apply 才会真删。")
        con.close()
        return 0

    if not dead:
        print("\n没有要删的，退出。")
        con.close()
        return 0

    ids = [r["id"] for r, _ in dead]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{args.db}.bak-prune-{stamp}"
    shutil.copy2(args.db, backup)
    print(f"\n已备份：{backup}")

    con.execute("BEGIN")
    qmarks = ",".join("?" * len(ids))
    for t in CHILD_TABLES:
        cur = con.execute(f"DELETE FROM {t} WHERE artifact_id IN ({qmarks})", ids)
        print(f"  {t}: 删 {cur.rowcount} 行")
    cur = con.execute(f"DELETE FROM artifacts WHERE id IN ({qmarks})", ids)
    print(f"  artifacts: 删 {cur.rowcount} 行")
    con.commit()
    con.execute("VACUUM")
    print(f"\n完成。剩余成果 {con.execute('SELECT count(*) FROM artifacts').fetchone()[0]} 条")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
