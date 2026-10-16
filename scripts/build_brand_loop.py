#!/usr/bin/env python3
"""以批准版蓝橙循环 SVG 为唯一来源，生成 PilotV 全部品牌变体。

批准版源文件：
    常用资料/PilotV-Logo-3D/蓝橙循环版/pilotv-loop.svg

它自带完整动效（16s 循环：蓝点 → 横线 → V 与 Pilot → V 吃掉 t/o/l/i/P →
收回横线 → 蓝点），因此派生规则很简单：

* 动画版  = 源文件原样，只换前景色（深色背景用浅色字，浅色背景用深色字）
* 静态版  = 同一套字形 + 同一套关键帧的“定格”形态
* 锁定版  = 静态版的品牌色版本，给成果台 / 归档用

换颜色只替换字形填充色（#FAFAFA / #0A0A0A），不碰 #e55a09（橙 V）和
#297cc0（蓝线）—— 这两个色是用户钦定的品牌色。

用法：
    python3 scripts/build_brand_loop.py [--check]

--check 只报告将要写入的内容与现状的差异，不写文件。
"""
from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 批准版动效源。唯一事实来源：改动画只改这里，然后重跑本脚本。
MASTER = REPO / "常用资料" / "PilotV-Logo-3D" / "蓝橙循环版" / "pilotv-loop.svg"

BRAND = REPO / "brand"
UI_PUBLIC = REPO / "pilotdeck-mobile/upstream-official/ui/public"
UI_PUBLIC_BRAND = UI_PUBLIC / "brand"

# 字形前景色：深色背景上用近白，浅色背景上用近黑。
LETTER_ON_DARK = "#FAFAFA"
LETTER_ON_LIGHT = "#0A0A0A"

# 下面这套动画名/类名对应源 SVG 内部结构，剥离样式时只按这些名字匹配。
ANIMATED_CLASSES = ("letter", "v-reveal", "v-spin", "blue-line")


def load_master() -> str:
    if not MASTER.exists():
        sys.exit(f"缺少批准版源文件：{MASTER}")
    return MASTER.read_text(encoding="utf-8")


def split_svg(source: str) -> tuple[str, str]:
    """拆成 (样式块, 其余骨架)。"""
    m = re.search(r"<style>(.*?)</style>", source, re.S)
    if not m:
        sys.exit("源 SVG 里没有 <style> 块，结构与预期不符，请重新核对批准版")
    return m.group(1), source[: m.start()] + source[m.end() :]


def recolor(source: str, letter_color: str) -> str:
    """只换字形填充色。橙 V / 蓝线 / 橙边线保持批准版原样。"""
    out = source.replace(f'fill="{LETTER_ON_DARK}"', f'fill="{letter_color}"')
    if letter_color == LETTER_ON_DARK:
        return out
    # 原始文件里只有字形用 #FAFAFA。若它已被换过，兜底恢复再换。
    return out.replace(f'fill="{LETTER_ON_LIGHT}"', f'fill="{letter_color}"')


def strip_animation(skeleton: str) -> str:
    """去掉所有动画类与 v-edge，退化成完整静态 logo。

    v-edge 必须显式删：它本来靠动画控制不透明度，剥掉样式后 line 元素会
    默认可见，在 V 中间多画一根橙线。

    fly-* / data-* 一并清掉：它们只服务于动画定位，静态版留着是死代码。
    """
    out = re.sub(r'<line class="v-edge"[^>]*/>', "", skeleton)
    out = re.sub(r'<g class="v-edge"[^>]*>.*?</g>', "", out, flags=re.S)
    for cls in ANIMATED_CLASSES + tuple(f"letter-{c}" for c in "Pilot"):
        out = re.sub(rf'<g class="{cls}(?: {cls}-[A-Za-z0-9-]+)*"[^>]*>', "<g>", out)
    out = re.sub(r'<rect class="blue-line"([^>]*)/>', r"<g><rect\1/></g>", out)
    # fly-i/l/o/t 只是动画里的中转站，静态版直接摊平。
    # 换成裸 <g> 而不是整段删掉：fly-* 里面包着字形子树，删掉开标签会把子树
    # 和它的 </g> 留在原地，标签就对不上了。HTML 解析器会容错，SVG 的 XML
    # 解析器不会 —— 文件以 image/svg+xml 提供时会被整个拒绝。
    out = re.sub(r'<g class="fly-[a-z]"[^>]*>', "<g>", out)
    out = re.sub(r"\s+data-(station|foot|letter)=\"[^\"]*\"", "", out)
    return out


