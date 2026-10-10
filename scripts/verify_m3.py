#!/usr/bin/env python3
"""M3 验收：评审工作流 —— 状态机 / 审计 / 版本差异对比 / 返工自动唤醒。

    python3 scripts/verify_m3.py [--api http://127.0.0.1:8899]

验收口径：状态不能乱跳（非法流转要报错）、每一步要留痕、
改完一版要能说清「改了什么」、agent 不用等人开口就能被返工叫醒。
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

RUN = str(int(time.time()))
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def req(api, path, method="GET", payload=None, timeout=20):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(api + path, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        try:
            return {"__status": exc.code, **json.loads(body)}
        except json.JSONDecodeError:            # 服务端 500 会回纯文本，直接带上原文好排查
            return {"__status": exc.code, "error": body[:200]}


def wait_ready(api, aid, timeout=30):
    """等物化跑完：新发布的成果先 pending，出缩略图后才 ready。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        a = req(api, f"/api/artifacts/{aid}")
        if (a.get("artifact") or a).get("status") in ("ready", "reviewing"):
            return (a.get("artifact") or a)
        time.sleep(0.4)
    return req(api, f"/api/artifacts/{aid}")


def write_html(path, title, extra=""):
    body = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{title}</title><style>body{{font:16px/1.6 system-ui;background:#0b1020;color:#e9eef9;padding:40px}}
h1{{color:#7aa2ff}}</style></head><body>
<h1 id="h">{title}</h1><p>M3 验收页面。</p>{extra}</body></html>"""
    open(path, "w", encoding="utf-8").write(body)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
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
    tmp = os.path.join(ROOT, ".artifacts-data", f"m3-{RUN}")
    os.makedirs(tmp, exist_ok=True)

    # ------------------------------------------------------------ 1 状态机
    print("\n[1 状态机：非法流转要挡住]", flush=True)
    v1 = write_html(os.path.join(tmp, "v1.html"), f"详情页 v1 · {RUN}")
    art = req(api, "/api/artifacts", "POST", {
        "kind": "page", "title": f"详情页 · {RUN}", "path": v1, "agent": "verify-m3"})
    aid = art.get("id")
    check(bool(aid), "发布 v1", f"{aid} status={art.get('status')}")
    ready = wait_ready(api, aid)
    check(ready.get("status") == "ready", "物化完成后进 ready", ready.get("status", ""))

    r = req(api, f"/api/artifacts/{aid}/status", "POST", {"status": "reviewing", "actor": "评审员甲"})
    check(r.get("status") == "reviewing", "ready → reviewing 合法", r.get("status", ""))

    r = req(api, f"/api/artifacts/{aid}/status", "POST", {"status": "rework", "actor": "评审员甲",
                                                          "note": "先退回改版"})
    check(r.get("status") == "rework", "reviewing → rework 合法", r.get("status", ""))

    r = req(api, f"/api/artifacts/{aid}/status", "POST", {"status": "approved", "actor": "评审员甲"})
    check(r.get("__status") == 409, "rework → approved 被拒（必须先回到评审）",
          f"HTTP {r.get('__status')} {r.get('error', '')[:40]}")

    r = req(api, f"/api/artifacts/{aid}/status", "POST", {"status": "reviewing", "actor": "评审员甲"})
    check(r.get("status") == "reviewing", "rework → reviewing 回到评审", r.get("status", ""))

    # ------------------------------------------------------------ 2 审计
    print("\n[2 审计：谁在什么时候做了什么]", flush=True)
    audit = req(api, f"/api/artifacts/{aid}/audit").get("audit", [])
    kinds = [a.get("event") for a in audit]
    check(sum(1 for k in kinds if k == "artifact.status") >= 3,
          "状态流转逐条留痕", f"{kinds.count('artifact.status')} 条 status 事件")
    st_evt = [a for a in audit if a.get("event") == "artifact.status"]
    check(any(a.get("actor") == "评审员甲" for a in st_evt), "审计带操作人", str(
        sorted({a.get("actor") for a in st_evt})))
    check(any((a.get("payload") or {}).get("note") == "先退回改版" for a in st_evt),
          "审计带流转原因", "note=先退回改版")

    # ------------------------------------------------------------ 3 标注 + 派发
    print("\n[3 标注与派发：返工清单要拿得到]", flush=True)
    for body in ("标题太小", "底部留白不对"):
        req(api, f"/api/artifacts/{aid}/annotations", "POST",
            {"body": body, "surface": "page", "severity": "minor"})
    fb = req(api, f"/api/artifacts/{aid}/feedback")
    check(fb.get("count") == 2, "两条标注可取回", f"count={fb.get('count')}")

    disp = req(api, f"/api/artifacts/{aid}/dispatch", "POST",
               {"actor": "评审员甲", "note": "按标注改一版"})
    check(disp.get("artifact", {}).get("status") == "rework" and len(disp.get("feedback", [])) == 2,
          "派发返工返回清单", f"{disp.get('artifact', {}).get('status')} / {len(disp.get('feedback', []))} 条")

    # ------------------------------------------------------------ 4 版本对比
    print("\n[4 版本差异：v1 → v2 改了什么]", flush=True)
    v2 = write_html(os.path.join(tmp, "v2.html"), f"详情页 v2 · {RUN}",
                    extra="<h2 id=\"sub\">新增副标题</h2>")
    a2 = req(api, "/api/artifacts", "POST", {
        "kind": "page", "title": f"详情页 · {RUN}", "path": v2,
        "parent_id": aid, "agent": "verify-m3"})
    aid2 = a2.get("id")
    wait_ready(api, aid2)
    check(a2.get("version") == 2 and a2.get("parent_id") == aid, "v2 挂在 v1 下面",
          f"v{a2.get('version')} parent={a2.get('parent_id')}")

    carried = req(api, f"/api/artifacts/{aid2}/feedback").get("annotations", [])
    check(len(carried) == 2, "未解决标注跨版本继承", f"{len(carried)} 条")

    for n in carried[:1]:
        req(api, f"/api/artifacts/{aid2}/annotations/{n['id']}", "PATCH",
            {"status": "resolved", "author": "agent"})
    d = req(api, f"/api/artifacts/{aid2}/diff").get("diff", {})
    check(d.get("counts", {}).get("resolved") == 1, "对比看得出已解决 1 条",
          json.dumps(d.get("counts", {}), ensure_ascii=False))
    check(len(d.get("kept_open", [])) == 1, "对比看得出还剩 1 条未解决")
    src = d.get("source", {})
    check(src.get("available") and src.get("added", 0) > 0, "源码差异可比对",
          f"+{src.get('added')}/-{src.get('removed')}")

    same = req(api, f"/api/artifacts/{aid2}/diff?from={aid2}").get("diff", {})
    check(same.get("from", {}).get("id") == aid2, "自己跟自己比也不炸", "同一版本")

    # 丢了一条标注的情况要说清楚
    chain = req(api, f"/api/artifacts/{aid2}/chain").get("chain", [])
    check(len(chain) == 2 and chain[1]["id"] == aid2, "版本链两版齐活", f"{len(chain)} 版")

    # ------------------------------------------------------------ 5 返工唤醒
    print("\n[5 返工自动唤醒：agent 挂着等，不用人开口]", flush=True)
    v3 = write_html(os.path.join(tmp, "v3.html"), f"详情页 v3 · {RUN}")
    a3 = req(api, "/api/artifacts", "POST", {
        "kind": "page", "title": f"详情页 · {RUN}", "path": v3,
        "parent_id": aid2, "agent": "verify-m3"})
    aid3 = a3.get("id")
    wait_ready(api, aid3)

    woken = {}

    def waiter():
        woken["res"] = req(api, f"/api/artifacts/wait-rework?aid={aid3}&timeout=12", timeout=25)
        woken["at"] = time.time()

    t0 = time.time()
    th = threading.Thread(target=waiter)
    th.start()
    time.sleep(1.0)                       # 确保服务端已经挂上订阅
    req(api, f"/api/artifacts/{aid3}/annotations", "POST",
        {"body": "这里还有问题", "surface": "page", "severity": "blocker"})
    req(api, f"/api/artifacts/{aid3}/dispatch", "POST", {"actor": "评审员乙", "note": "再来一版"})
    th.join(timeout=25)
    dt = time.time() - t0
    res = woken.get("res", {})
    check(res.get("woke") is True, "长轮询被返工叫醒", f"{dt:.1f}s")
    rw = (res.get("rework") or [{}])[0]
    check(rw.get("artifact_id") == aid3 and len(rw.get("feedback", [])) >= 1,
          "醒来就带着返工清单和评审链接（含上版继承未销的意见）",
          f"{len(rw.get('feedback', []))} 条 · {rw.get('review_url', '')[:44]}")
    check(dt < 8, "叫醒够快（不用等超时）", f"{dt:.1f}s < 8s")

    v4 = write_html(os.path.join(tmp, "v4.html"), f"详情页 v4 · {RUN}")
    a4 = req(api, "/api/artifacts", "POST", {"kind": "page", "title": f"详情页 · {RUN}",
                                            "path": v4, "parent_id": aid3, "agent": "verify-m3"})
    r = req(api, "/api/artifacts/wait-rework?timeout=2", timeout=15)
    check(r.get("woke") is False, "不点名时只等新返工，不被历史积压误唤醒",
          f"woke={r.get('woke')} timeout={r.get('timeout')}s")
    r = req(api, f"/api/artifacts/wait-rework?aid={a4.get('id')}&timeout=1", timeout=15)
    check(r.get("woke") is False, "点名的成果没返工就安静超时，不报错",
          f"timeout={r.get('timeout')}s")

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
