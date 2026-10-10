#!/usr/bin/env python3
"""M2 验收：页面返工后，标注跟着元素走（selector 重新锚定）。

跑的是真链路，不是单测：
    发布 v1 → 打 selector 标注 → 发布改过版式的 v2 → 等物化 →
    断言继承来的标注 rect 已经量到 v2 的新位置。

    python3 scripts/verify_reanchor.py [--api http://127.0.0.1:8899]
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import artifacts_cdp  # noqa: E402

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def post(api, path, payload):
    req = urllib.request.Request(api + path, method="POST",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def get(api, path):
    with urllib.request.urlopen(api + path, timeout=20) as r:
        return json.load(r)


V1 = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>锚定验证 v1</title>
<style>body{margin:0;font:16px/1.6 system-ui;background:#0b1020;color:#e9eef9}
 .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
 .pad{height:40px;background:#1f6feb}</style></head>
<body><div class="wrap"><h1 id="title">标题</h1>
<p>第一屏说明文案。</p>
<button id="cta">提交</button></div></body></html>"""

# v2：标题区塞了一大块空白，CTA 被顶到很下面 —— 像素坐标必然失效，selector 不会
V2 = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>锚定验证 v2</title>
<style>body{margin:0;font:16px/1.6 system-ui;background:#0b1020;color:#e9eef9}
 .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
 .pad{height:520px;background:#7c3aed}</style></head>
<body><div class="wrap"><h1 id="title">标题</h1>
<div class="pad"></div>
<p>第二屏说明文案。</p>
<button id="cta">提交</button></div></body></html>"""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
    ap.add_argument("--keep", action="store_true", help="保留测试成果（默认保留，只是不删文件）")
    ap.add_argument("--force", action="store_true",
                    help="确实要写进这个数据目录（默认拒绝写正式库）")
    args = ap.parse_args()
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。护栏放在 parse_args 之后。
    try:
        assert_test_server(getattr(args, "api", None), getattr(args, "token", None) or os.environ.get("ARTIFACTS_TOKEN"), force=getattr(args, "force", False))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    api = args.api.rstrip("/")

    tmp = os.path.join(ROOT, ".artifacts-data", "reanchor-fixtures")
    os.makedirs(tmp, exist_ok=True)
    f1 = os.path.join(tmp, "v1.html")
    f2 = os.path.join(tmp, "v2.html")
    open(f1, "w", encoding="utf-8").write(V1)
    open(f2, "w", encoding="utf-8").write(V2)

    print("\n[1 发 v1]", flush=True)
    v1 = post(api, "/api/artifacts", {
        "kind": "page", "title": "锚定验证 v1", "path": f1, "agent": "verify"})
    aid1 = v1["artifact"]["id"] if "artifact" in v1 else v1.get("id")
    print(f"  v1 = {aid1}", flush=True)

    print("\n[2 给 #cta 打一条标注（rect 先随便填个错的）]", flush=True)
    post(api, f"/api/artifacts/{aid1}/annotations", {
        "body": "这个按钮文案要点", "severity": "major",
        "selector": "#cta", "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}})
    detail = get(api, f"/api/artifacts/{aid1}")
    notes = detail.get("annotations", [])
    check(len(notes) == 1, "v1 标注已入库", f"{len(notes)} 条")
    carried_rect = (notes[0].get("anchor") or {}).get("rect") if notes else None

    print("\n[3 发 v2（版式改了，#cta 位置大改）]", flush=True)
    v2 = post(api, "/api/artifacts", {
        "kind": "page", "title": "锚定验证 v2", "path": f2, "agent": "verify",
        "parent_id": aid1})
    aid2 = v2["artifact"]["id"] if "artifact" in v2 else v2.get("id")
    print(f"  v2 = {aid2}", flush=True)

    print("\n[4 等物化 + 自动重新锚定]", flush=True)
    deadline = time.time() + 90
    new_rect = None
    while time.time() < deadline:
        d2 = get(api, f"/api/artifacts/{aid2}")
        anns = d2.get("annotations", [])
        if anns:
            anchor = anns[0].get("anchor") or {}
            if anchor.get("reanchored_at"):
                new_rect = anchor.get("rect")
                break
        time.sleep(1.5)
    check(new_rect is not None, "v2 标注已被自动重新锚定",
          json.dumps(new_rect, ensure_ascii=False) if new_rect else "超时未锚定")

    print("\n[5 独立量一次 v2 的 #cta 位置做对照]", flush=True)
    rects, ok = await artifacts_cdp.resolve_rects("file://" + os.path.abspath(f2), ["#cta"])
    want = rects.get("#cta")
    check(ok and want is not None, "CDP 能量到 v2 的 #cta", json.dumps(want, ensure_ascii=False)[:120])
    if new_rect and want:
        dy = abs(new_rect["y"] - want["y"])
        dh = abs(new_rect["h"] - want["h"])
        check(dy < 0.02 and dh < 0.02, "库里的 rect 与实测一致（±0.02）",
              f"Δy={dy:.4f} Δh={dh:.4f}")
        moved = abs(new_rect["y"] - (carried_rect or {}).get("y", -1)) > 0.05
        check(moved, "坐标确实跟着版式变化了（不是沿用旧值）",
              f"v1 y={(carried_rect or {}).get('y')} → v2 y={new_rect['y']}")

    print("\n[6 手动 reanchor 入口", flush=True)
    r = post(api, f"/api/artifacts/{aid2}/reanchor", {})
    check(r.get("ok") is True, "POST /reanchor 可用",
          f"moved={len(r.get('moved', []))} checked={r.get('checked')}")

    print("\n" + "=" * 56)
    print(f"结果：{'全部通过 ✓' if not FAIL else f'{len(FAIL)} 项失败'}（共 {len(PASS)+len(FAIL)} 项）")
    print("=" * 56)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