def static_svg(source: str, letter_color: str, title: str, desc: str) -> str:
    _, skeleton = split_svg(source)
    body = strip_animation(skeleton)
    body = recolor(body, letter_color)
    # 静态版给一个自洽的 viewBox：源版为动画留了上下留白，静态版收紧。
    body = body.replace('viewBox="-12 -18 310 130"', 'viewBox="0 0 286 108"')
    body = body.replace('width="620" height="260"', 'width="572" height="216"')
    # 源文件开标签自带 role/aria-labelledby 和一对 <title>/<desc>，全部丢掉，
    # 换成本文件自己的无障碍标注；否则会出现重复 role 与两个同名 title。
    body = re.sub(r"<svg[^>]*>", "", body, count=1)
    body = re.sub(r"<title[^>]*>.*?</title>", "", body, flags=re.S)
    body = re.sub(r"<desc[^>]*>.*?</desc>", "", body, flags=re.S)
    body = re.sub(r"<\?xml[^>]*\?>\s*", "", body)
    header = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 286 108" width="572" '
        f'height="216" role="img" aria-label="{title}">\n'
        f"<title>{title}</title>\n<desc>{desc}</desc>"
    )
    return header + body


def animated_svg(source: str, letter_color: str, title: str, desc: str) -> str:
    out = recolor(source, letter_color)
    # 官方源已带 <title>/<desc>，根标签上也有 role/aria-labelledby。
    # 这里只在确实缺的时候补 aria 语义：重复注入 role 会让 XML 直接不合法
    # （duplicate attribute），整份文件在浏览器里变成破图。
    # 注意要先用正则定位 <svg …>：源文件开头是 XML 声明，按 ">" 切第一段
    # 拿到的是声明不是标签，判断就永远不成立。
    open_tag = re.search(r"<svg\b[^>]*>", out)
    if open_tag and 'role="img"' not in open_tag.group(0):
        injected = open_tag.group(0).replace(
            "<svg", f'<svg role="img" aria-label="{title}"', 1
        )
        out = out.replace(open_tag.group(0), injected, 1)
    return out


def mark_svg() -> str:
    """方形小图标：橙 V + 蓝线，深底。

    不复用字标动画 —— 16s 循环在 32px 的 favicon 上只会变成一片噪点。
    这里沿用批准版 V 的确切轮廓与蓝色底线，配色一致。

    这个标记自带深色圆角底，浅色/深色背景下读起来一样，所以刻意不提供
    「light 版」：早先的 mark-light 变体和主文件字节完全相同（color 参数
    根本没被用上），只会让人误以为有两种配色。
    """
    # 几何推导（全部来自批准版 V 的确切轮廓）：
    #   V 原始路径 x 跨度 -26..1457，中点 715.5；描边半宽 16。
    #   放大 0.135 后中点占 96.5925，加上描边后视觉宽 204.525。
    #   要让 V 与蓝线同轴居中于 512 画布：tx = 256 - 715.5*0.135 = 159.4075。
    #   蓝线宽度沿用批准版比例 71.30/74.15 = 0.9616 → 196.65，x = 157.70。
    #   纵向让「V + 线」整体在 512 里居中：V 顶 ty-198.855，线底 ty+49 → ty = 330.93。
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" '
        'role="img" aria-label="PilotV">\n'
        "<title>PilotV</title><desc>橙 V 配蓝色底线的 PilotV 标记</desc>\n"
        '<rect width="512" height="512" rx="112" fill="#0A0A0A"/>\n'
        '<g transform="translate(159.41 330.93) scale(0.135 -0.135)">\n'
        '<path d="M1448 1457 864 0H558L-26 1457H246Q290 1457 317.0 1436.5Q344 1416 358 1384'
        "L640 604Q660 553 679.0 492.5Q698 432 715 366Q729 432 746.5 492.5Q764 553 784 604"
        "L1064 1384Q1075 1412 1103.5 1434.5Q1132 1457 1174 1457Z\" "
        'fill="#e55a09" stroke="#e55a09" stroke-width="32" paint-order="stroke"/>\n'
        "</g>\n"
        '<rect x="157.70" y="352" width="196.65" height="28" rx="98.33" fill="#297cc0"/>\n'
        "</svg>\n"
    )


