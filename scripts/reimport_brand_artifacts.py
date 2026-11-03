#!/usr/bin/env python3
"""把仓库里的品牌交付物重新导入本机成果台。

背景：logo 成果曾经整批卡在 artifacts_deliver.classify() 的 aux 判定上，
发布时直接被拒，从未进过成果库 —— 库里是空的，不是被删了。所以这不是恢复
旧记录，是按新规则重新发一遍。

范围：只导「正式品牌交付物」。review/ 下的调试图、e2e 夹具、vendor 源码
不算成果 —— 导进去左栏会被截图淹掉（项目注释里记过这个教训）。

用法：
    python3 scripts/reimport_brand_artifacts.py --dry-run
    python3 scripts/reimport_brand_artifacts.py --yes
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from list_reimport_candidates import candidates  # noqa: E402

TOKEN_FILE = os.path.expanduser("~/.config/pilotv-artifacts/token")
API = os.environ.get("ARTIFACTS_API", "http://127.0.0.1:8799")

# 这些目录是调试图 / 测试夹具 / 上游 vendor 源码，不是交付物
EXCLUDE_PREFIXES = ("review/", "pilotdeck-mobile/review/", "pilotdeck-mobile/upstream-official/src/")


def is_deliverable(path: str) -> bool:
    if path.startswith(EXCLUDE_PREFIXES) or "/review/" in path or "/e2e/fixtures/" in path:
        return False
    return True


def post(payload: dict) -> tuple[int, dict]:
    with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
        token = fh.read().strip()
    req = urllib.request.Request(
        f"{API}/api/artifacts/import",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只让服务端判一遍，不真写库")
    ap.add_argument("--yes", action="store_true", help="确认真写库")
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    a = ap.parse_args()
    if not a.dry_run and not a.yes:
        print("必须显式指定 --dry-run 或 --yes")
        return 2

    root = os.path.abspath(a.root)
    rows = [r for r in candidates(root) if is_deliverable(r["path"])]
    print(f"候选（正式品牌交付物）：{len(rows)} 条")
    if not rows:
        return 0

    payload = {
        "agent": "pilotdeck",
        "dry_run": bool(a.dry_run),
        "on_conflict": "new",
        "limit": max(len(rows) + 10, 200),
        "items": [{"path": os.path.join(root, r["path"]), "kind": r["kind"],
                   "title": r["title"], "agent": "pilotdeck"} for r in rows],
    }

    st, res = post(payload)
    print(f"HTTP {st}")
    if st != 200:
        print(json.dumps(res, ensure_ascii=False)[:800])
        return 1

    print("汇总：", json.dumps(res.get("summary", {}), ensure_ascii=False))
    for bucket in ("imported", "skipped", "conflicts", "failed"):
        items = res.get(bucket) or []
        if not items:
            continue
        print(f"\n{bucket}（{len(items)}）：")
        kinds = collections.Counter(i.get("kind") for i in items if i.get("kind"))
        print("  类型分布：", dict(kinds))
        for it in items[:12]:
            title = it.get("title") or os.path.basename(it.get("path", ""))
            note = it.get("reason") or it.get("id") or ""
            print(f"    {title[:52]:54} {note}")
        if len(items) > 12:
            print(f"    … 还有 {len(items) - 12} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
