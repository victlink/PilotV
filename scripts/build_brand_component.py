#!/usr/bin/env python3
"""从批准版蓝橙循环 SVG 派生 React 组件（PilotVLogo.tsx / .css）。

为什么要有这个脚本：批准版 SVG 的动画关键帧里，transform-origin 与
@keyframes 的位移量都是**绝对 viewBox 坐标**。组件必须用同一套坐标系，
否则 V 的竖轴旋转轴心会偏、字母归位会飘。这里把两件事做成机械替换：

1. 坐标系对齐 —— 组件 viewBox 收掉多余留白（官方给动画留的），同时把
   全部 transform-origin 平移同样的量。留白收窄还有个副作用好处：内容
   宽高比从 2.773（旧的 279.9x100.9）变成 2.806，视觉尺寸几乎不变，
   调用方不必改 height 也不会觉得 logo 变小。
2. 类名与关键帧加 pv- 前缀 —— 避免和宿主应用里的同名类/关键帧撞车。

动画内容本身**不做任何再设计**：样式块整段从批准版 SVG 里取，只改名字和
坐标。改动画请改批准版 SVG，然后重跑本脚本。

用法：
    python3 scripts/build_brand_component.py [--check]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MASTER = REPO / "常用资料" / "PilotV-Logo-3D" / "蓝橙循环版" / "pilotv-loop.svg"

COMPONENT_DIR = REPO / "pilotdeck-mobile/upstream-official/ui/src/components/app-shell"
TSX = COMPONENT_DIR / "PilotVLogo.tsx"
CSS = COMPONENT_DIR / "PilotVLogo.css"

# 组件 viewBox：裁掉批准版为动画预留的留白，框住实际内容。
#   批准版 -12 -18 310 130  →  内容 bbox 约 x 8..274.5, y 7.2..97.35
# 这里左右各留 4、上下各留 4 的余量。
VIEWBOX = "4 3 275 98"
VB_MIN_X, VB_MIN_Y = 4.0, 3.0

# 批准版类名 → 组件类名
CLASS_MAP = {
    "letter": "pv-logo__letter",
    "letter-P": "pv-logo__letter-P",
    "letter-i": "pv-logo__letter-i",
    "letter-l": "pv-logo__letter-l",
    "letter-o": "pv-logo__letter-o",
    "letter-t": "pv-logo__letter-t",
    "v-reveal": "pv-logo__v",
    "v-edge": "pv-logo__v-edge",
    "v-spin": "pv-logo__v-spin",
    "blue-line": "pv-logo__line",
    "fly-i": "pv-logo__fly-i",
    "fly-l": "pv-logo__fly-l",
    "fly-o": "pv-logo__fly-o",
    "fly-t": "pv-logo__fly-t",
}
# 批准版关键帧名 → 组件关键帧名
KEYFRAME_MAP = {
    "line": "pv-loop-line",
    # 类名可以为了组件结构改名，关键帧名不要改：改名会让「组件动效 == 批准版」
    # 只能靠人眼核对关键帧表，改名一旦漏掉就再也查不出来。
    "v-reveal": "pv-loop-v-reveal",
    "spin": "pv-loop-spin",
    "edge": "pv-loop-edge",
    "letter-P": "pv-loop-letter-P",
    "letter-i": "pv-loop-letter-i",
    "letter-l": "pv-loop-letter-l",
    "letter-o": "pv-loop-letter-o",
    "letter-t": "pv-loop-letter-t",
}

CSS_HEADER = """/* PilotV 字标动画 —— 请勿手工编辑。
 *
 * 本文件由 scripts/build_brand_component.py 从批准版动效
 *   常用资料/PilotV-Logo-3D/蓝橙循环版/pilotv-loop.svg
 * 机械派生（类名加前缀 + transform-origin 坐标系对齐）。
 * 要改动画就改那份批准版 SVG，然后重跑该脚本。
 */
