#!/usr/bin/env python3
"""List PilotDeck gateway sessions over the native WS protocol.

Prints only structural fields (key/title/state) — never message content —
so it is safe to paste into a report.

Usage:
    python3 gateway_sessions.py [--ws ws://127.0.0.1:18789/ws]
                                 [--token-file ~/.pilotdeck/server-token]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from room_orchestrator import GatewayClient, resolve_token  # noqa: E402


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ws", default="ws://127.0.0.1:18789/ws")
    ap.add_argument("--token-file", default="")
    args = ap.parse_args()

    token = resolve_token() if not args.token_file else open(args.token_file).read().strip()
    gw = GatewayClient(args.ws, token)
    try:
        await gw.connect()
        result = await gw.request("list_sessions", {})
    finally:
        await gw.close()

    sessions = []
    if isinstance(result, dict):
        for key in ("sessions", "items", "list"):
            if isinstance(result.get(key), list):
                sessions = result[key]
                break
        else:
            sessions = [v for v in result.values() if isinstance(v, dict)]
    print(f"sessions.count = {len(sessions)}")
    if sessions and isinstance(sessions[0], dict):
        print("item.keys =", sorted(sessions[0].keys()))
    for item in sessions:
        if not isinstance(item, dict):
            print("  -", item)
            continue
        key = (item.get("sessionKey") or item.get("key") or item.get("id")
               or item.get("sessionId") or item.get("session_id"))
        print("  -", json.dumps({
            "sessionKey": key,
            "title": (item.get("title") or item.get("name") or "")[:60],
            "state": item.get("state") or item.get("status"),
            "projectKey": item.get("projectKey") or item.get("project"),
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
