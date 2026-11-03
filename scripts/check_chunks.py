#!/usr/bin/env python3
"""枚举 dist 目录里真实存在的静态文件，逐个验证网关是否真的发得出来。

比从 bundle 里猜路径可靠得多 —— 直接以磁盘为准，
任何在磁盘上却取不到的 /assets/* 文件，就是 Android Chrome 上
动态 import 会炸、进而触发 location.reload() 自愈刷新的元凶。

用法: python3 scripts/check_chunks.py [网关地址] [dist目录]
"""
import subprocess
import sys
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5186").rstrip("/")
DIST = Path(sys.argv[2] if len(sys.argv) > 2
            else "/home/marc/PilotV/web/dist")


def head_code(path):
    return subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "--max-time", "10", f"{BASE}{path}"],
        capture_output=True, text=True,
    ).stdout.strip()


if not DIST.is_dir():
    sys.exit(f"dist 目录不存在: {DIST}")

assets = sorted(p for p in DIST.rglob("*") if p.is_file())
print(f"dist: {DIST}")
print(f"共 {len(assets)} 个文件\n")

bad = []
for f in assets:
    rel = "/" + f.relative_to(DIST).as_posix()
    code = head_code(rel)
    if code != "200":
        bad.append((rel, code))
        print(f"  {code}  {rel}")

print(f"\n{len(assets) - len(bad)}/{len(assets)} 个文件可正常获取")
if bad:
    print("=> 有文件取不到。前端动态 import 失败会触发 location.reload() 自愈刷新，")
    print("   表现就是「登录成功后又被刷回登录页」。")
else:
    print("=> 静态资源全部正常，chunk 加载失败这个猜想被证伪。")
