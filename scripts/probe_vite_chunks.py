#!/usr/bin/env python3
"""用 bundle 开头 __vite__mapDeps 里的权威 chunk 清单，逐个探测网关能否提供。

比正则扫全文更可靠：mapDeps 就是 Vite 运行时真正会 import 的全部文件。

用法: python3 scripts/probe_vite_chunks.py <bundle文件> [网关地址]
"""
import re
import subprocess
import sys
from collections import Counter

BUNDLE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/pdv_app.js"
BASE = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:5186").rstrip("/")

src = open(BUNDLE, encoding="utf-8", errors="replace").read(200_000)

# mapDeps 的清单就在文件最开头的 m.f=[...] 里
start = src.find("m.f=[")
if start == -1:
    print("没找到 mapDeps 清单，退回全文正则")
    files = sorted(set(re.findall(r'"(assets/[^"]+)"', src)))
else:
    end = src.find("])", start)
    files = sorted(set(re.findall(r'"(assets/[^"]+)"', src[start:end])))

print(f"权威 chunk 清单: {len(files)} 个")
print("类型分布:", dict(Counter(f.rsplit(".", 1)[-1] for f in files)))

bad = []
for f in files:
    code = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "--max-time", "10", f"{BASE}/{f}"],
        capture_output=True, text=True,
    ).stdout.strip()
    if code != "200":
        bad.append((code, f))

print(f"\n非 200 的: {len(bad)}")
for c, f in bad:
    print(f"  {c}  {f}")
if not bad:
    print("  全部可正常获取")
