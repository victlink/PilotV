#!/usr/bin/env python3
"""验证 HTML 成果能带上同目录的相对资源，而且越界取不到东西。

为什么要单独验：
    HTML 成果是用 iframe 打开 /api/artifacts/{aid}/raw 的，页面里写的
    <img src="lockups/a.svg"> 会解析成 /api/artifacts/{aid}/lockups/a.svg。
    没有这条路由，成果页打开就是一个白页加一串 404 —— 看起来像成果坏了。

覆盖：
  1. 同目录相对资源能取到
  2. 目录穿越（../../）拿不到
  3. 绝对路径拿不到
  4. 点文件（.env 之类）拿不到
  5. 不存在的文件是 404，不是 500

跑法：python3 scripts/verify_sibling_assets.py [--base http://127.0.0.1:8799]
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import json
import re
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

RESULTS = []


def check(ok, name, detail=""):
    RESULTS.append((bool(ok), name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    return bool(ok)


def get(base, path):
    """返回 (状态码, 正文)；404 也当正常结果带回来。"""
    url = base.rstrip("/") + path
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def find_html_artifact(base):
    """挑一个同目录里真的还有相对资源的 HTML 成果。"""
    status, body = get(base, "/api/artifacts/workspace")
    if status != 200:
        return None
    for project in json.loads(body).get("projects", []):
        for session in project.get("sessions", []):
            for artifact in session.get("artifacts", []):
                if artifact.get("kind") != "page":
                    continue
                status, raw = get(base, f"/api/artifacts/{artifact['id']}/raw")
                if status != 200:
                    continue
                text = raw.decode("utf-8", "replace")
                refs = re.findall(r'(?:src|href)="(?!https?:|data:|#|/)([^"]+)"', text)
                if refs:
                    return artifact["id"], refs[0].split("/")[0] if "/" in refs[0] else refs[0], refs[0]
    return None


def first_image_id(base):
    """找一个图片成果，用来验 raw 没被乱改。"""
    status, body = get(base, "/api/artifacts/workspace")
    if status != 200:
        return None
    for project in json.loads(body).get("projects", []):
        for session in project.get("sessions", []):
            for artifact in session.get("artifacts", []):
                if artifact.get("kind") == "image":
                    return artifact["id"]
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=os.environ.get("ARTIFACTS_BASE", "http://127.0.0.1:8799"))
    args = parser.parse_args()
    # 这个脚本只发 GET，不写库，所以可以直接指向正式服务。
    data_dir = assert_test_server(args.base, force=True)
    print(f"目标服务：{args.base}（数据目录 {data_dir}，只读）", flush=True)

    found = find_html_artifact(args.base)
    if not found:
        print("  [SKIP] 没有带相对资源的 HTML 成果，跳过", flush=True)
        return 0
    aid, dirname, ref = found
    quoted = urllib.parse.quote(ref)
    status, body = get(args.base, f"/api/artifacts/{aid}/file/{quoted}")
    check(status == 200, "同目录相对资源能取到", f"{ref} -> {status}")
    check(status == 200 and len(body) > 0, "取到的是文件本身", f"{len(body)} 字节")

    for bad, label in (("../../../etc/passwd", "目录穿越"), ("..%2f..%2fetc%2fpasswd", "编码后的穿越"),
                       ("/etc/passwd", "绝对路径"), (".env", "点文件")):
        status, _ = get(args.base, f"/api/artifacts/{aid}/file/{bad}")
        check(status == 404, f"{label}拿不到", f"{bad} -> {status}")

    status, _ = get(args.base, f"/api/artifacts/{aid}/file/does-not-exist.svg")
    check(status == 404, "不存在的文件是 404 不是 500", f"-> {status}")

    # iframe 打开的是 /raw，浏览器把相对路径解析到 /api/artifacts/{id}/ 下，
    # 所以 HTML 正文里必须有个 base 指到 file 路由，否则素材全 404。
    status, raw = get(args.base, f"/api/artifacts/{aid}/raw")
    html = raw.decode("utf-8", "replace")
    check(f'<base href="/api/artifacts/{aid}/file/">' in html, "HTML 正文里注入了 base", f"-> {status}")
    check("<html" in html.lower() and "</html>" in html.lower(), "注入后正文仍是完整 HTML",
          f"{len(raw)} 字节")
    relative = html.split(f'<base href="/api/artifacts/{aid}/file/">', 1)[-1]
    first_ref = re.search(r'(?:src|href)="(?!https?:|data:|#|/)([^"]+)"', relative)
    check(bool(first_ref), "注入点之后还有相对引用可解析", first_ref.group(1) if first_ref else "没有")
    if first_ref:
        status, _ = get(args.base, f"/api/artifacts/{aid}/file/{urllib.parse.quote(first_ref.group(1))}")
        check(status == 200, "按 base 解析出来的资源能取到", f"{first_ref.group(1)} -> {status}")

    # 非 HTML 不能被动过：图片原样返回，否则图片会坏。
    image_id = first_image_id(args.base)
    status, image = get(args.base, f"/api/artifacts/{image_id}/raw")
    check(status == 200 and image[:8] == b"\x89PNG\r\n\x1a\n", "图片 raw 原样返回，没被注入",
          f"{len(image)} 字节")

    failed = [name for ok, name, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过", flush=True)
    if failed:
        print("失败：" + "；".join(failed), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())