#!/usr/bin/env python3
"""查两件事：MCP 长轮询的叫醒时延，以及期间控制台事件循环有没有被卡住。

叫醒慢只有两种可能：服务端慢，或者服务端被别的活堵住了。
这个脚本同时量两边 —— 派发在第 5 秒发生，同时每 200ms 打一次 health，
最后报告「叫醒耗时」和「健康检查最大耗时」。后者大就说明事件循环被堵了。

    python3 scripts/probe_wake_latency.py [--hold 5]
"""
import argparse
import json
import sys
import threading
import time
import urllib.request

API = "http://127.0.0.1:8899"
MCP = "http://127.0.0.1:8801/api/artifacts-mcp"


def jpost(url, payload, hdr=None, timeout=40):
    h = {"Content-Type": "application/json"}
    h.update(hdr or {})
    r = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=h, method="POST")
    t0 = time.time()
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.read().decode(), time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hold", type=float, default=5.0, help="几秒后派发返工")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args()

    listing = json.loads(urllib.request.urlopen(API + "/api/artifacts?limit=1", timeout=10).read())
    aid = listing["artifacts"][0]["id"]
    try:                                   # 回到 ready，让派发走完整状态流转
        jpost(API + f"/api/artifacts/{aid}/status", {"status": "ready", "force": True}, timeout=10)
    except Exception:
        pass

    worst = [0.0]
    stop = threading.Event()

    def pinger():
        while not stop.is_set():
            t0 = time.time()
            try:
                urllib.request.urlopen(API + "/api/artifacts/health", timeout=5).read()
            except Exception as exc:
                worst[0] = max(worst[0], 99.0)
                print("  health 失败:", exc)
            worst[0] = max(worst[0], time.time() - t0)
            time.sleep(0.2)

    ping = threading.Thread(target=pinger, daemon=True)
    ping.start()
    time.sleep(0.5)

    def dispatch_later():
        time.sleep(args.hold)
        _, dt = jpost(API + f"/api/artifacts/{aid}/dispatch", {}, timeout=15)
        print(f"  派发请求自身耗时 {dt:.2f}s")

    threading.Thread(target=dispatch_later, daemon=True).start()

    t0 = time.time()
    body, _ = jpost(MCP, {"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                          "params": {"name": "wait_artifact_rework",
                                     "arguments": {"artifact_id": aid, "timeout": args.timeout}}},
                    {"Accept": "application/json, text/event-stream"})
    dt = time.time() - t0
    time.sleep(0.3)
    stop.set()
    ping.join(timeout=2)

    # SSE 里这坨 JSON 是被 JSON 字符串再转义过的，直接 grep 会漏判
    text = "".join(line[5:].strip() for line in body.splitlines()
                   if line.startswith("data:")).replace('\\"', '"')
    woke = '"woke": true' in text
    print(f"派发计划在 {args.hold:.1f}s · MCP 往返 {dt:.2f}s · woke={str(woke).lower()} "
          f"· 唤醒延迟 {dt - args.hold:+.2f}s · health 最大耗时 {worst[0]:.2f}s")
    if worst[0] > 1.0:
        print("  ⚠ 事件循环被堵超过 1s：长轮询慢不是网络问题，是控制台被同步活卡住了")
    return 0 if woke and dt - args.hold < 5 else 1


if __name__ == "__main__":
    sys.exit(main())
