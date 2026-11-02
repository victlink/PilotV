#!/usr/bin/env python3
"""房间端到端验收：REST（经网关）+ 真实 @mention 投递（真会话）。

跑在 NAS 上：
    python3 scripts/verify_rooms_nas.py

链路：
    HTTP  → http://127.0.0.1:5187/api/artifacts/rooms*   （PilotV 网关 → console 8799）
    WS    → ws://127.0.0.1:18789/ws                       （编排器投递给真实会话）

不会打印 token / 凭据。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from room_orchestrator import GatewayClient, resolve_token  # noqa: E402

BASE = "http://127.0.0.1:5187"
WS_URL = "ws://127.0.0.1:18789/ws"
PROJECT_KEY = "/vol3/1000/Work/00/PilotV"


def http(method: str, path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {body[:300]}") from exc


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=int, default=240, help="等待投递落地的秒数")
    ap.add_argument("--room-name", default="验收房间")
    ap.add_argument("--keep", action="store_true", help="保留房间（默认关掉自动投递）")
    args = ap.parse_args()

    failures: list[str] = []

    # ---------------------------------------------------------------- gateway
    gw = GatewayClient(WS_URL, resolve_token())
    await gw.connect()
    print("[1] gateway hello ok:", (gw.hello or {}).get("protocolVersion"))

    sessions = await gw.request("list_sessions", {})
    existing = (sessions or {}).get("sessions") or []
    print(f"[2] gateway sessions = {len(existing)}")

    worker_key = reviewer_key = ""
    try:
        worker = await gw.request("new_session", {
            "channelKey": "web", "projectKey": PROJECT_KEY, "hint": "room-e2e-worker"})
        worker_key = (worker or {}).get("sessionKey") or ""
        reviewer = await gw.request("new_session", {
            "channelKey": "web", "projectKey": PROJECT_KEY, "hint": "room-e2e-reviewer"})
        reviewer_key = (reviewer or {}).get("sessionKey") or ""
        print(f"[3] new sessions: worker={bool(worker_key)} reviewer={bool(reviewer_key)}")
        if not worker_key or not reviewer_key:
            failures.append("new_session 没拿到 sessionKey")
    except Exception as exc:
        failures.append(f"new_session 失败: {exc!r}")
        print("[3] new_session 失败:", repr(exc))

    # ------------------------------------------------------------------- REST
    rid = ""
    try:
        created = http("POST", "/api/artifacts/rooms", {
            "name": f"{args.room_name}-{int(time.time())}",
            "respond_policy": "mentions",
            "bulletin": "验收用房间：@worker 让它回写一句话。",
        })
        rid = ((created.get("room") or {}).get("id")) or ""
        print(f"[4] create room via gateway -> {rid}")
        if not rid:
            failures.append("建房没返回 room id")

        http("POST", f"/api/artifacts/rooms/{rid}/members", {
            "display_name": "worker", "role": "worker", "session_key": worker_key})
        http("POST", f"/api/artifacts/rooms/{rid}/members", {
            "display_name": "reviewer", "role": "reviewer", "session_key": reviewer_key})
        print("[5] members added (worker/reviewer)")

        room = http("GET", f"/api/artifacts/rooms/{rid}")
        names = [m.get("display_name") for m in (room.get("members") or [])]
        print("    members =", names)
        if sorted(names) != ["reviewer", "worker"]:
            failures.append(f"成员列表不对: {names}")

        # 幂等：同一个 idempotency_key 只写一条
        idem = {"text": "@worker 验收：请回写一句“房间链路通了”。",
                "author": "验收员", "role": "user",
                "idempotency_key": "e2e-idem-1"}
        m1 = http("POST", f"/api/artifacts/rooms/{rid}/messages", idem)
        m2 = http("POST", f"/api/artifacts/rooms/{rid}/messages", idem)
        seq1 = (m1.get("message") or {}).get("seq")
        seq2 = (m2.get("message") or {}).get("seq")
        print(f"[6] post message seq={seq1} (idem replay seq={seq2}, created={m2.get('created')})")
        if seq1 != seq2:
            failures.append("幂等键没有生效：两次发帖 seq 不同")
        mentions = (m1.get("message") or {}).get("mentions")
        print("    mentions =", mentions)
        if "worker" not in (mentions or []):
            failures.append(f"@mention 没解析出来: {mentions}")

        # ---------------------------------------------------------- 投递等待
        deadline = time.time() + args.wait
        seen = {}
        while time.time() < deadline:
            d = http("GET", f"/api/artifacts/rooms/{rid}/deliveries")
            for item in (d.get("deliveries") or []):
                key = (item.get("seq"), item.get("member_id"))
                seen[key] = item.get("state")
                if item.get("state") in ("completed", "failed", "rejected", "skipped"):
                    break
            states = list(seen.values())
            if any(s in ("completed", "failed", "rejected", "skipped") for s in states):
                break
            time.sleep(4)

        d = http("GET", f"/api/artifacts/rooms/{rid}/deliveries")
        print("[7] deliveries:")
        for item in (d.get("deliveries") or []):
            print(f"    seq={item.get('seq')} member={item.get('member_id')} "
                  f"state={item.get('state')} reason={str(item.get('reason'))[:160]}")
        states = [i.get("state") for i in (d.get("deliveries") or [])]
        if not any(s in ("completed", "failed", "rejected", "skipped") for s in states):
            failures.append(f"投递没有落到终态（states={states}）")

        msgs = http("GET", f"/api/artifacts/rooms/{rid}/messages?limit=50")
        print("[8] room transcript:")
        for m in (msgs.get("messages") or []):
            print(f"    seq={m.get('seq')} role={m.get('role')} author={m.get('author')} "
                  f"text={str(m.get('text'))[:120]}")
        bot_msgs = [m for m in (msgs.get("messages") or [])
                    if (m.get("author") or "") in ("worker", "reviewer")]
        if bot_msgs:
            print(f"[9] agent 回写了 {len(bot_msgs)} 条明文")
        else:
            print("[9] agent 还没回写明文（交付状态见上面 deliveries）")
    except Exception as exc:
        failures.append(f"REST 流程异常: {exc!r}")
        print("REST 流程异常:", repr(exc))
    finally:
        if rid and not args.keep:
            try:
                http("PATCH", f"/api/artifacts/rooms/{rid}", {"respond_policy": "off"})
                print("[10] room 自动投递已关（respond_policy=off）")
            except Exception as exc:
                print("[10] 关投递失败:", repr(exc))
        for key in (worker_key, reviewer_key):
            if not key:
                continue
            try:
                await gw.request("close_session", {"sessionKey": key})
            except Exception as exc:
                print(f"close_session({key[:8]}…) 失败:", repr(exc))
        await gw.close()

    print()
    if failures:
        print("RESULT: FAIL")
        for f in failures:
            print("  -", f)
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
