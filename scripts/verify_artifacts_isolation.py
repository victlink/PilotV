#!/usr/bin/env python3
"""验证成果台是「每台设备各一份、切设备就跟着切」，而不是所有设备共用一份。

做法：往某台设备的成果台写一个带唯一标记的成果，再逐台读回来。
只有三种结果算通过：
  1. 只有那台设备看得到它；
  2. 别的设备一个都没有；
  3. 最后把它删掉，清理干净。
读不到标记但也没串台，同样算没串台 —— 但写的那台必须看得到自己写的东西，
否则说明「各一份」根本没成立，那就是失败。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

GATEWAY = os.environ.get("GATEWAY", "http://127.0.0.1:5186")
TOKEN = ""
TOKEN_FILE = os.path.expanduser("~/.config/pilotv/artifacts-token")

DEVICES = [
    ("本机", None),
    ("marc", "http://100.72.0.111:3001"),
    ("leo", "http://100.117.103.34:3002"),
    ("jx88", "http://100.108.86.109:3001"),
]
MARKER = "串台检测-" + str(int(time.time()))


def call(origin, path, method="GET", payload=None):
    url = f"{GATEWAY}{path}"
    if origin:
        url += ("&" if "?" in url else "?") + "device=" + urllib.parse.quote(origin, safe="")
    request = urllib.request.Request(url, method=method)
    if origin:
        # 网关优先看 X-PilotV-Device；这个头不会被代理到后端。
        request.add_header("X-PilotV-Device", origin)
    if TOKEN:
        request.add_header("Authorization", f"Bearer {TOKEN}")
    if payload is not None:
        request.add_header("content-type", "application/json")
        request.data = json.dumps(payload).encode()
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        try:
            return error.code, json.loads(body)
        except json.JSONDecodeError:
            return error.code, body
    except Exception as error:  # noqa: BLE001 - 验收脚本要如实报告任何异常
        return 0, str(error)


def list_artifacts(origin):
    status, body = call(origin, "/api/artifacts?limit=100")
    if status != 200 or not isinstance(body, dict):
        return None
    return body.get("artifacts") or []


def contains_marker(items):
    return any(MARKER in json.dumps(item, ensure_ascii=False) for item in items or [])


def main() -> int:
    global TOKEN
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, encoding="utf-8") as handle:
            TOKEN = handle.read().strip()

    print(f"标记：{MARKER}")

    # 先确认四台都通，且成果台各自独立（返回的 total 可以不同，但都得是 200 真 JSON）
    baseline = {}
    for name, origin in DEVICES:
        items = list_artifacts(origin)
        if items is None:
            print(f"✘ {name} 的成果台读不到（不是真 JSON）")
            return 1
        baseline[name] = len(items)
        print(f"  {name:<6} 起始 {len(items)} 条")

    target_name, target_origin = DEVICES[3]  # jx88
    print(f"\n往 {target_name} 写一条带标记的成果")
    status, body = call(target_origin, "/api/artifacts", "POST", {
        "kind": "doc",
        "title": MARKER,
        "summary": "用来验证成果台是否各设备独立",
        "status": "pending",
    })
    print(f"  写入结果：{status} {json.dumps(body, ensure_ascii=False)[:120]}")
    if status not in (200, 201):
        print("✘ 写入失败，无法验证隔离")
        return 1

    time.sleep(1)
    print("\n逐台读回：只有目标设备该看到它")
    leaked = []
    seen_on_target = False
    for name, origin in DEVICES:
        items = list_artifacts(origin)
        hit = contains_marker(items)
        delta = len(items) - baseline[name]
        print(f"  {name:<6} 共 {len(items)} 条（{delta:+d}）  {'看到标记 ✘' if hit else '干净'}")
        if hit:
            if name == target_name:
                seen_on_target = True
            else:
                leaked.append(name)

    # 清理
    for item in list_artifacts(target_origin) or []:
        if contains_marker([item]):
            call(target_origin, f"/api/artifacts/{item.get('id')}", "DELETE")

    print()
    if leaked:
        print(f"✘ 串台了：{'、'.join(leaked)} 也看到了 {target_name} 的成果")
        return 1
    if not seen_on_target:
        print(f"✘ {target_name} 自己都看不到刚写的成果，说明「各设备一份」没成立")
        return 1
    print("✓ 成果不串台：各设备各一份，切设备就跟着切")
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402 - 放在这里只为了上面 call() 里能用到
    sys.exit(main())