#!/usr/bin/env python3
"""QA for the React flavour of the logo, which the sidebar actually renders.

brand/pilotv-logo-animated.svg carries its own <style>; the React component
ships the same motion as an external stylesheet driven by currentColor and a
--pv-line custom property. Those two paths fail independently — a broken var or
a missing currentColor still typechecks, still bundles, and still serves — so
the component needs its own check rather than being assumed from the SVG.

Frames are frozen by negative animation-delay on the real class names, so what
is screenshotted is the shipped CSS, not a re-implementation of it.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / "pilotdeck-mobile/upstream-official/ui"
OUT = Path(__file__).resolve().parent / "animated-frames"
OUT.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motion import load

tsx = (UI / "src/components/app-shell/PilotVLogo.tsx").read_text()
css = (UI / "src/components/app-shell/PilotVLogo.css").read_text()
MOTION = load()
TURN = float(re.search(r"animation:flip\s+([\d.]+)s", (ROOT / "brand/pilotv-logo-animated.svg").read_text()).group(1))

LETTERS = re.findall(r"\{ ch: '(\w)', x: ([\d.]+),[^}]*?d: '([^']+)' \}", tsx)
assert len(LETTERS) == 6, f"expected 6 letters (P i l o t V), parsed {len(LETTERS)}"
CLS = {"i": "pv-logo__fly-i", "l": "pv-logo__fly-l", "o": "pv-logo__fly-o",
       "t": "pv-logo__fly-t", "V": "pv-logo__flip"}
SCALE, VIEW_W, VIEW_H, BASELINE = 0.05, 279.90, 100.85, 80.85
V_BOLD = re.search(r"strokeWidth=\{letter\.ch === 'V' \? ([\d.]+)", tsx).group(1)

glyphs = []
for ch, x, d in LETTERS:
    # React omits an attribute whose value is undefined, so the fill attribute
    # must be left off entirely here. Writing the literal string "undefined"
    # would be an invalid presentation attribute: the browser drops it and the
    # path falls back to black, which reads as an invisible V on a dark panel.
    attrs = [f'd="{d}"']
    if ch == "P":
        attrs.append('fill="currentColor"')
    elif ch == "V":
        # Tailwind classes carry the V's colour in the app; no build here, so
        # the same blue is applied directly.
        attrs += ['fill="#2F5FE0"', 'stroke="#2F5FE0"',
                  f'stroke-width="{V_BOLD}"', 'paint-order="stroke"']
    inner = (f'<g transform="translate({x} {BASELINE}) scale({SCALE} {-SCALE})">'
             f'<path {" ".join(attrs)}/></g>')
    cls = CLS.get(ch)
    glyphs.append(f'<g class="{cls}">{inner}</g>' if cls else inner)

BAR = re.search(r"BAR = \{ x: ([\d.]+), y: ([\d.]+), w: ([\d.]+), h: ([\d.]+) \}", tsx).groups()
MARKUP = (f'<svg viewBox="0 0 {VIEW_W} {VIEW_H}" width="{VIEW_W}" height="84" '
          f'class="pv-logo pv-logo--animated" aria-hidden="true">'
          f'<g class="pv-logo__track">{"".join(glyphs)}'
          f'<rect class="pv-logo__bar" x="{BAR[0]}" y="{BAR[1]}" width="{BAR[2]}" '
          f'height="{BAR[3]}" rx="{float(BAR[3])/2}"/></g></svg>')

PHASES = [(0.30, "", "只有 V 和横线")] + MOTION.marks()

# One id per cell, so each can be frozen at its own phase while sharing the one
# real stylesheet. Freezing through the shipped classes is the whole point: a
# re-implementation of the timing here would hide a broken --pv-line or a
# missing currentColor instead of surfacing it.
cells, freeze = [], []
for i, (p, _ch, lab) in enumerate(PHASES):
    cells.append(f'<figure><div class="art" id="f{i}">{MARKUP}</div>'
                 f'<figcaption><b>{p:.2f}s</b> {lab}</figcaption></figure>')
    freeze.append(f"#f{i} *{{animation-play-state:paused!important;"
                  f"animation-delay:-{p:.3f}s!important}}")
cells = "".join(cells)

PAGE = f"""<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>
{css}
{chr(10).join(freeze)}
*{{box-sizing:border-box}}
body{{margin:0;width:1180px;padding:36px 44px;background:#fff;color:#0A0A0A;
font-family:"Noto Sans CJK SC",system-ui,sans-serif}}
h2{{font-size:13px;letter-spacing:1.4px;color:#6B7A72;font-weight:500;margin:0 0 14px}}
section{{margin-bottom:30px}}
.grid{{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}}
figure{{margin:0;border:1px solid #DDE2DA;border-radius:12px;padding:12px;display:flex;
flex-direction:column;gap:8px}}
.art{{display:flex;align-items:center;justify-content:center;height:72px}}
.art svg{{display:block;height:64px;width:auto;max-width:100%}}
figcaption{{font-size:10px;color:#6B7A72;line-height:1.45}}
figcaption b{{color:#1F2E26}}
.dark{{background:#0A0A0A;color:#FAFAFA}}
.dark figure{{border-color:#242424}}
.dark figcaption{{color:#88928B}}
.dark figcaption b{{color:#FAFAFA}}
</style>
<section><h2>React 组件（内联 SVG + 外部 CSS）· 一个循环</h2><div class="grid">{cells}</div></section>
<section class="dark"><h2>深色</h2><div class="grid">{cells}</div></section>
</html>"""

page = OUT / "qa-react.html"
page.write_text(PAGE)
CHROME = next(p for p in ("/snap/bin/chromium", "/usr/bin/chromium",
                          "/usr/bin/google-chrome") if Path(p).exists())
subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                "--virtual-time-budget=4000", f"--screenshot={OUT / 'qa-react.png'}",
                "--window-size=1180,1200", f"file://{page}"],
               check=True, capture_output=True)
print(f"React logo: {len(PHASES)} phases, {len(LETTERS)} letters -> {OUT / 'qa-react.png'}")
