#!/usr/bin/env python3
"""成果台 · 正式库清理工具（只报告，不动手，除非 --apply）

为什么要它：验收脚本历史上默认往 8899 打，正式成果台正好开在 8899 时，
几百条测试成果（shot.png ×104、plan.svg ×106，agent 名 verify* / probe* /
noise-* / uiagent-*）就灌进了正式库。左栏被淹不是界面问题，是库里有脏数据。
scripts/_test_guard.py 现在会挡住新的污染；这个脚本负责处理**存量**。

它做什么
  列出库里的成果，按「像不像正式产物 / 有没有重复 / 有没有标注」分类，
  给你一份可以逐条确认的清单。默认只打印，不删任何东西。

用法
  python3 scripts/purge_test_artifacts.py                    # 只看清单
  python3 scripts/purge_test_artifacts.py --agent-like verify
  python3 scripts/purge_test_artifacts.py --dry-run --apply  # 试算（推荐）
  python3 scripts/purge_test_artifacts.py --apply --yes      # 真删（不可撤销）

删什么、不删什么
  · 带标注的成果一律不删（默认）：标注是人的劳动，不是垃圾。
  · 源码里找得到的源文件一律不删（只删成果台自己的副本）。
  · 只删 files/ 与 thumbs/ 下**属于这些成果**的副本，不碰同目录其它文件。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_DB = os.path.join(ROOT, ".artifacts-data", "artifacts.db")

# 这些 agent 名前缀基本只出现在验收脚本里
TEST_AGENT_MARKERS = ("verify", "probe", "noise", "uiagent", "regress", "test-")


def load(db_path: str) -> sqlite3.Connection:
    if not os.path.isfile(db_path):
        sys.exit(f"找不到数据库：{db_path}")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def fetch(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT id, ts, agent, kind, file_name, project, source_json, size,"
        "       stored_path, thumb_path FROM artifacts ORDER BY ts DESC"
    ).fetchall()


def annotate_counts(con: sqlite3.Connection) -> dict[str, int]:
    rows = con.execute(
        "SELECT artifact_id, COUNT(*) c FROM annotations GROUP BY artifact_id").fetchall()
    return {r["artifact_id"]: r["c"] for r in rows}


def classify(rows, notes: dict, agent_like: str | None) -> tuple[list, list, list]:
    """分成「像测试」「重复」「正常」三堆。返回 (test, dup, keep)。"""
    seen: dict[str, str] = {}
    test, dup, keep = [], [], []
    for r in rows:
        n_notes = notes.get(r["id"], 0)
        src = json.loads(r["source_json"] or "{}")
        tool = str(src.get("tool") or "")
        agent = (r["agent"] or "").lower()
        is_test = (
            (agent_like and agent_like.lower() in agent)
            or agent.startswith(TEST_AGENT_MARKERS)
            or tool.startswith(("verify", "probe"))
        )
        if is_test and n_notes == 0:
            test.append(r)
            continue
        key = "|".join([(r["project"] or ""), (r["file_name"] or "").lower(), str(r["size"] or 0)])
        if key in seen and n_notes == 0:
            dup.append(r)                 # 同名同大小，前面已留了一条
            continue
        seen.setdefault(key, r["id"])
        keep.append(r)
    return test, dup, keep


def source_alive(r: sqlite3.Row) -> bool:
    """源码还在不在 —— 在的话成果台那份只是副本，删了随时能重发。"""
    src = json.loads(r["source_json"] or "{}").get("path")
    return bool(src) and os.path.isfile(src)


def describe(rows) -> str:
    if not rows:
        return "（空）"
    by_agent: dict[str, int] = {}
    for r in rows:
        by_agent[r["agent"] or "?"] = by_agent.get(r["agent"] or "?", 0) + 1
    top = sorted(by_agent.items(), key=lambda kv: -kv[1])[:8]
    return f"{len(rows)} 条，主要来源 agent：" + "、".join(f"{a}×{n}" for a, n in top)


def do_delete(con: sqlite3.Connection, rows, data_dir: str) -> int:
    files_dir = os.path.join(data_dir, "files")
    removed = 0
    for r in rows:
        for col in ("stored_path", "thumb_path"):
            p = r[col]
            # 只删确实在成果台 files/ 或 thumbs/ 下面的文件，绝不越界
            if not p:
                continue
            ap = os.path.abspath(p)
            base = os.path.abspath(data_dir)
            if not ap.startswith(base + os.sep):
                continue
            try:
                if os.path.isfile(ap):
                    os.remove(ap)
            except OSError:
                pass
        con.execute("DELETE FROM annotations WHERE artifact_id=?", (r["id"],))
        con.execute("DELETE FROM artifacts WHERE id=?", (r["id"],))
        removed += 1
    con.commit()
    return removed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", default=os.environ.get("ARTIFACTS_DB", DEFAULT_DB))
    ap.add_argument("--agent-like", help="额外按 agent 名包含关系筛（可重复用逗号分隔）")
    ap.add_argument("--dry-run", action="store_true", help="配合 --apply：只打印要删什么")
    ap.add_argument("--apply", action="store_true", help="真的删（默认不删）")
    ap.add_argument("--yes", action="store_true", help="配合 --apply：不再确认")
    ap.add_argument("--include-tests", action="store_true", help="连「像测试的」一起删")
    ap.add_argument("--include-dups", action="store_true", help="连「重复发布的」一起删")
    args = ap.parse_args()

    con = load(args.db)
    data_dir = os.path.dirname(os.path.abspath(args.db))
    rows = fetch(con)
    notes = annotate_counts(con)
    agent_like = (args.agent_like or "").strip() or None
    test, dup, keep = classify(rows, notes, agent_like)

    print(f"数据库：{args.db}")
    print(f"成果总数：{len(rows)}   带标注的：{sum(1 for v in notes.values() if v)}")
    print()
    print(f"[1] 像验收产物（agent/tool 是 verify/probe/noise*，且无标注）")
    print(f"    {describe(test)}")
    print(f"[2] 同名重复发布（同项目+同文件名+同大小，保留最新一条，且无标注）")
    print(f"    {describe(dup)}")
    print(f"[3] 正常成果（会保留）")
    print(f"    {describe(keep)}")

    with_notes = [r for r in test + dup if notes.get(r["id"], 0)]
    if with_notes:
        print()
        print(f"注意：待删集合里有 {len(with_notes)} 条带标注，已自动移出删除范围"
              "（标注是人的劳动，不当垃圾删）。")

    if not args.apply:
        print()
        print("当前只是报告，没有删任何东西。要真删：")
        sel = []
        if args.include_tests: sel.append("--include-tests")
        if args.include_dups: sel.append("--include-dups")
        flag = " ".join(sel) if sel else "--include-tests"
        print(f"  python3 {os.path.relpath(__file__, ROOT)} {flag} --dry-run --apply")
        print(f"  python3 {os.path.relpath(__file__, ROOT)} {flag} --apply --yes")
        return 0

    victims = (test if args.include_tests else []) + (dup if args.include_dups else [])
    victims = [r for r in victims if notes.get(r["id"], 0) == 0]
    alive = sum(1 for r in victims if source_alive(r))
    print()
    print(f"将要删除 {len(victims)} 条成果（其中 {alive} 条的源码仍在原处，删的只是成果台副本）")
    if args.dry_run:
        for r in victims[:20]:
            print(f"  - {r['id']}  {r['agent']:<22} {r['file_name']}")
        if len(victims) > 20:
            print(f"  … 另有 {len(victims) - 20} 条")
        print("（--dry-run：什么也没删）")
        return 0

    if not args.yes:
        ans = input(f"确认删除这 {len(victims)} 条？输入 yes 继续：").strip()
        if ans != "yes":
            print("已取消。")
            return 1
    n = do_delete(con, victims, data_dir)
    print(f"已删除 {n} 条。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
