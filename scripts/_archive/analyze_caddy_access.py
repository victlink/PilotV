#!/usr/bin/env python3
"""分析 caddy 访问日志，定位用户实际使用的 PilotV 入口。

用途：确认用户是从哪个 host/uri 打开 PilotV 的（NAS 自部署 / tailscale serve /
Caddy HTTPS），从而判断新 bundle 是否真的送达用户浏览器。

用法：
  sudo python3 scripts/_archive/analyze_caddy_access.py [--limit 20]
  python3 scripts/_archive/analyze_caddy_access.py --log /path/to/other.log
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

DEFAULT_LOG = "/var/log/caddy/pilotv.log"


def parse(path: str):
    hosts = collections.Counter()
    uris = collections.Counter()
    bundles = collections.Counter()
    recent = []
    total = 0
    unparsed = 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                unparsed += 1
                continue
            total += 1
            req = rec.get("request", {}) or {}
            host = req.get("host", "") or ""
            uri = req.get("uri", "") or ""
            hosts[host] += 1
            uris[uri] += 1
            if uri.startswith("/assets/index-"):
                bundles[uri] += 1
            recent.append((rec.get("ts", ""), host, uri))
    return total, unparsed, hosts, uris, bundles, recent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()

    path = args.log
    if not os.path.exists(path):
        print(f"日志不存在：{path}")
        return 1
    try:
        total, unparsed, hosts, uris, bundles, recent = parse(path)
    except PermissionError:
        print(f"无读取权限：{path}（需要 sudo 或提升权限）")
        return 1

    print(f"日志文件：{path}")
    print(f"解析成功 {total} 行，跳过非 JSON {unparsed} 行")
    print()
    print("=== 最近请求（最后 %d 条）===" % min(args.limit, len(recent)))
    for ts, host, uri in recent[-args.limit:]:
        print(f"  {ts}  {host:32s}  {uri[:90]}")
    print()
    print("=== Host 分布 ===")
    for host, count in hosts.most_common(10):
        print(f"  {count:8d}  {host}")
    print()
    print("=== 入口 bundle 分布（用户实际加载的 index-*.js）===")
    for bundle, count in bundles.most_common(10):
        print(f"  {count:8d}  {bundle}")
    print()
    print("=== 高频 URI ===")
    for uri, count in uris.most_common(12):
        print(f"  {count:8d}  {uri[:80]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
