#!/usr/bin/env python3
"""Probe the PilotV artifacts MCP sidecar: initialize + tools/list (+ optional call).

Usage:
    python3 probe_mcp.py [--url http://127.0.0.1:8801/api/artifacts-mcp]
                          [--call TOOL_NAME] [--args JSON]
"""
from __future__ import annotations

import argparse
import json
import urllib.request

ACCEPT = "application/json, text/event-stream"


def rpc(url: str, payload: dict, timeout: float = 20.0) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": ACCEPT},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
    # Streamable HTTP may answer with SSE framing.
    if body.startswith("event:") or body.startswith("data:"):
        chunks = []
        for line in body.splitlines():
            if line.startswith("data:"):
                chunks.append(line[5:].strip())
        body = "".join(chunks)
    return json.loads(body)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8801/api/artifacts-mcp")
    ap.add_argument("--call", default="")
    ap.add_argument("--args", default="{}")
    args = ap.parse_args()

    init = rpc(args.url, {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "probe", "version": "1.0.0"},
        },
    })
    print("initialize.ok =", "result" in init)
    if "error" in init:
        print("initialize.error =", json.dumps(init["error"], ensure_ascii=False))

    listed = rpc(args.url, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = listed.get("result", {}).get("tools", [])
    print(f"tools.count = {len(tools)}")
    for tool in tools:
        print("  -", tool.get("name"))

    if args.call:
        called = rpc(args.url, {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": args.call, "arguments": json.loads(args.args)},
        })
        print("call.result =", json.dumps(called.get("result", called), ensure_ascii=False)[:2000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
