#!/usr/bin/env python3
"""验 MCP 侧车（8801）能不能真的调到 console（8799）：握手 + 一次真工具调用。"""
import json
import sys
import urllib.request

SIDE = "http://127.0.0.1:8801/api/artifacts-mcp"


def rpc(method, params=None, sid=None, _id=1):
    payload = {"jsonrpc": "2.0", "id": _id, "method": method}
    if params is not None:
        payload["params"] = params
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    if sid:
        headers["Mcp-Session-Id"] = sid
    req = urllib.request.Request(SIDE, data=json.dumps(payload).encode(),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")
            return r.status, r.headers.get("Mcp-Session-Id"), body
    except Exception as e:
        return 0, None, f"{type(e).__name__}: {e}"


def parse(body):
    for line in body.splitlines():          # SSE 或纯 JSON 都吃
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                pass
    return {}


st, sid, body = rpc("initialize", {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "verify", "version": "1"},
})
init = parse(body)
print(f"[1] initialize            HTTP {st}  session={sid or '无'}  "
      f"server={init.get('result', {}).get('serverInfo', {}).get('name', '?')}")

if st != 200:
    print("握手就失败了，后续不测")
    sys.exit(1)

st, _, body = rpc("tools/list", {}, sid, 2)
tools = parse(body).get("result", {}).get("tools", [])
print(f"[2] tools/list            HTTP {st}  {len(tools)} 个工具: "
      f"{', '.join(t['name'] for t in tools)}")

# 拿一个真成果 id 试反馈查询（只读，不改数据）
token = ""
for line in open("/vol3/1000/Work/00/PilotV/.artifacts-secrets.env", encoding="utf-8"):
    if line.startswith("ARTIFACTS_TOKEN="):
        token = line.split("=", 1)[1].strip()
import urllib.request as _u
req = _u.Request("http://127.0.0.1:8799/api/artifacts?limit=1",
                 headers={"Authorization": f"Bearer {token}"})
with _u.urlopen(req, timeout=15) as r:
    arts = json.loads(r.read()).get("artifacts", [])
aid = arts[0]["id"] if arts else ""

st, _, body = rpc("tools/call",
                  {"name": "get_artifact_feedback", "arguments": {"artifact_id": aid}},
                  sid, 3)
res = parse(body)
content = res.get("result", {}).get("content", [])
text = content[0].get("text", "") if content else json.dumps(res)[:200]
# 注意：工具失败时 JSON-RPC 外层仍是 200，错误藏在 content 文本里
# （侧车把后端 fetch 失败原样包成文本）。只判 HTTP 码会把失败读成通过。
ok = (st == 200 and "error" not in res
      and not any(w in text for w in ("失败", "fetch failed", "unauthorized", "error")))
print(f"[3] get_artifact_feedback HTTP {st}  {'OK' if ok else 'FAIL'}  "
      f"id={aid[:8]}…  {text[:110]}")

sys.exit(0 if ok and len(tools) >= 4 else 1)