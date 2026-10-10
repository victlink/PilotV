#!/usr/bin/env python3
"""手搓一个最小可渲染 PDF（1 页，带彩色矩形和文字）。

为什么不用现成库：本机没装 reportlab/fpdf，而验收只需要一个「Chromium 能打开、
肉眼能看出内容的真 PDF」。手写的好处是没有任何依赖，坏处就是下面这堆偏移量。

用法：make_mini_pdf.py <输出路径|-> [标题]
    输出路径给 - 时把 PDF 写到标准输出（验收脚本用 execFileSync 接）。
"""
import sys


def build(title: str = "DRAWING") -> bytes:
    content = (
        b"0.05 0.35 0.85 rg\n"
        b"30 25 140 70 re f\n"
        b"0.95 0.55 0.1 rg\n"
        b"95 45 m 150 100 l 40 100 l h f\n"
        b"0.1 0.1 0.1 rg\n"
        b"BT /F1 14 Tf 30 112 Td (" + title.encode("ascii", "replace") + b") Tj ET\n"
    )
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 130]"
        b"/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
        b"<</Length " + str(len(content)).encode() + b">>stream\n" + content + b"endstream",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += (b"trailer\n<</Size " + str(len(objs) + 1).encode()
            + b"/Root 1 0 R>>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
    return bytes(out)


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "mini.pdf"
    title = sys.argv[2] if len(sys.argv) > 2 else "DRAWING"
    data = build(title)
    # - 表示写标准输出。少了这一支，验收里 execFileSync("python3", [脚本, "-", 标题])
    # 会把 PDF 写成一个名叫 "-" 的 2 字节文件，再拿回一行 "-" 当内容 ——
    # 于是成果台存下来的 PDF 根本打不开，栅格化必然失败。
    if path == "-":
        sys.stdout.buffer.write(data)
    else:
        with open(path, "wb") as fh:
            fh.write(data)
        print(path)