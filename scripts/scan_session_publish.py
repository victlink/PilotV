#!/usr/bin/env python3
"""只读：把会话 JSONL 里的工具调用抽出来，找「发布成果」类动作是否真发生过。

只统计真实 tool call（type=tool_use / accepted_input 里的 tool 调用），
不把助手正文里写的方案文字当成已执行动作 —— 交接文档里满篇 publish_artifact，
但那是计划文本，不是发布记录。

用法：
    python3 scripts/scan_session_publish.py <session.jsonl> [关键词...]
"""
from __future__ import annotations

import json
import sys
from collections import Counter

PUBLISH_HINTS = ("publish", "artifact", "artifacts-console", "publish_artifact")


def iter_records(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def tool_calls(rec):
    """从一条记录里挖出所有工具调用。"""
    out = []
    msgs = rec.get("messages")
    if isinstance(msgs, list):
        for m in msgs:
            if not isinstance(m, dict):
                continue
            for part in m.get("content") or []:
                if isinstance(part, dict) and part.get("type") in ("tool_use", "tool_call"):
                    out.append(part)
    for key in ("toolCalls", "tools", "tool_calls"):
        for t in rec.get(key) or []:
            if isinstance(t, dict):
                out.append(t)
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    hints = [h.lower() for h in sys.argv[2:]] or list(PUBLISH_HINTS)

    names = Counter()
    matched = []
    n_rec = 0
    for rec in iter_records(path):
        n_rec += 1
        for call in tool_calls(rec):
            name = str(call.get("name") or call.get("toolName") or "?")
            names[name] += 1
            blob = json.dumps(call, ensure_ascii=False)
            if any(h in blob.lower() or h in name.lower() for h in hints):
                matched.append((name, blob[:400]))

    print(f"记录数 {n_rec}，工具调用总数 {sum(names.values())}")
    print("\n== 工具调用分布（前 40）==")
    for k, v in names.most_common(40):
        print(f"  {k:<42} {v}")

    print(f"\n== 与 {hints} 相关的调用 {len(matched)} 次 ==")
    for name, blob in matched[:30]:
        print(f"\n--- {name}\n{blob}")
    return 0


if __name__ == "__main__":
    sys.exit(main())