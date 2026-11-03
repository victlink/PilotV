#!/usr/bin/env python3
"""SessionIngester 隔离回归测试。

在临时目录里造一套 PilotDeck 项目树 + 会话 transcript，跑真实代码路径，
验证：归属精确到 run_id、内容不变不重发、附属资源被拒、增量读不重扫、
kill-switch 生效。全程不碰生产数据。

用法: python3 scripts/verify_session_ingester.py
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FAILS: list[str] = []
PASSES = 0


def run(coro):
    """scan_once 是 async（它挂在启动期的 asyncio 循环上）。"""
    return asyncio.run(coro)


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSES
    if cond:
        PASSES += 1
        print(f"  PASS  {name}")
    else:
        FAILS.append(f"{name}: {detail}")
        print(f"  FAIL  {name}  {detail}")


def png_bytes(w: int = 200, h: int = 200) -> bytes:
    """最小合法 PNG（够 classify 过 + 够 min_bytes=512）。

    刻意塞噪声而不是纯色：纯色 PNG 压完只有 168 字节，会被 min_bytes
    挡在门外，那样测的就成了压缩算法而不是收录逻辑。
    """
    import struct
    import zlib

    rnd = random.Random(20261015)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    rows = bytearray()
    for _ in range(h):
        rows.append(0)                       # 每行的 filter type 0
        for _ in range(w):
            rows += bytes((rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 0))
            + chunk(b"IEND", b""))


def build_fixture(tmp: str) -> tuple:
    """造 projects 树 + 项目 cwd + transcript。返回关键路径。"""
    pilot = os.path.join(tmp, "pilotdeck")
    proj_dir = os.path.join(pilot, "projects", "demo-3d")
    chats = os.path.join(proj_dir, "chats")
    cwd = os.path.join(tmp, "workspace", "3D")
    os.makedirs(chats, exist_ok=True)
    os.makedirs(os.path.join(cwd, "out"), exist_ok=True)
    with open(os.path.join(proj_dir, ".cwd"), "w") as fh:
        fh.write(cwd)
    return pilot, proj_dir, chats, cwd


def append_row(path: str, row: dict) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def fa_row(sid: str, cwd: str, artifacts: list) -> dict:
    return {"type": "file_artifacts", "sessionId": sid, "turnId": "t1",
            "sequence": 1, "createdAt": "2026-10-15T00:00:00.000Z",
            "entryId": "e1", "parentEntryId": None, "artifacts": artifacts}


def fa_entry(name: str, path: str, size: int, op: str = "created") -> dict:
    return {"id": name[:12], "name": name, "path": path, "operation": op,
            "source": "tool", "status": "complete", "size": size,
            "sha256": "x" * 64, "createdAt": "2026-10-15T00:00:00.000Z"}


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="artifacts-ingest-test-")
    try:
        pilot, proj_dir, chats, cwd = build_fixture(tmp)

        # 造产物文件
        logo = os.path.join(cwd, "out", "Logo-3D.png")
        with open(logo, "wb") as fh:
            fh.write(png_bytes())
        size = os.path.getsize(logo)
        icon = os.path.join(cwd, "out", "assets", "icon.svg")
        os.makedirs(os.path.dirname(icon), exist_ok=True)
        with open(icon, "w") as fh:
            fh.write("<svg xmlns='http://www.w3.org/2000/svg'>" + "<!-- x -->" * 400 + "</svg>")
        script = os.path.join(cwd, "out", "build.py")
        with open(script, "w") as fh:
            fh.write("# build script\n" * 200)

        tpath = os.path.join(chats, "web:s_aaa.jsonl")
        append_row(tpath, {"type": "assistant_message", "message": {"content": "hi"}})
        append_row(tpath, fa_row("web:s_aaa", cwd, [
            fa_entry("Logo-3D.png", "out/Logo-3D.png", size),
            fa_entry("icon.svg", "out/assets/icon.svg", os.path.getsize(icon)),
            fa_entry("build.py", "out/build.py", os.path.getsize(script)),
            fa_entry("ghost.png", "out/ghost.png", 999),        # 文件不存在
        ]))

        os.environ["PILOTDECK_HOME"] = pilot
        os.environ["ARTIFACTS_DATA_DIR"] = os.path.join(tmp, "data")
        sys.path.insert(0, ROOT)
        import artifacts_console as c
        import artifacts_store

        store = artifacts_store.ArtifactStore(os.environ["ARTIFACTS_DATA_DIR"])
        submitted: list = []
        ing = c.SessionIngester(store, lambda aid: submitted.append(aid),
                                interval=999, min_bytes=512)
        # 项目名要用产物真实所在的项目，_project_of 靠 pilotdeck_workspace 反查
        import pilotdeck_workspace as ws
        ws.invalidate()

        print("\n[1] 首轮扫描：只该收 Logo-3D.png")
        out = run(ing.scan_once())
        arts = store.list(limit=100)
        check("只发布 1 条", len(arts) == 1, f"实际 {len(arts)}: {[a['title'] for a in arts]}")
        check("run_id 精确归属", arts and arts[0].get("run_id") == "web:s_aaa",
              f"实际 {arts[0].get('run_id') if arts else None}")
        check("kind 判定为 image", bool(arts) and arts[0]["kind"] == "image",
              f"实际 {arts[0]['kind'] if arts else None}")
        check("进了物化队列", len(submitted) == 1, f"submitted={submitted}")
        check("图标(从属资源)被拒", not any(a["title"] == "icon.svg" for a in arts))
        check("源码 .py 被拒", not any(a["title"] == "build.py" for a in arts))
        check("不存在的文件被跳过", not any("ghost" in a["title"] for a in arts))

        print("\n[2] 重复扫描：内容没变不该重发")
        n_before = len(store.list(limit=100))
        out2 = run(ing.scan_once())
        check("无新增", len(store.list(limit=100)) == n_before,
              f"{n_before} -> {len(store.list(limit=100))}")
        check("scan_once 返回空", out2 == [], f"返回 {out2}")

        print("\n[3] 文件改动：应发新版并继承版本链")
        with open(logo, "wb") as fh:
            fh.write(png_bytes(96, 96))
        os.utime(logo, (0, 0))          # 强制 mtime 变化，绕过 (mtime,size) 快筛
        append_row(tpath, fa_row("web:s_aaa", cwd, [fa_entry("Logo-3D.png", "out/Logo-3D.png", 0, "modified")]))
        run(ing.scan_once())
        arts2 = store.list(limit=100)
        check("发了第 2 版", len(arts2) == 2, f"实际 {len(arts2)}")
        chain = store.chain(arts2[0]["id"])
        check("版本链连起来了", len(chain) == 2, f"chain 长度 {len(chain)}")

        print("\n[4] 手动 publish 之后再被自动收录，不应重复")
        store2 = artifacts_store.ArtifactStore(os.path.join(tmp, "data2"))
        os.environ["ARTIFACTS_DATA_DIR"] = os.path.join(tmp, "data2")
        c.DATA_DIR = os.path.join(tmp, "data2")
        ing2 = c.SessionIngester(store2, lambda aid: None, interval=999)
        run(ing2.scan_once())                                  # 先自动收一次
        auto_ids = [a["id"] for a in store2.list(limit=100)]
        # 模拟 api_create 现在会写 watch_sources：手动发同一文件
        import hashlib
        dg = hashlib.sha1(open(logo, "rb").read()).hexdigest()
        store2.watch_remember(logo, dg, auto_ids[0])
        ing2._seen.clear()
        n3 = len(store2.list(limit=100))
        run(ing2.scan_once())
        check("总账拦住了重复发布", len(store2.list(limit=100)) == n3,
              f"{n3} -> {len(store2.list(limit=100))}")

        print("\n[5] kill-switch")
        check("_env_flag 默认开", c._env_flag("ARTIFACTS_NOT_SET_X", True) is True)
        os.environ["ARTIFACTS_NOT_SET_X"] = "0"
        check("_env_flag=0 关", c._env_flag("ARTIFACTS_NOT_SET_X", True) is False)
        os.environ["ARTIFACTS_NOT_SET_X"] = "  "
        check("_env_flag 空串回落默认", c._env_flag("ARTIFACTS_NOT_SET_X", True) is True)
        os.environ["ARTIFACTS_NOT_SET_X"] = "1"
        check("_env_flag=1 开", c._env_flag("ARTIFACTS_NOT_SET_X", False) is True)

        print("\n[6] 增量读：只在新增行里找，不重扫全文")
        ing3 = c.SessionIngester(store, lambda aid: None, interval=999)
        ing3._state[str(tpath)] = [os.path.getsize(tpath)]
        check("无新增行时不发", ing3._read_new_rows(str(tpath)) == [])
        # 一行普通对话消息：不是 file_artifacts，不该被当产出
        append_row(tpath, {"type": "assistant_message", "message": {"content": "在做了"}})
        check("普通消息行被忽略", ing3._read_new_rows(str(tpath)) == [])
        # 一行 file_artifacts 但 artifacts 为空：同样不是产出
        append_row(tpath, fa_row("web:s_aaa", cwd, []))
        check("空 artifacts 行被忽略", ing3._read_new_rows(str(tpath)) == [])
        # 真产出行：这轮新增的，必须读到
        append_row(tpath, fa_row("web:s_aaa", cwd, [
            fa_entry("Logo-3D.png", "out/Logo-3D.png", os.path.getsize(logo))]))
        rows = ing3._read_new_rows(str(tpath))
        check("读到本轮新增的产出行", len(rows) == 1, f"读到 {len(rows)} 行")
        check("读到的行带对 sessionId",
              bool(rows) and rows[0].get("sessionId") == "web:s_aaa")
        check("再读一次没有新增", ing3._read_new_rows(str(tpath)) == [])

        print(f"\n{'='*52}\nPASS {PASSES}  FAIL {len(FAILS)}")
        for f in FAILS:
            print("  - " + f)
        return 1 if FAILS else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
