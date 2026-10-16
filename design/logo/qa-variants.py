#!/usr/bin/env python3
"""QA for the two variants a contact sheet of the light wordmark cannot judge.

1. The dark wordmark at several phases — the dark palette swaps both the ink
   and the line colour, so the flying letters pass through a third colour pair
   that nothing else here exercises.
2. prefers-reduced-motion, forced by the browser rather than simulated by
   deleting the keyframes: if the static fallback were broken, the mark would
   freeze at a half-posed frame instead of the resting wordmark.
"""
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motion import load

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
OUT = Path(__file__).resolve().parent / "animated-frames"
OUT.mkdir(parents=True, exist_ok=True)

word = (BRAND / "pilotv-logo-animated.svg").read_text()
dark = (BRAND / "pilotv-logo-animated-dark.svg").read_text()
icon = (BRAND / "pilotv-icon-animated.svg").read_text()
icon_dark = (BRAND / "pilotv-icon-animated-plain.svg").read_text()

MOTION = load()
TURN = float(re.search(r"animation:flip\s+([\d.]+)s", word).group(1))

# The phases worth checking are the ones where a letter is mid-change of colour
# or mid-fold; the untouched resting frames say nothing new in dark.
DARK_POINTS = [(p, ch, label) for p, ch, label in MOTION.marks(held=False)
               if ch in "ot"]
TURN_POINTS = [(i * TURN / 4, "", "V 翻转 %.0f%%" % (i * 25)) for i in range(4)]


def namespaced(src, uid):
    r"""Give this copy of the asset its own class names, without pausing it.

    Every variant ships a <style> that styles the same class names, so several
    of them inlined into one page share a stylesheet: whichever loads last wins,
    and the light wordmark ends up painted with the dark variant's white ink.
    """
    cls = r"(?:track|flip|bar|fly-[a-z])"
    src = re.sub(rf'class="({cls})"', lambda m: f'class="{m.group(1)}{uid}"', src)
    return re.sub(rf'(?<![\d.])\.({cls})(?![a-z0-9])',
                  lambda m: f".{m.group(1)}{uid}", src)


def frozen(src, phase, uid):
    cls = r"(?:track|flip|bar|fly-[a-z])"
    src = re.sub(rf'class="({cls})"', lambda m: f'class="{m.group(1)}{uid}"', src)
    src = re.sub(rf'(?<![\d.])\.({cls})(?![a-z0-9])',
                 lambda m: f".{m.group(1)}{uid}", src)
    owned = ",".join(f".{n}" for n in dict.fromkeys(
        re.findall(r'class="([a-z0-9-]+)"', src)))
    return src.replace("</style>",
                       f"{owned}{{animation-play-state:paused !important;"
                       f"animation-delay:-{phase:.3f}s !important}}</style>", 1)


def cells(src, points, cls):
    out = []
    for i, (sec, _ch, label) in enumerate(points):
        out.append(f'<figure><div class="art">{frozen(src, sec, f"{cls}{i}")}</div>'
                   f'<figcaption><b>{sec:.2f}s</b> {label}</figcaption></figure>')
    return "".join(out)


PAGE = """<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<style>
*{box-sizing:border-box}
body{margin:0;width:1180px;padding:40px 48px;background:#F4F2EB;color:#0A0A0A;
font-family:"Noto Sans CJK SC",system-ui,sans-serif}
h2{font-size:13px;letter-spacing:1.6px;color:#77817a;font-weight:500;margin:0 0 14px}
section{margin-bottom:32px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.grid.darkish figure{background:#0A0A0A;border-color:#0A0A0A}
figure{margin:0;background:#fff;border:1px solid #D8DCD3;border-radius:12px;padding:14px;
display:flex;flex-direction:column;gap:10px}
.art{display:flex;align-items:center;justify-content:center;height:74px}
.art svg{display:block;height:64px;width:auto}
figcaption{font-size:11px;color:#77817a;line-height:1.5}
figcaption b{color:#2A3B31}
.gridish figure{background:#0A0A0A;border-color:#0A0A0A}
.reduced{display:flex;align-items:center;gap:36px;flex-wrap:wrap}
.reduced figure{background:#fff}
.reduced figure.onblack{background:#0A0A0A}
.reduced .art{height:96px}
.reduced .art svg{height:84px}
</style>
<section><h2>深色字标 · 飞行与归线阶段</h2><div class="grid darkish">
{cells(dark, DARK_POINTS, "dw")}</div></section>
<section><h2>深色图标 · V 翻转</h2><div class="grid darkish">
{cells(icon, TURN_POINTS, "di")}</div></section>
</html>"""

