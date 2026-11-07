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

# (相对路径, 版本键的正则, 替换模板) —— 只列已确认的 PilotV 自有版本声明
#
# 这里按「版本键」匹配，不按旧值匹配。原先写死 '"version": "0.1.0"'，
# 第一次跑完所有文件都变成 1.0.0 之后，这个脚本就成了永远匹配不上的空操作，
# 看起来执行成功、实际什么都没做。改成按键匹配才能重复执行。
TARGETS = [
    (".pilotdeck/plugins/artifacts/plugin.json", r'("version"\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
    ("scripts/install_device.py", r'("version"\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
    ("pilotdeck-mobile/package.json", r'("version"\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
    ("pilotdeck-mobile/gateway/package.json", r'("version"\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
    ("pilotdeck-mobile/upstream-official/package.json", r'("version"\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
    ("pilotdeck-mobile/upstream-official/ui/package.json", r'("version"\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
    ("pilotdeck-mobile/upstream-official/apps/desktop/package.json", r'("version"\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
    ("artifacts-mcp.mjs", r'(version\s*:\s*)"[^"]*"', r'\g<1>"%s"' % NEW),
]

SKIP = {"node_modules", "dist", ".git", "target", "build"}

changed, missed = [], []
for rel, pattern, repl in TARGETS:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        missed.append((rel, "文件不存在"))
        continue
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    new_text, n = re.subn(pattern, repl, text, count=2)
    if n == 0:
        missed.append((rel, f"没匹配到版本键 {pattern!r}"))
        continue
    if n > 1:
        missed.append((rel, f"版本键匹配到 {n} 处，不敢乱改"))
        continue
    if new_text == text:
        # 已经是目标值，说明本来就对，不算改动
        changed.append(rel + "（本就正确）")
        continue
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(new_text)
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
