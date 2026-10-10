#!/usr/bin/env python3
"""调试用：打印成果台数据库现状（物化状态 / 标注 / 审计）。"""
import json
import os
import sqlite3
import sys

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   ".artifacts-data", "artifacts.db")
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 8
for r in db.execute("SELECT id,kind,status,stored_path,thumb_path,meta_json FROM artifacts "
                    "ORDER BY ts DESC, rowid DESC LIMIT ?", (limit,)):
    d = dict(r)
    print(f"{d['id']} {d['kind']:8s} {d['status']:8s} "
          f"file={'Y' if d['stored_path'] else '-'} thumb={'Y' if d['thumb_path'] else '-'} "
          f"meta={d['meta_json'][:120]}")
print("--- annotations ---")
for r in db.execute("SELECT artifact_id,seq,severity,status,carried_from,substr(body,1,24) b "
                    "FROM annotations ORDER BY rowid DESC LIMIT 10"):
    print(dict(r))