REDUCED = """<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<style>
*{box-sizing:border-box}
body{margin:0;width:1180px;padding:40px 48px;background:#F4F2EB;
font-family:"Noto Sans CJK SC",system-ui,sans-serif}
h2{font-size:13px;letter-spacing:1.6px;color:#77817a;font-weight:500;margin:0 0 14px}
section{margin-bottom:30px}
.reduced{display:flex;align-items:center;gap:34px;flex-wrap:wrap}
figure{margin:0;background:#fff;border:1px solid #D8DCD3;border-radius:12px;padding:16px;
display:flex;flex-direction:column;gap:10px}
figure.onblack{background:#0A0A0A;border-color:#0A0A0A}
.art{display:flex;align-items:center;justify-content:center;height:96px}
.art svg{display:block;height:84px}
figcaption{font-size:11px;color:#77817a}
</style>
<section><h2>prefers-reduced-motion: reduce · 应停在完整静止字标</h2>
<div class="reduced">
<figure><div class="art">{WORD}</div><figcaption>浅色字标</figcaption></figure>
<figure class="onblack"><div class="art">{DARK}</div><figcaption>深色字标</figcaption></figure>
<figure class="onblack"><div class="art">{ICON}</div><figcaption>紧凑图标</figcaption></figure>
<figure><div class="art">{ICON_PLAIN}</div><figcaption>无底图标</figcaption></figure>
</div></section>
</html>"""

dark_page = OUT / "qa-variants.html"
dark_page.write_text(
    PAGE.replace("{cells(dark, DARK_POINTS, \"dw\")}", cells(dark, DARK_POINTS, "dw"))
        .replace("{cells(icon, TURN_POINTS, \"di\")}", cells(icon, TURN_POINTS, "di")))

red_page = OUT / "qa-reduced.html"
red_page.write_text(REDUCED
                    .replace("{WORD}", namespaced(word, "rL"))
                    .replace("{DARK}", namespaced(dark, "rD"))
                    .replace("{ICON}", namespaced(icon, "rI"))
                    .replace("{ICON_PLAIN}", namespaced(icon_dark, "rP")))

CHROME = next(p for p in ("/snap/bin/chromium", "/usr/bin/chromium",
                          "/usr/bin/google-chrome") if Path(p).exists())


def shoot(page, out, height, *extra):
    subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", "--virtual-time-budget=4000",
                    *extra, f"--screenshot={out}", f"--window-size=1180,{height}",
                    f"file://{page}"], check=True, capture_output=True)


shoot(dark_page, OUT / "qa-dark.png", 760)
# The flag makes the browser answer the media query itself, so what is screenshotted
# is the fallback the CSS actually ships, not a hand-stripped approximation.
shoot(red_page, OUT / "qa-reduced.png", 420, "--force-prefers-reduced-motion")

print(f"dark wordmark  {len(DARK_POINTS)} phases -> {OUT / 'qa-dark.png'}")
for sec, ch, label in DARK_POINTS:
    print(f"  {sec:5.2f}s  {ch:>4}  {label}")
print(f"reduced motion -> {OUT / 'qa-reduced.png'}")