def favicon_svg() -> str:
    """浏览器标签页图标：与方形标记同源，只是把画布标称成 64px。

    内容与 pilotv-mark.svg 完全一致（同一套 viewBox 与几何），只改根标签上的
    width/height，避免再出现「public/favicon.svg 和 brand/pilotv-mark.svg 各写
    一份、颜色悄悄漂移」的老问题。
    """
    return mark_svg().replace(
        'width="512" height="512"', 'width="64" height="64"', 1
    )


def static_body(letter_color: str) -> str:
    """静态字标的内部标记（剥掉 <svg>/<title>/<desc> 头与 </svg> 尾），供锁定版复用。

    尾巴上的 </svg> 必须一起去掉：static_svg 已经自己闭合了，原样嵌进锁定版
    会让同一份文件里出现两个根元素，XML 不良构。
    """
    full = static_svg(load_master(), letter_color, "PilotV", "完整静态 PilotV 字标")
    body = full.split("</desc>", 1)[1]
    return re.sub(r"</svg>\s*$", "", body)


# 锁定版排版常量。字标内容包围盒来自 static_svg 的输出（x 8.00 起、y 7.60 起，
# 宽 266.45、高 89.75 —— 已含 V 的橙色描边与蓝色底线）。
LOCKUP_W, LOCKUP_H = 1120, 220
MARK_SCALE = 0.34375                 # 512 → 176
MARK_W = 512 * MARK_SCALE
MARK_Y = (LOCKUP_H - MARK_W) / 2     # 标记在 220 高的框里垂直居中
WORD_SCALE = 1.337
WORD_GAP = 44
_WORD_W, _WORD_H = 266.45, 89.75
_CONTENT_W = MARK_W + WORD_GAP + _WORD_W * WORD_SCALE
MARK_X = (LOCKUP_W - _CONTENT_W) / 2
WORD_TX = MARK_X + MARK_W + WORD_GAP
WORD_TY = LOCKUP_H / 2 - (7.60 + _WORD_H / 2) * WORD_SCALE


def lockup_svg(letter_color: str) -> str:
    """字标 + 标记的横向锁定版，给成果台与归档说明用。

    字标用真实字形路径而不是 <text>：官方 logo 不该依赖渲染机器是否装了
    Inter —— 缺字体时 <text> 会回退到 system-ui，字宽与重心都会跟着变，
    同一份锁定版在不同机器上会印出不同的结果。
    """
    # 去掉开标签与 title 行，同时去掉 mark_svg 自己的 </svg> 收尾 ——
    # 它在这里会变成一个多余的根元素。
    mark = mark_svg().split("\n", 2)[2].replace("</svg>\n", "", 1)
    inner = mark.replace("<rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#0A0A0A\"/>\n", "")
    inner = re.sub(r"<title>.*?</title><desc>.*?</desc>\n", "", inner, flags=re.S)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 220" width="1120" height="220" '
        'role="img" aria-label="PilotV">\n'
        "<title>PilotV</title><desc>PilotV 标记与字标锁定组合</desc>\n"
        f'<g transform="translate({MARK_X:.2f} {MARK_Y:.2f}) scale({MARK_SCALE})">\n'
        '<rect width="512" height="512" rx="112" fill="#0A0A0A"/>\n'
        f"{inner}"
        "</g>\n"
        f'<g transform="translate({WORD_TX:.2f} {WORD_TY:.2f}) scale({WORD_SCALE})">\n'
        f"{static_body(letter_color)}"
        "</g>\n"
        "</svg>\n"
    )


def assert_wellformed(outputs: dict[Path, str]) -> None:
    """每个 SVG 都必须能被 XML 解析器读进去，否则一个字节都不许写盘。

    为什么非要这道闸：这些文件是以 image/svg+xml 提供的，浏览器用严格 XML
    解析。标签不配对或属性重复不会报错，只会让 <img> 显示破图 —— 而且内联
    进 HTML 时走的是宽容的 HTML 解析器，组件照样渲染正常，开发期完全看不出来。
    所以在这里就按最严格的那个解析器验一遍。
    """
    bad: list[str] = []
    for path, text in outputs.items():
        try:
            ET.fromstring(text)
        except ET.ParseError as exc:
            bad.append(f"  XML 不合法  {path.relative_to(REPO)}: {exc}")
    if bad:
        print("生成的 SVG 有以下问题，已中止，未写任何文件：", file=sys.stderr)
        print("\n".join(bad), file=sys.stderr)
        sys.exit(1)


