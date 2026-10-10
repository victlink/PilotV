#!/usr/bin/env python3
"""M2 验收：目录 watcher —— 产物落地自动进成果台，改了自动出 v2。

    python3 scripts/verify_watch.py [--api http://127.0.0.1:8899]
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import json
import os
import shutil
import sys
import time
import urllib.request

RUN = str(int(time.time()))          # 每轮唯一，避免跟上一轮的哈希撞上

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def req(api, path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(api + path, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(r, timeout=20) as resp:
        return json.load(resp)


HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{title}</title><style>body{{font:16px/1.6 system-ui;background:#0b1020;color:#e9eef9;
padding:40px}}</style></head><body><h1 id="h">{title}</h1><p>watcher 验证页面。</p></body></html>"""

# 文件必须 > 512B（watcher 的 min_bytes），所以写足内容
PAD = "x" * 900


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
    ap.add_argument("--dir", default=os.path.join(ROOT, ".artifacts-data", "watch-fixture"))
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
    wdir = os.path.abspath(args.dir)

    shutil.rmtree(wdir, ignore_errors=True)
    os.makedirs(wdir, exist_ok=True)

    print("\n[1 挂监控目录]", flush=True)
    r = req(api, "/api/artifacts/watch", "POST", {"path": wdir})
    check(r.get("ok") is True, "POST /api/artifacts/watch 挂上目录", str(r.get("dir")))

    print("\n[2 放一个文件进去（不新建，直接写）]", flush=True)
    page = os.path.join(wdir, "落地页.html")
    open(page, "w", encoding="utf-8").write(HTML.format(title=f"watcher 首版 {RUN}") + PAD)
    found = wait_for_title(api, f"watcher 首版 {RUN}", 60)
    check(found is not None, "新文件自动进成果台",
          found["id"] if found else "60 秒内没等到")

    print("\n[2b 页面类成果应截图成 PNG，而不是占位图]", flush=True)
    if found:
        # 物化是异步的：刚发现成果时缩略图还没生成，直接 GET /thumb 会 404。
        # 轮询等它，别把「还没好」误判成「没截图」。
        ctype, head = "", b""
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{api}/api/artifacts/{found['id']}/thumb",
                                            timeout=20) as r:
                    ctype, head = r.headers.get("Content-Type", ""), r.read(8)
                break
            except Exception:
                time.sleep(1.5)
        check(ctype == "image/png" and head.startswith(b"\x89PNG"),
              "watcher 发布的页面拿到了真截图", f"{ctype or '（60 秒内没生成）'} {len(head)}B")

    print("\n[3 再扫一轮：内容没变，不该重复发]", flush=True)
    if found:
        again = wait_for_new(api, timeout=8)
        check(again is None, "内容没变不会重复发布",
              f"没有新成果（找到的：{again['id'] if again else '无'}）")

    print("\n[4 改文件内容 → 应出 v2 且挂在 v1 下面]", flush=True)
    open(page, "w", encoding="utf-8").write(HTML.format(title=f"watcher 改版 {RUN}") + PAD)
    v2 = wait_for_title(api, f"watcher 改版 {RUN}", 60)
    check(v2 is not None, "改动的文件自动出新版本",
          v2["id"] if v2 else "60 秒内没等到")
    if v2 and found:
        check(v2.get("parent_id") == found["id"], "v2 的 parent 指向 v1（版本链接上）",
              f"{v2.get('parent_id')} vs {found['id']}")

    print("\n[5 盯上 junk 不该发]", flush=True)
    junk = os.path.join(wdir, "半成品.html.tmp")
    open(junk, "w", encoding="utf-8").write("<html>" + PAD)
    time.sleep(3)
    listing = req(api, "/api/artifacts?limit=200")["artifacts"]
    titles = {a["title"] for a in listing}
    check("半成品" not in titles, "临时文件没被当成成果发布")

    print("\n[6 取下监控目录]", flush=True)
    r = req(api, f"/api/artifacts/watch?path={wdir}", "DELETE")
    check(r.get("ok") is True and wdir not in r.get("dirs", []), "DELETE 取消监控",
          str(r.get("dirs")))

    print("\n" + "=" * 56)
    print(f"结果：{'全部通过 ✓' if not FAIL else f'{len(FAIL)} 项失败'}（共 {len(PASS)+len(FAIL)} 项）")
    print("=" * 56)
    return 1 if FAIL else 0


def list_items(api):
    return req(api, "/api/artifacts?limit=200")["artifacts"]


def wait_for_title(api, title, timeout):
    end = time.time() + timeout
    while time.time() < end:
        for a in list_items(api):
            if a["title"] == title:
                return a
        time.sleep(1.5)
    return None


def wait_for_new(api, timeout):
    """等一个新成果（除了 watcher 首版那条）。"""
    end = time.time() + timeout
    seen = set()
    while time.time() < end:
        seen = {a["id"] for a in list_items(api)}
        time.sleep(1.0)
        now = {a["id"] for a in list_items(api)}
        new = now - seen
        if new:
            return next(a for a in list_items(api) if a["id"] in new)
    return None


if __name__ == "__main__":
    sys.exit(main())
