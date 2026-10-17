#!/usr/bin/env python3
"""把 SVG 上非法的 `font: 700 14px var(--ff)` 表现属性改成 `style="..."`。

HTML 解析器会把 `font:700` 当成属性名（unexpected-character-in-attribute-name），
而 presentation attribute 里也不支持 var()。统一改成 style 属性即可正确继承 CSS 变量。
"""
import pathlib, re, sys

TPL = pathlib.Path(__file__).resolve().parent / "page.tpl.html"
ATTR = re.compile(r'\sfont:([^"]*?var\(--f[fm]\))"?(?=[\s>/])')


def fix(m: re.Match) -> str:
    return f' style="font:{m.group(1)}"'


def main() -> int:
    src = TPL.read_text(encoding="utf-8")
    # 只处理最后一个 </style> 之后的正文：<style> 里的 font:... 是合法 CSS，不能动
    cut = src.rindex("</style>")
    head, body = src[: cut + len("</style>")], src[cut + len("</style>") :]
    body, n = ATTR.subn(fix, body)
    TPL.write_text(head + body, encoding="utf-8")
    print(f"修正 {n} 处 SVG font 属性")
    return 0


if __name__ == "__main__":
    sys.exit(main())
