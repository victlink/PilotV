#!/usr/bin/env python3
"""把 PilotV 自有代码里的版本号统一提到 1.0.0。

只动 PilotV 自己的版本声明；第三方 / vendored 的版本号原样保留
（computer-use 驱动 0.34.1、edgeclaw-memory-core 0.0.0、funasr 插件 0.2.0）。
逐个精确匹配，不用正则乱扫 —— 改错地方比不改更糟。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEW = "1.0.0"

# (相对路径, 旧值, 新值) —— 只列已确认的 PilotV 自有版本声明
TARGETS = [
    (".pilotdeck/plugins/artifacts/plugin.json", '"version": "0.1.0"', f'"version": "{NEW}"'),
    ("scripts/install_device.py", '"version": "0.1.0"', f'"version": "{NEW}"'),
    ("pilotdeck-mobile/package.json", '"version":"0.1.0"', f'"version":"{NEW}"'),
    ("pilotdeck-mobile/gateway/package.json", '"version": "0.1.0"', f'"version": "{NEW}"'),
    ("pilotdeck-mobile/upstream-official/package.json", '"version": "0.1.0"', f'"version": "{NEW}"'),
    ("pilotdeck-mobile/upstream-official/ui/package.json", '"version": "0.1.0"', f'"version": "{NEW}"'),
    ("pilotdeck-mobile/upstream-official/apps/desktop/package.json", '"version": "0.1.0"', f'"version": "{NEW}"'),
    ("artifacts-mcp.mjs", 'version: "0.1.0"', f'version: "{NEW}"'),
]

SKIP = {"node_modules", "dist", ".git", "target", "build"}

changed, missed = [], []
for rel, old, new in TARGETS:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        missed.append((rel, "文件不存在"))
        continue
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if old not in text:
        missed.append((rel, f"没找到 {old!r}"))
        continue
    if text.count(old) != 1:
        missed.append((rel, f"{old!r} 出现 {text.count(old)} 次，不敢乱改"))
        continue
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text.replace(old, new))
    changed.append(rel)

# 改完确认 JSON 还能解析
for rel in changed:
    if rel.endswith(".json"):
        try:
            with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
                json.load(fh)
        except Exception as exc:  # noqa: BLE001
            print(f"!! {rel} 改完不是合法 JSON：{exc}", file=sys.stderr)
            sys.exit(1)

print("已更新：")
for rel in changed:
    print(f"  {rel}")
if missed:
    print("未处理：")
    for rel, why in missed:
        print(f"  {rel}：{why}")

# 扫一遍还有没有漏掉的 0.1.0 版本声明
print("\n复查剩余的 0.1.0 声明：")
left = 0
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".")]
    for name in filenames:
        if not name.endswith((".json", ".py", ".mjs", ".js")):
            continue
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, ROOT)
        if rel.startswith(".pilotdeck/work"):
            continue
        try:
            with open(full, encoding="utf-8") as fh:
                for num, line in enumerate(fh, 1):
                    if re.search(r'"?version"?\s*[:=]\s*"0\.1\.0"', line):
                        print(f"  {rel}:{num}  {line.strip()[:110]}")
                        left += 1
        except Exception:  # noqa: BLE001
            continue
print("无遗漏" if not left else f"还剩 {left} 处")
