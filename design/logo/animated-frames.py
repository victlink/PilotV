#!/usr/bin/env python3
"""Freeze the animated wordmark at fixed points of its cycle and lay out a sheet.

Verification aid: each cell shows one moment of the 8.4s lap, so the way the
letters are drawn out of the line, settle into the word and are folded back
can be judged from a single screenshot instead of trusting the keyframes.
"""
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motion import load

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BRAND = ROOT / "brand"
OUT = HERE / "animated-frames"
OUT.mkdir(parents=True, exist_ok=True)

MOTION = load()
word = MOTION.text
dark = (BRAND / "pilotv-logo-animated-dark.svg").read_text()
icon = (BRAND / "pilotv-icon-animated.svg").read_text()
CYCLE = MOTION.cycle

# Which frames to show, and what to call each, comes from the asset: one row
# per milestone of the lap, plus the line alone before anything is drawn.
POINTS = [(0.30, "", "只有 V 和横线")] + MOTION.marks()

# The compact mark only turns its V and breathes its bar, so a quarter of the
# V's own turn says all of it. The turn's length is read from the asset too.
turn = float(re.search(r"animation:flip\s+([\d.]+)s", word).group(1))
ICON_POINTS = [(i * turn / 4, "", "") for i in range(4)]


def namespaced(src, uid):
    r"""Give this copy of the asset its own class names.

    Only these animated class names may be renamed. A loose `\.([a-z0-9]+)`
    also matches decimal steps such as cubic-bezier(.45,.05,.35,1) and
    corrupts the stylesheet, which silently kills every animation. The copies
    are frozen by the script at the end of the page, from data-phase, because
    a paused CSS animation has to be told its local time by hand: the delay a
    negative value sets is not a promise the renderer keeps about currentTime.
    """
    cls = r"(?:track|flip|bar|fly-[a-z])"
    src = re.sub(rf'class="({cls})"', lambda m: f'class="{m.group(1)}{uid}"', src)
    return re.sub(rf'(?<![\d.])\.({cls})(?![a-z0-9])',
                  lambda m: f".{m.group(1)}{uid}", src)


def frozen(src, phase, uid):
    return namespaced(src, uid)


def still(src, uid=90):
    """The resting wordmark: every animation switched off, not merely paused."""
    src = namespaced(src, uid)
    owned = ",".join(f".{n}" for n in dict.fromkeys(
        re.findall(r'class="([a-z0-9-]+)"', src)))
    return src.replace("</style>", f"{owned}{{animation:none !important}}</style>", 1)


def cells_for(src, points, cls):
    return "".join(
        f'<figure><div class="cell {cls}" data-phase="{p:.3f}">{frozen(src, p, i)}</div>'
        f"<figcaption>{p:.2f}s{(' · ' + who) if who else ''}</figcaption></figure>"
        for i, (p, who, _label) in enumerate(points)
    )


cells = cells_for(word, POINTS, "wordmark")
icon_cells = cells_for(icon, ICON_POINTS, "iconmark")
# One label per cell, for the caption under the sheet.
CAPTIONS = {round(p, 2): (ch, label) for p, ch, label in POINTS}
dark_rest = still(dark, 91)

html = f"""<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<title>PilotV · animation frame sheet</title><style>
*{{box-sizing:border-box}}body{{margin:0;width:1320px;padding:44px 48px;background:#F4F2EB;color:#0A0A0A;
font-family:"Noto Sans CJK SC",sans-serif}}h1{{font-size:30px;margin:0 0 6px;letter-spacing:-.5px}}
p{{font-size:13px;color:#5C6A60;margin:0 0 22px}}
h2{{font-size:13px;letter-spacing:1.4px;color:#77817a;font-weight:500;margin:28px 0 14px}}
.grid{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}}
.grid.icons{{grid-template-columns:repeat(4,1fr)}}
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
</style><h1>PilotV 字标 · 横线生字 + V 左右翻转 · 周期逐帧</h1>
<p>{CYCLE}s 一轮：<b>V</b> 下方一条蓝色横线像一笔湿墨；小写 <b>i / l / o / t</b> 依次<b>贴着底线长出来</b>、斜飞进 <b>P</b> 身后的字位，字母由线色渐变为墨色；整词停一会儿后<b>从右到左</b>依次折回细条、落回横线被吸收，不停循环。蓝色 <b>V</b> 加粗，绕竖轴左右翻转（周期 {turn:.1f}s）。<b>P</b> 始终静止。</p>

<h2>字标</h2><div class="grid">{cells}</div>

<h2>紧凑图标</h2><div class="grid icons">{icon_cells}</div>

<div class="idle">
  <span class="lbl">深色底（静止）</span><div>{dark_rest}</div>
  <span class="lbl">静态回退</span>
  <span class="light">{still(word, 92)}</span>
</div></html>"""

# Freeze every cell at its own phase. currentTime counts from the animation's
# start including its delay, so the delay is added back; a cell frozen this way
# shows the very instant it is captioned with.
# The template has no </body>: hanging the script there once left this page
# rendering a live animation at t=0, with every lowercase letter hidden
# and no error to show for it.
html = html.replace("</html>", """<script>
for (const cell of document.querySelectorAll('.cell[data-phase]')) {
  const at = parseFloat(cell.dataset.phase);
  for (const el of cell.querySelectorAll('*'))
    for (const a of el.getAnimations()) {
      a.pause();
      a.currentTime = at * 1000 + (a.effect.getTiming().delay || 0);
    }
}
</script></html>""")

page = OUT / "frame-sheet.html"
page.write_text(html)
CHROME = next(p for p in ("/snap/bin/chromium", "/usr/bin/chromium",
                          "/usr/bin/google-chrome") if Path(p).exists())
subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                "--hide-scrollbars", "--virtual-time-budget=4000",
                f"--screenshot={OUT / 'frames.png'}", "--window-size=1320,2400",
                f"file://{page}"], check=True, capture_output=True)
print(f"frame sheet with {len(POINTS)} frozen phases ->", OUT / "frames.png")
for p, ch, label in POINTS:
    print(f"  {p:5.2f}s  {ch:>7}  {label}")
