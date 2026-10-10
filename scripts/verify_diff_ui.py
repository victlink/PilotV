#!/usr/bin/env python3
"""M3 前端验收：版本条与差异面板真能在浏览器里点出来。

    python3 scripts/verify_diff_ui.py [--api http://127.0.0.1:8899] [--shot /tmp/diff.png]

走真链路：造一条 v1 → v2 链（v2 销掉一条意见），用 CDP 打开控制台，
选中 v2、点「对比上版」，读 DOM 断言版本条与差异面板真的出现，并截图留证。
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
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import artifacts_cdp  # noqa: E402

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def req(api, path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(api + path, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(r, timeout=20) as resp:
        return json.loads(resp.read().decode() or "{}")


def wait_ready(api, aid, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        a = req(api, f"/api/artifacts/{aid}")
        if a.get("status") in ("ready", "reviewing", "rework"):
            return a
        time.sleep(0.4)
    return req(api, f"/api/artifacts/{aid}")


HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>%s</title>
<style>body{font:16px/1.7 system-ui;background:#0b1020;color:#e9eef9;padding:48px;max-width:720px}
h1{font-size:40px;color:#7aa2ff;margin:0 0 16px}section{background:#141b2e;padding:20px;border-radius:12px}</style>
</head><body><h1 id="t">%s</h1><section id="box">%s</section></body></html>"""

# 页面里跑的一段：等版本条 → 点「对比上版」→ 把面板内容捞回来
UI_SCRIPT = r"""
(async () => {
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const card = document.querySelector('.art-card');
  if (card) card.click();
  for (let i = 0; i < 80 && $('#verChain').hidden; i++) await sleep(150);
  const chips = Array.from(document.querySelectorAll('.art-ver-chip')).map(b => b.textContent.trim());
  const hasBtn = !!$('#btnVerDiff');
  if (hasBtn) $('#btnVerDiff').click();
  for (let i = 0; i < 80 && $('#verDiff').hidden; i++) await sleep(150);
  const out = {
    chips,
    hasBtn,
    diffHidden: $('#verDiff').hidden,
    head: ($('.art-diff-head') || {}).innerText ? $('.art-diff-head').innerText.replace(/\n/g, ' ') : '',
    stats: Array.from(document.querySelectorAll('.art-diff-stat')).map(s => s.textContent.trim()),
    notes: Array.from(document.querySelectorAll('.art-diff-note')).map(n => n.textContent.trim()),
    codeLines: document.querySelectorAll('.art-diff-code div').length,
  };
  return out;
})()
"""

# 第二步：点 ✕ 收起面板
CLOSE_SCRIPT = """(() => { const b = document.getElementById('btnDiffClose');
  if (b) b.click(); return document.getElementById('verDiff').hidden; })()"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
    ap.add_argument("--shot", default="/tmp/artifacts-diff.png")
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
    run = str(int(time.time()))
    tmp = os.path.join(ROOT, ".artifacts-data", f"m3ui-{run}")
    os.makedirs(tmp, exist_ok=True)

    print("\n[1 造一条 v1 → v2 链]", flush=True)
    p1, p2 = os.path.join(tmp, "v1.html"), os.path.join(tmp, "v2.html")
    open(p1, "w", encoding="utf-8").write(HTML % (f"页面 v1 {run}", f"页面 v1 {run}", "<p>初稿</p>"))
    a1 = req(api, "/api/artifacts", "POST", {"kind": "page", "title": f"对比页面 {run}",
                                            "path": p1, "agent": "verify-m3-ui"})
    wait_ready(api, a1["id"])
    req(api, f"/api/artifacts/{a1['id']}/annotations", "POST",
        {"body": "标题太小", "surface": "page", "severity": "major"})
    req(api, f"/api/artifacts/{a1['id']}/annotations", "POST",
        {"body": "内容太少", "surface": "page", "severity": "minor"})
    req(api, f"/api/artifacts/{a1['id']}/dispatch", "POST", {"actor": "评审员", "note": "改一版"})
    open(p2, "w", encoding="utf-8").write(
        HTML % (f"页面 v2 {run}", f"页面 v2 {run}", "<p>终稿：补了三段说明文字和一张图位。</p>"))
    a2 = req(api, "/api/artifacts", "POST", {"kind": "page", "title": f"对比页面 {run}",
                                            "path": p2, "parent_id": a1["id"], "agent": "verify-m3-ui"})
    wait_ready(api, a2["id"])
    notes = req(api, f"/api/artifacts/{a2['id']}/feedback").get("annotations", [])
    check(len(notes) == 2, "v2 继承两条意见", f"{len(notes)} 条")
    req(api, f"/api/artifacts/{a2['id']}/annotations/{notes[0]['id']}", "PATCH",
        {"status": "resolved", "author": "agent"})

    print("\n[2 浏览器里点开差异面板]", flush=True)
    res = asyncio.run(artifacts_cdp.run_script(
        f"{api}/artifacts.html#{a2['id']}", UI_SCRIPT,
        wait_js="document.querySelectorAll('.art-card').length > 0",
        screenshot_path=args.shot))
    val = res.get("value") or {}
    check(bool(val), "页面脚本跑通并返回结果", json.dumps(val, ensure_ascii=False)[:120])
    check(len(val.get("chips") or []) >= 2, "版本条显示两版", " / ".join(val.get("chips") or []))
    check(val.get("hasBtn") is True, "有「对比上版」按钮")
    check(val.get("diffHidden") is False, "点开后面板出现")
    check("v1" in (val.get("head") or "") and "v2" in (val.get("head") or ""),
          "面板标题含版本号", (val.get("head") or "")[:60])
    stats = val.get("stats") or []
    check(any("已解决" in s for s in stats) and any("仍未解决" in s for s in stats),
          "解决/未解决两类都摆出来了", " · ".join(stats))
    check(any("标题太小" in n for n in (val.get("notes") or [])),
          "解决掉的意见在面板里可读", (val.get("notes") or [""])[0][:24])
    check((val.get("codeLines") or 0) > 4, "源码差异也渲染了", f"{val.get('codeLines')} 行")
    shot = res.get("screenshot") or args.shot
    size = os.path.getsize(shot) if os.path.exists(shot) else 0
    check(size > 5000, "截图留证（面板展开时截的）", f"{shot} {size}B")

    closed = asyncio.run(artifacts_cdp.run_script(f"{api}/artifacts.html", CLOSE_SCRIPT)).get("value")
    check(closed is True, "点 ✕ 能收起差异面板")

    print("\n" + "=" * 56, flush=True)
    print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败（共 {len(PASS) + len(FAIL)} 项）", flush=True)
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}", flush=True)
        sys.exit(1)
    print("全部通过 ✓", flush=True)


if __name__ == "__main__":
    # 必须把 main() 的返回值交给 SystemExit：护栏拒绝时 return 3，
    # 直接 main() 会把返回值丢掉、退出码恒为 0，回归脚本会以为这套「通过了」。
    raise SystemExit(main() or 0)
