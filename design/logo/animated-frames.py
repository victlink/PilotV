#!/usr/bin/env python3
"""Freeze the animated wordmark at fixed points of its cycle and lay out a sheet.

Verification aid: each cell shows one moment of the 3.4s marquee lap, so the
scroll and the V rotation can be judged from a single screenshot instead of
trusting the keyframes.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
OUT = Path(__file__).resolve().parent / "animated-frames"
OUT.mkdir(parents=True, exist_ok=True)

word = (BRAND / "pilotv-logo-animated.svg").read_text()
dark = (BRAND / "pilotv-logo-animated-dark.svg").read_text()
icon = (BRAND / "pilotv-icon-animated.svg").read_text()
CYCLE = 6.8
POINTS = [0.0, 0.55, 1.10, 1.55, 2.10, 2.80, 3.40, 4.50, 5.30, 6.20]


def frozen(src, phase, uid):
    """Inline a paused, namespaced copy.

    Each cell gets unique class names so the inline <style> blocks of the ten
    copies cannot talk to each other, and the pause override is appended after
    the animation shorthand so it is not reset by it.
    """
    import re

    # Only these animated class names may be renamed. A loose `\.([a-z0-9]+)`
    # also matches decimal steps such as cubic-bezier(.45,.05,.35,1) and
    # corrupts the stylesheet, which silently kills every animation.
    cls = r"(?:track|flip|b|type\d+)"
    src = re.sub(rf'class="({cls})"', lambda m: f'class="{m.group(1)}{uid}"', src)
    src = re.sub(rf'(?<![\d.])\.({cls})(?![a-z0-9])',
                 lambda m: f".{m.group(1)}{uid}", src)
    # An inline <svg><style> applies to the whole document, so a bare `*` here
    # would be overwritten by the next cell's rule and every cell would render
    # the same instant. Target this copy's own classes; !important is required
    # because class rules outrank a universal selector.
    owned = ",".join(f".{n}" for n in dict.fromkeys(
        re.findall(r'class="([a-z0-9]+)"', src)))
    return src.replace(
        "</style>",
        f"{owned}{{animation-play-state:paused !important;"
        f"animation-delay:-{phase:.3f}s !important}}</style>",
        1,
    )


def still(src, uid=90):
    """The resting wordmark: every animation switched off, not merely paused."""
    import re

    cls = r"(?:track|flip|b|type\d+)"
    src = re.sub(rf'class="({cls})"', lambda m: f'class="{m.group(1)}{uid}"', src)
    src = re.sub(rf'(?<![\d.])\.({cls})(?![a-z0-9])',
                 lambda m: f".{m.group(1)}{uid}", src)
    owned = ",".join(f".{n}" for n in dict.fromkeys(
        re.findall(r'class="([a-z0-9]+)"', src)))
    return src.replace("</style>", f"{owned}{{animation:none !important}}</style>", 1)


def cells_for(src, points, cls):
    return "".join(
        f'<figure><div class="cell {cls}">{frozen(src, p, i)}</div>'
        f"<figcaption>{p:.2f}s</figcaption></figure>"
        for i, p in enumerate(points)
    )


cells = cells_for(word, POINTS, "wordmark")
icon_cells = cells_for(icon, POINTS, "iconmark")
dark_rest = still(dark, 91)

html = f"""<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<title>PilotV · animation frame sheet</title><style>
*{{box-sizing:border-box}}body{{margin:0;width:1320px;padding:44px 48px;background:#F4F2EB;color:#0A0A0A;
font-family:"Noto Sans CJK SC",sans-serif}}h1{{font-size:30px;margin:0 0 6px;letter-spacing:-.5px}}
p{{font-size:13px;color:#5C6A60;margin:0 0 22px}}
h2{{font-size:13px;letter-spacing:1.4px;color:#77817a;font-weight:500;margin:28px 0 14px}}
.grid{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}}
figure{{margin:0;background:#fff;border:1px solid #D8DCD3;border-radius:12px;padding:16px 12px 10px;
display:flex;flex-direction:column;align-items:center;gap:10px}}
.cell svg{{width:100%;height:auto;display:block}}
.cell.icon svg{{width:104px}}
figcaption{{font-size:11px;color:#8A9389;font-variant-numeric:tabular-nums}}
.idle{{margin-top:26px;background:#0A0A0A;border-radius:14px;padding:24px;display:flex;
align-items:center;gap:30px}}
.idle .lbl{{font-size:12px;color:#8A9389}}
.idle svg{{width:260px}}
.light{{background:#fff;border-radius:10px;padding:10px 14px;display:inline-block;line-height:0}}
</style><h1>PilotV 字标 · 打字机 + V 左右翻转 · 周期逐帧</h1>
<p>{CYCLE}s 一轮：整词不位移，<b>P</b> 始终静止；<b>i / l / o / t</b> 依次从下方落位，停顿时逆序下沉消失，不停循环；蓝色 <b>V</b> 加粗，只绕竖轴左右翻转（周期 3.4s）。</p>

<h2>字标</h2><div class="grid">{cells}</div>

<h2>紧凑图标</h2><div class="grid">{icon_cells}</div>

<div class="idle">
  <span class="lbl">深色底（静止）</span><div>{dark_rest}</div>
  <span class="lbl">静态回退</span>
  <span class="light">{still(word, 92)}</span>
</div></html>"""

(OUT / "frame-sheet.html").write_text(html)
print(f"frame sheet with {len(POINTS)} frozen phases ->", OUT / "frame-sheet.html")
