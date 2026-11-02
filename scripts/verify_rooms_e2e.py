#!/usr/bin/env python3
"""End-to-end verification of the PilotV project-room loop.

Runs on the machine that hosts the gateway + console:

  1. creates a room through the **PilotV gateway** (default http://127.0.0.1:5187)
     so the /api/artifacts/rooms routing is exercised, not the console directly
  2. binds a member to a **real gateway session** (new_session by default)
  3. posts a message with an @mention
  4. polls the delivery state until it reaches a terminal state
  5. prints the room transcript so the agent's write-back is visible

Usage:
    python3 verify_rooms_e2e.py [--gateway http://127.0.0.1:5187]
                                [--ws ws://127.0.0.1:18789/ws]
                                [--session-key KEY] [--timeout 240]
                                [--keep-room]
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

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from room_orchestrator import GatewayClient, resolve_token  # noqa: E402

TERMINAL = {"completed", "failed", "rejected", "skipped"}


def http_json(url: str, payload=None, method=None, timeout: float = 30.0):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method or ("POST" if payload is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, {"error": body[:400]}


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gateway", default="http://127.0.0.1:5187")
    ap.add_argument("--ws", default="ws://127.0.0.1:18789/ws")
    ap.add_argument("--session-key", default="")
    ap.add_argument("--timeout", type=float, default=240.0)
    ap.add_argument("--keep-room", action="store_true")
    ap.add_argument("--name", default="E2E 验收房间")
    args = ap.parse_args()

    gw_api = args.gateway.rstrip("/")
    gw = GatewayClient(args.ws, resolve_token())
    created_session = None
    try:
        await gw.connect()

        # ---------------------------------------------------------- 会话
        session_key = args.session_key
        if not session_key:
            res = await gw.request("new_session", {
                "channelKey": "web",
                "projectKey": "/vol3/1000/Work/00/PilotV",
                "hint": "项目室 E2E 验收：作为 worker 响应 @ 指令，并把结论回写房间。",
            })
            session_key = (res or {}).get("sessionKey")
            created_session = session_key
        print("session.key =", session_key)
        if not session_key:
            print("!! 没有拿到 sessionKey，无法继续")
            return 2

        # ---------------------------------------------------------- 房间
        status, body = http_json(f"{gw_api}/api/artifacts/rooms", {
            "name": args.name,
            "respond_policy": "mentions",
            "bulletin": "这是 E2E 验收房间：worker 收到 @ 后应把结论回写房间。",
        })
        print(f"room.create status={status}")
        if status != 200:
            print("  body =", json.dumps(body, ensure_ascii=False)[:600])
            return 2
        room = body.get("room") or {}
        rid = room.get("id")
        print("room.id =", rid)

        status, body = http_json(f"{gw_api}/api/artifacts/rooms/{rid}/members", {
            "display_name": "worker",
            "role": "worker",
            "session_key": session_key,
        })
        print(f"room.member status={status}")
        if status != 200:
            print("  body =", json.dumps(body, ensure_ascii=False)[:600])
            return 2
        member = body.get("member") or body
        print("room.member_id =", member.get("member_id") or member.get("memberId"))

        # ---------------------------------------------------------- 消息
        status, body = http_json(f"{gw_api}/api/artifacts/rooms/{rid}/messages", {
            "text": "@worker 请回复一句『E2E 收到』并调用 post_room_message 把结论写回房间。",
            "role": "user",
            "author": "marc",
            "kind": "text",
        })
        print(f"room.message status={status}")
        if status != 200:
            print("  body =", json.dumps(body, ensure_ascii=False)[:600])
            return 2
        msg = body.get("message") or body
        seq = msg.get("seq")
        print("room.message seq =", seq)

        # ---------------------------------------------------------- 投递
        deadline = time.time() + args.timeout
        seen = {}
        last = None
        while time.time() < deadline:
            status, body = http_json(f"{gw_api}/api/artifacts/rooms/{rid}/deliveries")
            items = (body or {}).get("deliveries") or []
            for item in items:
                key = (item.get("msg_seq"), item.get("member_id"))
                state = item.get("state")
                if seen.get(key) != state:
                    seen[key] = state
                    print(f"delivery seq={item.get('msg_seq')} member={item.get('display_name')} "
                          f"state={state} reason={str(item.get('reason') or '')[:160]}")
            current = next((i for i in items if i.get("msg_seq") == seq), None)
            if current and current.get("state") in TERMINAL:
                last = current
                break
            await asyncio.sleep(3)
        if last is None:
            print("!! 投递未在超时内到达终态")
            last = (body or {}).get("deliveries", [{}])[0] if body else {}

        # ---------------------------------------------------------- 转录
        status, body = http_json(f"{gw_api}/api/artifacts/rooms/{rid}/messages?limit=50")
        for item in (body or {}).get("messages") or []:
            print(f"--- seq={item.get('seq')} role={item.get('role')} "
                  f"author={item.get('author')} mentions={item.get('mentions')}")
            print((item.get("text") or "")[:800])

        if created_session and not args.keep_room:
            try:
                await gw.request("close_session", {"sessionKey": created_session,
                                                    "reason": "room e2e cleanup"})
                print("session.cleanup = closed", created_session)
            except Exception as exc:  # noqa: BLE001
                print("session.cleanup failed:", exc)
        print("room.id =", rid, "(保留以便人工查看)" if args.keep_room else "(可手动删除)")
        return 0
    finally:
        await gw.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