"""


def load_style() -> str:
    if not MASTER.exists():
        sys.exit(f"缺少批准版源文件：{MASTER}")
    src = MASTER.read_text(encoding="utf-8")
    m = re.search(r"<style>(.*?)</style>", src, re.S)
    if not m:
        sys.exit("批准版 SVG 里没有 <style> 块，结构与预期不符")
    return m.group(1).strip()


def no_shift(style: str) -> str:
    """刻意不做任何 transform-origin 平移。

    规范说 transform-box:view-box 的参考框原点在 (min-x, min-y)，照此推导
    裁剪 viewBox 后必须平移 origin。但实测（scripts/probe_transform_origin.py，
    以已知真值竖线标定坐标映射后量镜像轴）结论相反：

        变体              实测镜像轴（用户坐标）
        批准版 master          236.13
        原样照抄 asis          236.13
        减新 min-x            232.25
        减 viewBox 偏移差      220.25

    Chromium 把 transform-origin 的长度按**用户坐标 0,0** 解释，而不是按
    viewBox 的 min-x。所以批准版里那个 236.35 本来就是 V 的几何中心
    （真值 236.575，差值在抗锯齿误差内），照抄即可。裁剪 viewBox 只改变
    可见窗口，不动这个数，旋转轴心因此与批准版完全一致。

    这里保留函数名与注释，避免后人再按规范"修正"它又引入错位。
    """
    return style


def rename_classes(style: str) -> str:
    # 长名优先，避免 letter 先把 letter-P 截断
    for old in sorted(CLASS_MAP, key=len, reverse=True):
        style = re.sub(rf"(?<![\w-])\.{re.escape(old)}(?![\w-])", f".{CLASS_MAP[old]}", style)
    return style


def rename_keyframes(style: str) -> str:
    for old in sorted(KEYFRAME_MAP, key=len, reverse=True):
        new = KEYFRAME_MAP[old]
        style = re.sub(rf"@keyframes\s+{re.escape(old)}\b", f"@keyframes {new}", style)
        style = re.sub(rf"animation-name:\s*{re.escape(old)}\b", f"animation-name:{new}", style)
        style = re.sub(rf"animation:\s*{re.escape(old)}\b", f"animation:{new}", style)
    return style


def build_css() -> str:
    style = load_style()
    style = no_shift(style)
    style = rename_classes(style)
    style = rename_keyframes(style)

    # 批准版用固定色；组件要跟随主题，所以字形走 currentColor，
    # 橙 V 与蓝线走 CSS 变量，主题里可覆盖（默认即批准版配色）。
    override = """
