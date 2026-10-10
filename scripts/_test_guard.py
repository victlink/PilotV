"""验收脚本的「别写进真库」护栏。

背景：每个 verify_*.py 的默认目标都是 ``--api http://127.0.0.1:8899``，
文档里也是让人直接 ``python3 scripts/verify_xxx.py`` 跑。只要真成果台正好
开在 8899，这一下就把几百条测试成果（shot.png ×104、plan.svg ×106、
verify* / probe* / noise-* 这些 agent 名）灌进了用户的正式库 —— 左栏被
735 条淹没就是这么来的。run_all_verify.sh 自己带隔离（--regress 会另起
隔离服务），但手动单个跑没有这层保护。

这里补上：**跑之前先问服务自己在用哪个数据目录**，不是隔离的就拒绝执行。
不删数据、不改端口，只挡住「测试写进真库」这一件事。
"""
from __future__ import annotations

import json
import os
import urllib.request

# 数据目录名里出现这些词，就算测试环境
_TEST_MARKERS = ("test", "regress", "tmp", "ci-", "verify")
# 只有这些根目录下的数据目录，才明确是临时的
_TMP_ROOTS = ("/tmp", "/var/tmp", "/private/tmp")


class NotATestServer(RuntimeError):
    """目标服务不是隔离的测试实例。"""


def looks_like_test_dir(data_dir: str) -> bool:
    d = os.path.abspath(data_dir or "")
    low = d.lower()
    if any(d == r or d.startswith(r + os.sep) for r in _TMP_ROOTS):
        return True
    return any(m in low for m in _TEST_MARKERS)


def server_data_dir(api: str, token: str | None = None, timeout: float = 5.0) -> str:
    """问服务它的数据目录。问不到就返回空串（交给调用方决定怎么办）。"""
    url = api.rstrip("/") + "/api/artifacts/health"
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8", "replace"))
    return str(body.get("data_dir") or "")


def assert_test_server(api: str, token: str | None = None, *, force: bool = False) -> str:
    """确认 api 指向的是隔离测试服务，否则抛 NotATestServer。

    返回该服务的数据目录（方便调用方打印出来，省得再查一遍）。
    """
    try:
        data_dir = server_data_dir(api, token)
    except Exception as exc:                       # 服务没起来：交给原脚本自己报错
        raise NotATestServer(f"连不上 {api} 的成果台（{exc}）") from exc

    if force or looks_like_test_dir(data_dir):
        return data_dir

    raise NotATestServer(
        f"{api} 用的是正式数据目录 {data_dir}，不是测试目录。\n"
        f"    往这里跑验收会把几百条测试成果写进你的正式库（左栏被淹没就是这么来的）。\n"
        f"    两种做法：\n"
        f"      1) 用隔离环境：bash scripts/run_all_verify.sh\n"
        f"      2) 自己起一个：ARTIFACTS_DATA_DIR=/tmp/arts-verify "
        f"python3 scripts/serve_test.py --port 8899\n"
        f"    确实就是要往正式库里写，加 --force。"
    )
