#!/usr/bin/env python3
"""一次性排查脚本：确认线上（本地部署）成果台的实际状态。

1. 网关 https://5186 派发的 index.html 与它的主 chunk 里，成果台默认工具是不是 browse
2. 成果台 8799 里所有三维成果的扩展名，以及 STEP 走 /viewer 的真实返回
用法：python3 scripts/probe_artifacts_live.py
"""
from __future__ import annotations

import json
import os
import ssl
import urllib.request

GW = "https://127.0.0.1:5186"
CONSOLE = "http://127.0.0.1:8799"
TOKEN_FILE = os.path.expanduser("~/.config/pilotv-artifacts/token")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def get(url: str, bearer: str | None = None) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "probe"})
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=20) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)
    except Exception as exc:  # noqa: BLE001 - 排查脚本，任何异常都照实打印
        return 0, str(exc).encode(), {}


def main() -> None:
    token = ""
    if os.path.isfile(TOKEN_FILE):
        token = open(TOKEN_FILE).read().strip()

    print("== 1. 网关 index.html ==")
    status, body, headers = get(f"{GW}/")
    print(f"  status={status} cache-control={headers.get('Cache-Control')}")
    html = body.decode("utf-8", "replace")
    import re

    chunk = re.search(r"assets/index-[A-Za-z0-9_-]+\.js", html)
    print(f"  main chunk: {chunk.group(0) if chunk else '(没找到)'}")
    if chunk:
        st, js, _ = get(f"{GW}/{chunk.group(0)}")
        text = js.decode("utf-8", "replace")
        print(f"  chunk status={st} bytes={len(js)}")
        for needle in ('useState("browse")', '"box","框选"', "artifacts_cad", "/viewer"):
            print(f"    contains {needle!r}: {needle in text}")

    print("== 2. 成果台三维成果 ==")
    status, body, _ = get(f"{CONSOLE}/api/artifacts/health", token)
    print(f"  health status={status}")

    status, body, _ = get(f"{CONSOLE}/api/artifacts/workspace", token)
    print(f"  workspace status={status}")
    if status != 200:
        print(body[:400])
        return
    data = json.loads(body)
    exts: dict[str, int] = {}
    models: list[tuple[str, str]] = []
    for project in data.get("projects", []):
        for session in project.get("sessions", []) or []:
            for art in session.get("artifacts", []) or []:
                name = (art.get("file_name") or art.get("source_path") or "").split("/")[-1]
                ext = os.path.splitext(name)[1].lower()
                if art.get("kind") == "model3d" or ext in {
                    ".glb", ".gltf", ".obj", ".stl", ".ply", ".3ds", ".dae", ".3mf",
                    ".step", ".stp", ".iges", ".igs",
                }:
                    models.append((art.get("id", ""), name))
                exts[ext or "(无后缀)"] = exts.get(ext or "(无后缀)", 0) + 1
    print(f"  成果扩展名分布: {exts}")
    print(f"  三维类成果 {len(models)} 条：")
    for aid, name in models:
        print(f"    {aid}  {name}")

    print("== 3. STEP 走 /viewer ==")
    for aid, name in models:
        if os.path.splitext(name)[1].lower() in {".step", ".stp", ".iges", ".igs"}:
            status, body, headers = get(f"{CONSOLE}/api/artifacts/{aid}/viewer", token)
            print(f"  {name}: status={status} content-type={headers.get('Content-Type')} "
                  f"bytes={len(body)}")
            if status != 200:
                print(f"    body: {body[:300]!r}")


if __name__ == "__main__":
    main()