def build() -> dict[Path, str]:
    source = load_master()
    dark_desc = "蓝色点延展成线，V 与 Pilot 依次浮现，V 旋转并吞入后续字母后收回成点，16 秒循环"
    light_desc = dark_desc + "；浅色背景版本"
    return {
        # 深色背景（主视觉，界面默认）
        BRAND / "pilotv-logo-animated-dark.svg": animated_svg(
            source, LETTER_ON_DARK, "PilotV", dark_desc
        ),
        # 浅色背景
        BRAND / "pilotv-logo-animated-light.svg": animated_svg(
            source, LETTER_ON_LIGHT, "PilotV", light_desc
        ),
        # 静态版（reduced-motion、静态页、印刷、OG 图）
        BRAND / "pilotv-logo-static-dark.svg": static_svg(
            source, LETTER_ON_DARK, "PilotV", "完整静态 PilotV 字标，深色背景版"
        ),
        BRAND / "pilotv-logo-static-light.svg": static_svg(
            source, LETTER_ON_LIGHT, "PilotV", "完整静态 PilotV 字标，浅色背景版"
        ),
        # 方形标记（只有一种，自带深色底，浅深背景通用）
        BRAND / "pilotv-mark.svg": mark_svg(),
        # 锁定组合（成果台用）
        BRAND / "pilotv-lockup.svg": lockup_svg(LETTER_ON_DARK),
        BRAND / "pilotv-lockup-light.svg": lockup_svg(LETTER_ON_LIGHT),
        # 兼容旧文件名。design/logo/ 下的旧生成器与预览页仍按这些名字取文件，
        # 让它们指向批准版，避免 7.2s 旧字标继续在仓库里流通。
        BRAND / "pilotv-logo-animated.svg": animated_svg(
            source, LETTER_ON_LIGHT, "PilotV", light_desc
        ),
        BRAND / "pilotv-icon-animated.svg": animated_svg(
            source, LETTER_ON_DARK, "PilotV", dark_desc
        ),
        BRAND / "pilotv-icon-animated-plain.svg": animated_svg(
            source, LETTER_ON_LIGHT, "PilotV", light_desc
        ),
        # public/ 顶层的两个入口图标。以前是手写的旧标记（白 V + 旧蓝 #4F7DFF），
        # 已经和 brand/ 漂移了 —— 统一从 mark 派生，杜绝再次分叉。
        UI_PUBLIC / "favicon.svg": favicon_svg(),
        UI_PUBLIC / "logo.svg": mark_svg(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只报告差异，不写文件")
    args = ap.parse_args()

    outputs = build()
    assert_wellformed(outputs)
    changed, missing, same = [], [], []
    for path, content in outputs.items():
        if not path.exists():
            missing.append(path)
        elif path.read_text(encoding="utf-8") == content:
            same.append(path)
        else:
            changed.append(path)

    # public/brand 是 brand/ 的镜像（vite 直接从 public 提供静态文件）
    for path, content in outputs.items():
        if path.parent != BRAND:
            continue
        mirror = UI_PUBLIC_BRAND / path.name
        if not mirror.exists() or mirror.read_text(encoding="utf-8") != content:
            changed.append(mirror)

    # public/brand 是 brand/ 的镜像（vite 直接从 public 提供静态文件）。
    # 只镜像 brand/ 下的文件；public/ 顶层的 favicon.svg / logo.svg 已经在
    # public 根上，再复制进 public/brand/ 只会制造两份没人引用的同名文件。
    mirrors = {
        UI_PUBLIC_BRAND / path.name: content
        for path, content in outputs.items()
        if path.parent == BRAND
    }

    print(f"源文件 {MASTER.relative_to(REPO)}")
    for path in missing:
        print(f"缺失   {path.relative_to(REPO)}")
    for path in changed:
        print(f"更新   {path.relative_to(REPO)}")
    for path in same:
        print(f"一致   {path.relative_to(REPO)}")

    if args.check:
        print("--check：未写任何文件")
        return 0

    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    for path, content in mirrors.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(f"已写入 {len(outputs)} 个品牌文件及其 public 镜像")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
