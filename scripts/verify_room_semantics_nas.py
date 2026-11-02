#!/usr/bin/env python3
"""房间语义回归：预算 / 策略 / 幂等 / 错误路径。

跑在 NAS 上：python3 scripts/verify_room_semantics_nas.py
全部用**假 session_key**，所以不会真的调用模型，只验证编排器的判定逻辑。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5187"
BUDGET = 20
failures: list[str] = []


def http(method: str, path: str, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:300]


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


def new_room(name: str, policy: str = "mentions") -> str:
    _, out = http("POST", "/api/artifacts/rooms", {"name": name, "respond_policy": policy})
    return ((out.get("room") or {}).get("id")) or ""


def deliveries(rid: str):
    _, out = http("GET", f"/api/artifacts/rooms/{rid}/deliveries")
    return out.get("deliveries") or []


print("=== 1. 错误路径 ===")
code, _ = http("GET", "/api/artifacts/rooms/room_does_not_exist")
check("未知房间 GET 返回 404", code == 404, f"got {code}")
code, _ = http("POST", "/api/artifacts/rooms/room_does_not_exist/messages", {"text": "x"})
check("未知房间发帖返回 404", code == 404, f"got {code}")
rid = new_room("语义-错误路径")
code, body = http("POST", f"/api/artifacts/rooms/{rid}/messages", {"text": "   "})
check("空正文返回 400", code == 400, f"got {code}")
code, body = http("POST", f"/api/artifacts/rooms/{rid}/members", {"display_name": "x", "role": "worker"})
check("worker 缺 session_key 返回 400", code == 400, f"got {code}")
code, body = http("POST", f"/api/artifacts/rooms/{rid}/members",
                  {"display_name": "human1", "role": "human"})
check("human 成员不需要 session_key", code == 200, f"got {code}")
code, body = http("POST", f"/api/artifacts/rooms/{rid}/members",
                  {"display_name": "human1", "role": "human"})
check("重名成员返回 400", code == 400, f"got {code}")
code, body = http("POST", f"/api/artifacts/rooms/{rid}/members",
                  {"display_name": "w2", "role": "worker", "session_key": "s-1"})
check("绑定 session_key 成功", code == 200, f"got {code}")
code, body = http("POST", f"/api/artifacts/rooms/{rid}/members",
                  {"display_name": "w3", "role": "worker", "session_key": "s-1"})
check("同一 session_key 复用返回 400", code == 400, f"got {code}")

print("=== 2. 幂等 ===")
key = f"sem-idem-{int(time.time())}"
_, a = http("POST", f"/api/artifacts/rooms/{rid}/messages",
            {"text": "同一条", "idempotency_key": key})
_, b = http("POST", f"/api/artifacts/rooms/{rid}/messages",
            {"text": "同一条", "idempotency_key": key})
check("幂等键不重复写库",
      (a.get("message") or {}).get("seq") == (b.get("message") or {}).get("seq")
      and b.get("created") is False)

print("=== 3. 策略 off ===")
rid_off = new_room("语义-策略off", policy="off")
http("POST", f"/api/artifacts/rooms/{rid_off}/members",
     {"display_name": "worker", "role": "worker", "session_key": "s-off"})
http("POST", f"/api/artifacts/rooms/{rid_off}/messages",
     {"text": "@worker 在关停策略下不应该被投递", "author": "验收员", "role": "user"})
time.sleep(3)
items = deliveries(rid_off)
states = [i.get("state") for i in items]
reasons = " ".join(str(i.get("reason") or "") for i in items)
check("off 策略记 skipped", states and all(s == "skipped" for s in states), str(states))
check("off 策略写明原因", "off" in reasons or "策略" in reasons, reasons[:120])

print("=== 4. 成员没有 session_key → skipped，且不占预算 ===")
rid_nos = new_room("语义-无会话")
http("POST", f"/api/artifacts/rooms/{rid_nos}/members",
     {"display_name": "worker", "role": "reviewer"})  # reviewer 也必须给 session_key，这里故意用错角色
http("POST", f"/api/artifacts/rooms/{rid_nos}/messages",
     {"text": "@worker 看看", "author": "验收员", "role": "user"})
time.sleep(3)
items = deliveries(rid_nos)
check("没有 session_key 的成员被 skipped",
      bool(items) and all(i.get("state") == "skipped" for i in items),
      str([i.get("state") for i in items]))

print("=== 5. 预算耗尽（假 session，每条都会 failed 但要真投） ===")
rid_b = new_room("语义-预算")
http("POST", f"/api/artifacts/rooms/{rid_b}/members",
     {"display_name": "worker", "role": "worker", "session_key": "session-nonexistent-key"})
for i in range(BUDGET + 1):
    http("POST", f"/api/artifacts/rooms/{rid_b}/messages",
         {"text": f"@worker 第 {i + 1} 条", "author": "验收员", "role": "user"})
    time.sleep(0.6)
time.sleep(4)
items = deliveries(rid_b)
states = [i.get("state") for i in items]
reasons = " ".join(str(i.get("reason") or "") for i in items)
check(f"预算用满后新消息被 skipped（共 {len(items)} 条）",
      "skipped" in states, str(states[-3:]))
check("skipped 的原因是预算耗尽", "预算" in reasons, reasons[-200:])

print()
if failures:
    print("RESULT: FAIL")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)
print("RESULT: PASS")
