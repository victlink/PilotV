#!/usr/bin/env python3
"""验证评审链接指向 PilotV 前端，而不是成果台自己的端口。

背景：网关代理时会把 Host 改写成上游地址（127.0.0.1:8799），成果台如果只看
request.host，发给用户的链接就是侧车的 JSON 健康页。这里确认它优先用
CONSOLE_PUBLIC_URL，其次用网关带过来的 X-Forwarded-Host。

跑法：python3 scripts/verify_review_url.py
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server  # noqa: F401 - 统一脚本约定

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

RESULTS = []


def check(ok, name, detail=""):
    RESULTS.append((bool(ok), name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    return bool(ok)


class FakeRequest:
    """只要够 _review_url 用：scheme、host、headers。"""

    def __init__(self, host="127.0.0.1:8799", scheme="http", headers=None):
        self.host = host
        self.scheme = scheme
        self.headers = headers or {}


def main():
    import artifacts_console

    os.environ.pop("CONSOLE_PUBLIC_URL", None)
    check(artifacts_console._review_url(FakeRequest(), "art_x") == "http://127.0.0.1:8799/",
          "没配也没转发头时退回侧车自己（老行为不变）",
          artifacts_console._review_url(FakeRequest(), "art_x"))

    forwarded = artifacts_console._review_url(
        FakeRequest(headers={"X-Forwarded-Host": "pilotv.example:5186", "X-Forwarded-Proto": "http"}), "art_x")
    check(forwarded == "http://pilotv.example:5186/", "走网关时指向网关地址", forwarded)

    https = artifacts_console._review_url(
        FakeRequest(headers={"X-Forwarded-Host": "pilotv.example:5186", "X-Forwarded-Proto": "https"}), "art_x")
    check(https == "https://pilotv.example:5186/", "转发协议也认", https)

    os.environ["CONSOLE_PUBLIC_URL"] = "http://configured.example:1234"
    configured = artifacts_console._review_url(
        FakeRequest(headers={"X-Forwarded-Host": "pilotv.example:5186"}), "art_x")
    check(configured == "http://configured.example:1234/", "显式配置优先于转发头", configured)
    os.environ.pop("CONSOLE_PUBLIC_URL", None)

    failed = [name for ok, name, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过", flush=True)
    if failed:
        print("失败：" + "；".join(failed), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())