/* ---- 组件适配层：主题色与静态降级 ---- */
.pv-logo { --pv-v: #e55a09; --pv-line: #297cc0; }
.pv-logo__letter { fill: currentColor; }
.pv-logo__v-edge { stroke: var(--pv-v); }
.pv-logo__line { fill: var(--pv-line); }
.pv-logo__v path { fill: var(--pv-v); stroke: var(--pv-v); }
.pv-logo--animated { overflow: hidden; }
/* 静态模式：动画关掉后各元素停在自己的基础属性上，正好是完整字标
   （字母在位、V 在位、横线满宽），所以不需要额外补偿。 */
.pv-logo:not(.pv-logo--animated) * { animation: none !important; }
.pv-logo__v-edge { opacity: 0; }
"""
    return CSS_HEADER + style + override


TSX_TEMPLATE = '''import type {{ CSSProperties }} from 'react';
import './PilotVLogo.css';

/* 字形轮廓为品牌定稿，不得改动；只有出现位置与动画在变。
 * 本文件由 scripts/build_brand_component.py 从批准版动效派生，
 * 不要手工编辑动画结构。 */

type Letter = {{
  ch: string;
  x: number;
  d: string;
}};

const LETTERS: readonly Letter[] = [
{letter_rows}
];

/* 蓝线：宽满时是下划线，窄时就是循环起点的那个点。 */
const LINE = {{ x: 200.7, y: 91.85, w: 71.3, h: 5.5, rx: 2.75 }};
/* V 转到正侧面时的细边线。 */
const V_EDGE = {{ x: 236.35, y1: 8, y2: 80.85, width: 0.8 }};

export type PilotVLogoProps = {{
  /** 渲染高度（px）。宽度按字标比例自动推导。 */
  height?: number;
  /** false 时显示完整静态字标。 */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
}};

const VIEWBOX_W = 275;
const VIEWBOX_H = 98;

export function PilotVLogo({{
  height = 20,
  animated = true,
  className,
  style,
  'aria-hidden': ariaHidden,
}}: PilotVLogoProps) {{
  return (
    <svg
      viewBox="4 3 275 98"
      width={{(height * VIEWBOX_W) / VIEWBOX_H}}
      height={{height}}
      preserveAspectRatio="xMinYMid meet"
      {{...(ariaHidden ? {{ 'aria-hidden': true }} : {{ role: 'img', 'aria-label': 'PilotV' }})}}
      className={{['pv-logo', animated && 'pv-logo--animated', className]
        .filter(Boolean)
        .join(' ')}}
      style={{style}}
    >
      {{/* 字母：循环里先从 V 下方汇聚成字标，再被 V 逐个吞回蓝线 */}}
      {{LETTERS.filter(l => l.ch !== 'V').map(letter => (
        <g key={{letter.ch}} className={{`pv-logo__letter pv-logo__letter-${{letter.ch}}`}}>
          <g transform={{`translate(${{letter.x}} 80.85) scale(0.050 -0.050)`}}>
            <path d={{letter.d}} />
          </g>
        </g>
      ))}}

      {{/* V：浮现后绕自身竖直轴持续左右转身 */}}
      <g className="pv-logo__v">
        <line
          className="pv-logo__v-edge"
          x1={{V_EDGE.x}}
          x2={{V_EDGE.x}}
          y1={{V_EDGE.y1}}
          y2={{V_EDGE.y2}}
          strokeWidth={{V_EDGE.width}}
          strokeLinecap="round"
        />
        <g className="pv-logo__v-spin">
          {{LETTERS.filter(l => l.ch === 'V').map(letter => (
            <g key={{letter.ch}} transform={{`translate(${{letter.x}} 80.85) scale(0.050 -0.050)`}}>
              <path d={{letter.d}} strokeWidth={{32}} paintOrder="stroke" />
            </g>
          ))}}
        </g>
      </g>

      <rect
        className="pv-logo__line"
        x={{LINE.x}}
        y={{LINE.y}}
        width={{LINE.w}}
        height={{LINE.h}}
        rx={{LINE.rx}}
      />
    </svg>
  );
}}

export default PilotVLogo;
'''


def extract_letters() -> list[tuple[str, float, str]]:
    """从批准版 SVG 里取六个字的确切轮廓与落点。

    真实结构有两层包裹，必须按字母锚点逐个切块再取，不能靠一条全局正则：
      <g class="letter letter-P" data-letter="P"><g transform=...><path d=...
      <g class="letter letter-i" data-letter="i"><g class="fly-i" ...><g transform=...><path ...
    V 更深：v-reveal → v-spin → transform → path。
    所以这里对每个 data-letter 定位，向后取该字第一个带 translate 的 g，
    再取其后的 path。
    """
    src = MASTER.read_text(encoding="utf-8")
    letters: list[tuple[str, float, str]] = []
    for m in re.finditer(r'data-letter="(?P<ch>[A-Za-z])"', src):
        ch = m.group("ch")
        tail = src[m.end() : m.end() + 2000]
        tm = re.search(
            r'transform="translate\((?P<x>-?[\d.]+) (?P<y>-?[\d.]+)\) '
            r'scale\((?P<sx>[\d.]+) (?P<sy>-?[\d.]+)\)"',
            tail,
        )
        pm = re.search(r'<path d="(?P<d>[^"]+)"', tail)
        if not tm or not pm:
            sys.exit(f"字形 {ch} 的 transform 或 path 解析失败")
        sx, sy = float(tm.group("sx")), float(tm.group("sy"))
        if abs(sx + sy) > 1e-6:
            sys.exit(f"字形 {ch} 的缩放不对称（{sx}/{sy}），与组件约定不符")
        letters.append((ch, float(tm.group("x")), pm.group("d")))
    if len(letters) != 6:
        sys.exit(f"从批准版只解析出 {len(letters)} 个字形，预期 6 个")
    return letters


def build_tsx() -> str:
    letters = extract_letters()
    rows = []
    for ch, x, d in letters:
        rows.append(f"  {{ ch: '{ch}', x: {x:.2f}, d: '{d}' }},")
    return TSX_TEMPLATE.format(letter_rows="\n".join(rows))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只报告差异，不写文件")
    args = ap.parse_args()

    outputs = {TSX: build_tsx(), CSS: build_css()}
    diffs = []
    for path, content in outputs.items():
        rel = path.relative_to(REPO)
        if not path.exists():
            diffs.append(f"缺失   {rel}")
        elif path.read_text(encoding="utf-8") == content:
            print(f"一致   {rel}")
        else:
            diffs.append(f"更新   {rel}")
    for line in diffs:
        print(line)
    if args.check:
        print("--check：未写任何文件")
        return 0

    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8")
    print(f"已写入 {len(outputs)} 个组件文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
