#!/usr/bin/env python3
"""验证 React 组件的动效与批准版母版逐帧一致。

两份 CSS 都由生成器从同一份批准源派生，但"同一份源"只是我们的说法 ——
这里把关键帧块按括号配对原样抽出来做文本比对，声称一致就得真的文本一致。

上一版用 `@keyframes name{(.*?)\\n}` 提取，而母版的关键帧是单行紧凑写法，
一个都没匹配到，空集比较让脚本"全过" —— 所以这里显式把提取为空判为失败。
"""
import re
import sys
from pathlib import Path

REPO = Path('/home/marc/PilotV')
CANON = REPO / '常用资料/PilotV-Logo-3D/蓝橙循环版/pilotv-loop.svg'
CSS = REPO / 'pilotdeck-mobile/upstream-official/ui/src/components/app-shell/PilotVLogo.css'
ANIM = REPO / 'brand/pilotv-logo-animated.svg'
PREFIX = 'pv-loop-'


def blocks(text: str) -> dict[str, str]:
    """用括号配对抽取 @keyframes 正文，支持单行紧凑写法。"""
    out: dict[str, str] = {}
    for m in re.finditer(r'@keyframes\s+([\w-]+)\s*\{', text):
        i = m.end()
        depth = 1
        while i < len(text) and depth:
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
            i += 1
        out[m.group(1)] = text[m.end():i - 1]
    return out


def frames(body: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(r'([\d.]+%)\s*\{([^{}]*)\}', body):
        out[m.group(1)] = m.group(2).strip()
    return out


def style_of(svg: str) -> str:
    return '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', svg, re.S))


checks: list[tuple[str, bool, str]] = []

canon = blocks(style_of(CANON.read_text(encoding='utf-8')))
comp_raw = blocks(CSS.read_text(encoding='utf-8'))
anim = blocks(style_of(ANIM.read_text(encoding='utf-8')))

# 组件把关键帧加了作用域前缀，比对时映射回去
comp = {k[len(PREFIX):] if k.startswith(PREFIX) else k: v for k, v in comp_raw.items()}

print(f'提取到关键帧 —— 母版 {len(canon)} / 组件 CSS {len(comp_raw)} / 动画 SVG {len(anim)}')
for label, got in [('母版', canon), ('组件 CSS', comp_raw), ('动画 SVG', anim)]:
    checks.append((f'{label} 关键帧非空', len(got) > 0, f'实际 {len(got)}'))

expected = set(canon)
print(f'\n=== 名称集合 ===')
print(f'  母版:          {sorted(expected)}')
print(f'  组件 CSS:      {sorted(comp)}')
print(f'  组件多出: {sorted(set(comp) - expected) or "无 ✓"}')
print(f'  组件缺失: {sorted(expected - set(comp)) or "无 ✓"}')
checks.append(('组件无多余关键帧', not set(comp) - expected, ''))
checks.append(('组件无缺失关键帧', not expected - set(comp), ''))

print(f'\n=== 逐帧正文比对（母版 vs 组件 CSS）===')
for name in sorted(expected & set(comp)):
    fc, fk = frames(canon[name]), frames(comp[name])
    same_keys = set(fc) == set(fk)
    same_body = fc == fk
    ok = same_keys and same_body
    checks.append((f'关键帧 {name}', ok, ''))
    flag = '一致 ✓' if ok else '不一致 ✗'
    print(f'  {name:14s} 母版 {len(fc):3d} 帧 / 组件 {len(fk):3d} 帧  {flag}')
    if not ok:
        miss = sorted(set(fc) - set(fk), key=lambda x: float(x[:-1]))
        extra = sorted(set(fk) - set(fc), key=lambda x: float(x[:-1]))
        if miss:
            print(f'      组件缺帧: {miss[:6]}{"…" if len(miss) > 6 else ""}')
        if extra:
            print(f'      组件多帧: {extra[:6]}{"…" if len(extra) > 6 else ""}')
        for k in sorted(set(fc) & set(fk), key=lambda x: float(x[:-1])):
            if fc[k] != fk[k]:
                print(f'      {k} 母版: {fc[k][:90]}')
                print(f'      {k} 组件: {fk[k][:90]}')
                break

print(f'\n=== 逐帧正文比对（母版 vs 动画 SVG）===')
for name in sorted(expected & set(anim)):
    ok = frames(canon[name]) == frames(anim[name])
    checks.append((f'SVG 关键帧 {name}', ok, ''))
    print(f'  {name:14s} {"一致 ✓" if ok else "不一致 ✗"}')

print('\n=== 静态 / 减动效兜底 ===')
css_text = CSS.read_text(encoding='utf-8')
for label, needle in [
    ('组件减动效停动画', 'prefers-reduced-motion:reduce'),
    ('组件静态模式停动画', '.pv-logo:not(.pv-logo--animated)'),
    ('减动效隐藏 V 侧棱', 'pv-logo__v-edge{animation:none!important;opacity:0!important}'),
]:
    hit = needle in css_text
    checks.append((label, hit, ''))
    print(f'  {label:24s} {"✓" if hit else "✗ 缺失"}')

bad = [n for n, ok, _ in checks if not ok]
print('\n=== 结果 ===')
for n, ok, extra in checks:
    if not ok:
        print(f'  ✗ {n} {extra}')
print(f'{len(checks) - len(bad)}/{len(checks)} 项通过')
sys.exit(1 if bad else 0)
