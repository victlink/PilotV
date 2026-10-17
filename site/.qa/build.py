#!/usr/bin/env python3
"""把 brand 里的动画 SVG 注入介绍页模板，生成 site/index.html。

单独成脚本而不是把 9.5KB 路径数据抄进 HTML，是为了以后换 logo 只需改 brand/ 再重跑。
首屏（hero）用品牌自带的 16s 循环动画；片头用同一套 keyframes 但
`animation-delay:-6s; animation-play-state:paused` —— 在 37.5% 处字母恰好全部到位，
定格成完整字标，不另写一套动画。
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
TPL = ROOT / "site" / ".qa" / "page.tpl.html"
DST = ROOT / "site" / "index.html"
BRAND = ROOT / "brand" / "pilotv-logo-animated-dark.svg"


def load_logo() -> tuple[str, str]:
    """返回 (标记全去掉后的 svg 片段, style 片段)。"""
    raw = BRAND.read_text(encoding="utf-8")
    raw = re.sub(r"<\?xml[^>]*\?>", "", raw).strip()

    m = re.search(r"<style>(.*?)</style>", raw, re.S)
    style = m.group(1).strip()
    body = re.sub(r"<style>.*?</style>", "", raw, flags=re.S).strip()

    # 外层 svg 上的 role/aria 交给调用方描述，动画 logo 本身是装饰性的
    body = re.sub(r'\srole="img"[^>]*?>', ">", body, count=1)
    return body, style


def main():
    if not TPL.exists():
        sys.exit(f"模板不存在: {TPL}")
    svg, style = load_logo()
    html = TPL.read_text(encoding="utf-8")
    html = html.replace("<!--@STYLE@-->", f"<style>{style}</style>")
    html = html.replace("<!--@LOGO_HERO@-->", svg)
    html = html.replace("<!--@LOGO_INTRO@-->", svg)
    DST.write_text(html, encoding="utf-8")
    kb = DST.stat().st_size / 1024
    print(f"生成 {DST.relative_to(ROOT)}  {kb:.1f} KB  (svg {len(svg)/1024:.1f}KB)")


if __name__ == "__main__":
    main()
