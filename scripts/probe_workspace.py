#!/usr/bin/env python3
"""只读诊断：看 /api/artifacts/workspace 对 PilotCode 项目的会话/成果归属情况。

用法：
    python3 scripts/probe_workspace.py [--base http://127.0.0.1:8799]
输出：
    · 项目清单（会话数、hasMore）
    · PilotCode 项目下前端能看到的会话（含是否有成果）
    · 成果库里与 PilotCode 相关的成果（含 run_id / source.path）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request


def fetch(base: str, path: str):
    url = base.rstrip("/") + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("ARTIFACTS_BASE",
                                                     "http://127.0.0.1:8799"))
    ap.add_argument("--sessions", type=int, default=20,
                    help="workspace 的 sessions 参数（左栏默认一次只拿 20 条）")
    ap.add_argument("--project", default="PilotCode",
                    help="只看名字里含这个串的项目")
    args = ap.parse_args()

    ws = fetch(args.base, f"/api/artifacts/workspace?limit=400&sessions={args.sessions}")
    arts = fetch(args.base, "/api/artifacts?limit=200")

    print(f"pilot_home   = {ws.get('pilot_home')}")
    print(f"generated_at = {ws.get('generated_at')}")
    print(f"default_artifact_id = {ws.get('default_artifact_id')}")
    print(f"live_artifact_id    = {ws.get('live_artifact_id')}")
    print(f"/api/artifacts 条数 = {len(arts if isinstance(arts, list) else arts.get('artifacts', []))}")
    print()

    print("== 项目 ==")
    for p in ws.get("projects", []):
        meta = p.get("sessionMeta") or {}
        n_art = sum(len(s.get("artifacts") or []) for s in p.get("sessions") or [])
        print(f"  {p.get('name'):<46} sessions={len(p.get('sessions') or []):>3}"
              f"/{meta.get('total')} hasMore={meta.get('hasMore')}"
              f" 直属={len(p.get('artifacts') or [])} 会话内成果={n_art} live={p.get('live')}")
    print()

    target = None
    for p in ws.get("projects", []):
        if args.project.lower() in (p.get("name") or "").lower() \
           or args.project.lower() in (p.get("fullPath") or "").lower():
            target = p
            break
    if not target:
        print(f"没有名字里含 {args.project!r} 的项目")
        return 2

    print(f"== 项目详情 {target.get('name')} ({target.get('fullPath')}) ==")
    print(f"  displayName={target.get('displayName')} 直属成果={len(target.get('artifacts') or [])}")
    for s in target.get("sessions") or []:
        title = (s.get("title") or "")[:44]
        print(f"  - {s.get('id'):<44} live={s.get('live')} n={len(s.get('artifacts') or []):>3}  {title}")
    print()

    listing = arts if isinstance(arts, list) else arts.get("artifacts", [])
    print("== 成果库里的每条成果 ==")
    for a in listing:
        src = (a.get("source") or {}).get("path") or ""
        print(f"  {a.get('id'):<40} run_id={a.get('run_id')!r} kind={a.get('kind')}"
              f" project={a.get('project')!r}")
        print(f"      title={(a.get('title') or '')[:60]!r}")
        print(f"      src={src[:90]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
