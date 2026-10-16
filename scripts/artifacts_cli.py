#!/usr/bin/env python3
"""成果台 CLI —— agent 侧的零依赖入口（MCP 不可用时的兜底）。

    python3 scripts/artifacts_cli.py publish --kind page --title "落地页" --path src/index.html --url http://127.0.0.1:3001/
    python3 scripts/artifacts_cli.py publish --kind image --title "配图 v2" --path out/hero.png --parent art_ab12cd
    python3 scripts/artifacts_cli.py feedback art_ab12cd
    python3 scripts/artifacts_cli.py resolve art_ab12cd art_ab12cd-n1
    python3 scripts/artifacts_cli.py list --kind image --limit 20
    python3 scripts/artifacts_cli.py show art_ab12cd
    python3 scripts/artifacts_cli.py chain art_ab12cd
    python3 scripts/artifacts_cli.py status art_ab12cd approved
    python3 scripts/artifacts_cli.py import out/ --agent opencode --dry-run

只用标准库 urllib —— agent 环境里不一定装了 requests。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("ARTIFACTS_BASE", "http://127.0.0.1:8799")
TOKEN = os.environ.get("ARTIFACTS_TOKEN", "")


def call(method: str, path: str, payload=None):
    url = BASE.rstrip("/") + path
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8")
            return r.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": body[:300]}
    except Exception as exc:  # 连接不上等
        return 0, {"error": f"{type(exc).__name__}: {exc}",
                   "hint": f"确认成果台在 {BASE}（cd {os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}）"}


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main():
    global BASE
    ap = argparse.ArgumentParser(prog="artifacts_cli", description="成果台 agent 侧 CLI")
    ap.add_argument("--base", default=BASE)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("publish", help="发布成果；--parent 表示返工发新版本")
    p.add_argument("--kind", required=True,
                   choices=["page", "image", "video", "drawing", "model3d", "doc"])
    p.add_argument("--title", required=True)
    p.add_argument("--path", default="", help="产物文件（相对路径按 cwd 解析，服务端会复制一份）")
    p.add_argument("--url", default="", help="page 类的真机预览地址")
    p.add_argument("--parent", default="", help="被返工的成果 id（填了就是新版本，标注自动继承）")
    p.add_argument("--sub", default="", help="副标题：改了什么")
    p.add_argument("--run-id", default="")
    p.add_argument("--agent", default="pilotdeck")
    p.add_argument("--project-root", default="", help="相对 path 的解析根，默认用当前目录")
    p.add_argument("--compare-group", default="",
                   help="声明这几份是多结果对比（同一个串），成果列表会整组保留而不收成最后一份")

    p = sub.add_parser("import", help="把一整个目录的产出一次性导入（去重 + 冲突提示）")
    p.add_argument("path", help="目录，或含 --item 时的任意占位串")
    p.add_argument("--agent", default="external", help="成果归属的 agent 名，默认 external")
    p.add_argument("--on-conflict", default="skip", choices=["skip", "version", "new"],
                   help="同名不同内容怎么办：skip 不动 / version 开新版本 / new 另起一条")
    p.add_argument("--dry-run", action="store_true", help="只看会导什么，不写库")

    p = sub.add_parser("feedback", help="取未解决的返工意见")
    p.add_argument("id")
    p.add_argument("--status", default="open", choices=["open", "resolved"])

    p = sub.add_parser("resolve", help="把一条标注置为已解决")
    p.add_argument("id")
    p.add_argument("note_id")
    p.add_argument("--author", default="agent")

    p = sub.add_parser("list", help="列成果")
    p.add_argument("--kind", default="")
    p.add_argument("--status", default="")
    p.add_argument("--agent", default="", help="只看某个 agent 的成果（多 agent 同流时用）")
    p.add_argument("--limit", type=int, default=50)

    p = sub.add_parser("show", help="看单个成果（含标注）")
    p.add_argument("id")

    p = sub.add_parser("chain", help="版本链与版本间 diff")
    p.add_argument("id")

    p = sub.add_parser("status", help="改评审状态")
    p.add_argument("id")
    p.add_argument("status", choices=["pending", "ready", "reviewing", "approved", "rework", "rejected"])
    p.add_argument("--note", default="")

    p = sub.add_parser("diff", help="两版差异：解决掉的 / 没解决的 / 源码改了什么")
    p.add_argument("id", help="新版 id")
    p.add_argument("--from", dest="from_id", default="", help="旧版 id，默认链上上一版")

    p = sub.add_parser("wait", help="挂机等返工；没人返工就超时返回，去干别的")
    p.add_argument("--id", default="", help="盯某条成果；不填则只等下一件新返工")
    p.add_argument("--timeout", type=int, default=25)

    p = sub.add_parser("audit", help="审计流水")
    p.add_argument("--id", default="")
    p.add_argument("--limit", type=int, default=30)

    args = ap.parse_args()
    BASE = args.base

    if args.cmd == "publish":
        body = {"kind": args.kind, "title": args.title, "path": args.path,
                "url": args.url, "parent_id": args.parent, "sub": args.sub,
                "run_id": args.run_id, "agent": args.agent,
                "project_root": args.project_root or os.getcwd(),
                "compare_group": args.compare_group,
                "tool": "artifacts_cli"}
        status, data = call("POST", "/api/artifacts", body)
        if status == 200:
            print(f"已发布 {data['id']} v{data['version']}  →  {data['review_url']}")
            if data.get("artifact", {}).get("open_notes"):
                print(f"继承未解决标注 {data['artifact']['open_notes']} 条")
        out(data)
        return 0 if status == 200 else 1

    if args.cmd == "feedback":
        status, data = call("GET", f"/api/artifacts/{args.id}/feedback?status={args.status}")
        if status == 200:
            if not data["annotations"]:
                print("没有待处理的意见")
            for n in data["annotations"]:
                print(f"[{n['seq']}] {n['severity']:<7} {n['body']}"
                      + (f"  anchor={json.dumps(n['anchor'], ensure_ascii=False)}" if n.get("anchor") else ""))
            print(f"共 {data['count']} 条（成果 {args.id} v{data['version']}）")
        else:
            out(data)
        return 0 if status == 200 else 1

    if args.cmd == "resolve":
        status, data = call("PATCH", f"/api/artifacts/{args.id}/annotations/{args.note_id}",
                            {"status": "resolved", "author": args.author})
        out(data)
        return 0 if status == 200 else 1

    if args.cmd == "import":
        payload = {"dir": os.path.abspath(args.path), "agent": args.agent,
                   "on_conflict": args.on_conflict, "dry_run": args.dry_run}
        status, data = call("POST", "/api/artifacts/import", payload)
        if status == 200:
            verb = "将要导入" if args.dry_run else "导入"
            for i in data["imported"]:
                print(f"  {verb} {i['kind']:<7} {i['title']}"
                      + (f"  → {i['id']} v{i['version']}" if i.get("id") else ""))
            for s_ in data["skipped"]:
                print(f"  跳过 {s_['title']} —— {s_['reason']}")
            for c in data["conflicts"]:
                print(f"  冲突 {c['title']}：{c['reason']}"
                      f"（已有 {c['existing_id']} v{c['existing_version']}，处理方式 {c.get('action', 'skip')}）")
            for f_ in data["failed"]:
                print(f"  失败 {f_.get('path') or f_.get('title')}：{f_['reason']}")
            c = data["counts"]
            print(f"{'试跑' if args.dry_run else '完成'}：候选 {c['candidates']}，"
                  f"导入 {c['imported']}，跳过 {c['skipped']}，冲突 {c['conflicts']}，失败 {c['failed']}")
            return 0 if c["failed"] == 0 else 1
        out(data)
        return 1

    if args.cmd == "list":
        params = [f"limit={args.limit}"]
        if args.kind:
            params.append(f"kind={args.kind}")
        if args.status:
            params.append(f"status={args.status}")
        if args.agent:
            params.append(f"agent={urllib.parse.quote(args.agent)}")
        q = "?" + "&".join(params)
        status, data = call("GET", "/api/artifacts" + q)
        if status == 200:
            for a in data["artifacts"]:
                print(f"{a['id']} v{a['version']:<2} {a['kind']:<7} {a['status']:<9} "
                      f"[{a['agent']}] {a['title']}  ({a['open_notes']} 条待处理)")
            print(f"共 {len(data['artifacts'])} 条，总计 {data['stats']['total']}")
        else:
            out(data)
        return 0 if status == 200 else 1

    if args.cmd == "show":
        status, data = call("GET", f"/api/artifacts/{args.id}")
        out(data)
        return 0 if status == 200 else 1

    if args.cmd == "chain":
        status, data = call("GET", f"/api/artifacts/{args.id}/chain")
        if status == 200:
            for c in data["chain"]:
                print(f"v{c['version']} {c['id']} {c['status']} {c['title']}  "
                      f"未解决 {sum(1 for n in c['annotations'] if n['status']=='open')}")
            for d in data["diff"]:
                print(f"v{d['from_version']}→v{d['to_version']}: "
                      f"解决 {len(d['resolved'])} 条，新增 {len(d['added'])} 条，剩 {d['still_open']} 条")
        else:
            out(data)
        return 0 if status == 200 else 1

    if args.cmd == "diff":
        q = f"?from={args.from_id}" if args.from_id else ""
        status, data = call("GET", f"/api/artifacts/{args.id}/diff{q}")
        if status == 200:
            d = data["diff"]
            print(f"v{d['from']['version']}（{d['from']['status']}） → "
                  f"v{d['to']['version']}（{d['to']['status']}）")
            for title, tone, notes in (
                    ("已解决", "resolved", d["resolved"]),
                    ("仍未解决", "kept", d["kept_open"]),
                    ("本版新增", "new", d["new_notes"]),
                    ("没被继承", "dropped", d["dropped_open"])):
                for n in notes:
                    print(f"  [{title}] #{n['seq']} {n['body']}")
            src = d.get("source") or {}
            if src.get("available"):
                print(f"  [源码] +{src['added']} / -{src['removed']} 行")
                for line in (src.get("hunks") or [])[:40]:
                    print("    " + line)
            elif not notes and not src.get("available"):
                print("  两版没有差异")
        else:
            out(data)
        return 0 if status == 200 else 1

    if args.cmd == "wait":
        status, data = call("GET", f"/api/artifacts/wait-rework?aid={args.id}&timeout={args.timeout}")
        if status == 200 and not data.get("woke"):
            print(f"{args.timeout}s 内没人返工，去干别的。")
            return 0
        if status == 200:
            for r in data["rework"]:
                print(f"返工：{r['artifact_id']} v{r['version']} → {r['review_url']}")
                for n in r["feedback"]:
                    print(f"  [{n['severity']}] {n['body']}"
                          + (f"  anchor={json.dumps(n['anchor'], ensure_ascii=False)}"
                             if n.get("anchor") else ""))
            return 0
        out(data)
        return 1

    if args.cmd == "status":
        status, data = call("POST", f"/api/artifacts/{args.id}/status",
                            {"status": args.status, "note": args.note})
        out(data)
        return 0 if status == 200 else 1

    if args.cmd == "audit":
        if not args.id:
            print("需要 --id（审计按成果查询）")
            return 1
        status, data = call("GET", f"/api/artifacts/{args.id}/audit?limit={args.limit}")
        if status == 200:
            for e in reversed(data["audit"]):
                print(f"{e['ts']} {e['actor']:<10} {e['event']:<22} {json.dumps(e['payload'], ensure_ascii=False)[:90]}")
        else:
            out(data)
        return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
