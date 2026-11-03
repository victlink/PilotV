#!/usr/bin/env python3
"""Generate outlined, animated PilotV wordmarks and the matching React component."""
from pathlib import Path
import os
import subprocess
import sys
from xml.etree import ElementTree as ET

from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
UI = ROOT / "pilotdeck-mobile/upstream-official/ui"
FONT = os.environ.get("PILOTV_LOGO_FONT") or subprocess.check_output(
    ["fc-match", "-f", "%{file}", "Lato:style=Black"], text=True
).strip()
tt = TTFont(FONT)
if "lato" not in (tt["name"].getDebugName(1) or "").lower():
    sys.exit(f"Lato Black required to preserve brand geometry: {FONT}")
glyphs = tt.getGlyphSet()
cmap = tt.getBestCmap()
upm = tt["head"].unitsPerEm

INK = "#0A0A0A"
BLUE = "#2F5FE0"
TILE_V = "#4F7DFF"
CYCLE_SECONDS = 7.2
SIZE, TRACKING, PAD = 100.0, -4.0, 8.0
SCALE = SIZE / upm
V_BOLD = round(upm * 0.016)
BAR_T, BAR_GAP, BAR_INSET = 5.5, 2.5, 1.2


def outline(ch):
    glyph = glyphs[cmap[ord(ch)]]
    path = SVGPathPen(glyphs)
    bounds = BoundsPen(glyphs)
    glyph.draw(path)
    glyph.draw(bounds)
    return path.getCommands(), glyph.width, bounds.bounds


def layout():
    cap = (tt["OS/2"].sCapHeight or SIZE * .716) * SCALE
    letters, x = [], 0.0
    for ch in "PilotV":
        d, width, bounds = outline(ch)
        letters.append((ch, d, x, bounds))
        x += width * SCALE + TRACKING
    return x - TRACKING, cap, letters


TOTAL, CAP, LETTERS = layout()
BASELINE = PAD + CAP
HEIGHT = BASELINE + PAD + SIZE * .12
WIDTH = TOTAL + PAD * 2
_vx, _bounds = next((x, b) for ch, _d, x, b in LETTERS if ch == "V")
BAR_X = PAD + _vx + _bounds[0] * SCALE + BAR_INSET
BAR_W = (_bounds[2] - _bounds[0]) * SCALE - BAR_INSET * 2
BAR_Y = BASELINE + BAR_GAP
assert BAR_Y + BAR_T < HEIGHT


def css(prefix="", ink=INK, blue=BLUE):
    p = lambda n: f".{prefix}{n}"
    rules = [f"{p('bar')}{{fill:{blue};transform-box:fill-box;transform-origin:50% 50%;animation:pv-line {CYCLE_SECONDS}s linear 1 both}}",
             f"{p('spark')}{{fill:{blue};filter:drop-shadow(0 0 3px {blue});animation:pv-spark {CYCLE_SECONDS}s linear 1 both}}",
             f"{p('v')}{{transform-origin:{BAR_X + BAR_W / 2:.2f}px {BASELINE:.2f}px;animation:pv-v {CYCLE_SECONDS}s ease-out 1 both}}"]
    line_center = BAR_X + BAR_W / 2
    for index, (ch, _d, x, bounds) in enumerate(LETTERS[:-1]):
        foot = PAD + x + (bounds[0] + bounds[2]) / 2 * SCALE
        dy = BAR_Y + BAR_T / 2 - (BASELINE - bounds[1] * SCALE)
        dx = line_center - foot
        start = 37 + index * 10
        end = start + 8
        rules.append(f"{p('letter-' + ch)}{{fill:{ink};transform-origin:{foot:.2f}px {BASELINE - bounds[1] * SCALE:.2f}px;animation:pv-{ch} {CYCLE_SECONDS}s cubic-bezier(.2,.7,.2,1) 1 both}}")
        rules.append(f"@keyframes pv-{ch}{{0%,{start}%{{opacity:0;transform:translate({dx:.2f}px,{dy:.2f}px) scale(.12,.12)}}{end}%,100%{{opacity:1;transform:translate(0,0) scale(1,1)}}}}")
    rules += [
        "@keyframes pv-spark{0%{opacity:0;r:0}3%,12%{opacity:1;r:4}20%,100%{opacity:0;r:0}}",
        "@keyframes pv-line{0%,9%{opacity:0;transform:scaleX(0)}12%{opacity:1;transform:scaleX(.02)}22%{opacity:1;transform:scaleX(1.15)}30%,100%{opacity:1;transform:scaleX(1)}}",
        "@keyframes pv-v{0%,28%{opacity:0;transform:translateY(12px) scale(.6)}37%,100%{opacity:1;transform:translateY(0) scale(1)}}",
        f"@media (prefers-reduced-motion:reduce){{{','.join(p(n) for n in ['spark','bar','v'] + ['letter-' + ch for ch in 'Pilot'])}{{animation:none}}{p('spark')}{{opacity:0}}}}",
    ]
    return "\n".join(rules)


def glyph_nodes(prefix="", ink=INK, blue=BLUE, react=False):
    nodes = []
    for ch, d, x, _bounds in LETTERS:
        cls = f"{prefix}v" if ch == "V" else f"{prefix}letter-{ch}"
        fill = blue if ch == "V" else ink
        stroke = f' stroke="{fill}" stroke-width="{V_BOLD}" paint-order="stroke"' if ch == "V" else ""
        nodes.append(f'<g class="{cls}"><g transform="translate({x + PAD:.2f} {BASELINE:.2f}) scale({SCALE:.3f} {-SCALE:.3f})"><path d="{d}" fill="{fill}"{stroke}/></g></g>')
    return "".join(nodes)


def wordmark(ink=INK, blue=BLUE):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH:.1f} {HEIGHT:.1f}" width="{WIDTH:.0f}" height="{HEIGHT:.0f}" role="img" aria-label="PilotV">
<style>{css(ink=ink, blue=blue)}</style>
<circle class="spark" cx="{BAR_X + BAR_W / 2:.2f}" cy="{BAR_Y + BAR_T / 2:.2f}" r="4"/>
<rect class="bar" x="{BAR_X:.2f}" y="{BAR_Y:.2f}" width="{BAR_W:.2f}" height="{BAR_T}" rx="{BAR_T / 2:.2f}"/>
{glyph_nodes(ink=ink, blue=blue)}</svg>'''


outputs = {
    "pilotv-logo-animated.svg": wordmark(),
    "pilotv-logo-animated-dark.svg": wordmark("#FAFAFA", TILE_V),
    # Legacy animated URLs also tell the complete story, never a boxed icon.
    "pilotv-icon-animated.svg": wordmark("#FAFAFA", TILE_V),
    "pilotv-icon-animated-plain.svg": wordmark(),
}
for name, svg in outputs.items():
    ET.fromstring(svg)
    for directory in (BRAND, UI / "public/brand"):
        (directory / name).write_text(svg)

rows = "\n".join(
    f"  {{ ch: '{ch}', x: {x + PAD:.2f}, d: '{d}' }},"
    for ch, d, x, _bounds in LETTERS
)
tsx = f'''import type {{ CSSProperties }} from 'react';
import './PilotVLogo.css';

const LETTERS = [
{rows}
] as const;

export type PilotVLogoProps = {{
  height?: number;
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
}};

export function PilotVLogo({{ height = 20, animated = true, className, style, 'aria-hidden': ariaHidden }}: PilotVLogoProps) {{
  return (
    <svg viewBox="0 0 {WIDTH:.1f} {HEIGHT:.1f}" width={{{WIDTH:.1f}}} height={{height}}
      preserveAspectRatio="xMinYMid meet"
      {{...(ariaHidden ? {{ 'aria-hidden': true }} : {{ role: 'img', 'aria-label': 'PilotV' }})}}
      className={{['pv-logo', animated && 'pv-logo--animated', className].filter(Boolean).join(' ')}}
      style={{style}}>
      <circle className="pv-logo__spark" cx={{{BAR_X + BAR_W / 2:.2f}}} cy={{{BAR_Y + BAR_T / 2:.2f}}} r="4" />
      <rect className="pv-logo__bar" x={{{BAR_X:.2f}}} y={{{BAR_Y:.2f}}} width={{{BAR_W:.2f}}} height={{{BAR_T}}} rx={{{BAR_T / 2:.2f}}} />
      {{LETTERS.map(letter => (
        <g key={{letter.ch}} className={{letter.ch === 'V' ? 'pv-logo__v' : `pv-logo__letter-${{letter.ch}}`}}>
          <g transform={{`translate(${{letter.x}} {BASELINE:.2f}) scale({SCALE:.3f} {-SCALE:.3f})`}}>
            <path d={{letter.d}} fill={{letter.ch === 'V' ? 'var(--pv-line)' : 'currentColor'}}
              stroke={{letter.ch === 'V' ? 'var(--pv-line)' : undefined}}
              strokeWidth={{letter.ch === 'V' ? {V_BOLD} : undefined}}
              paintOrder={{letter.ch === 'V' ? 'stroke' : undefined}} />
          </g>
        </g>
      ))}}
    </svg>
  );
}}

export default PilotVLogo;
'''
(UI / "src/components/app-shell/PilotVLogo.tsx").write_text(tsx)
stylesheet = f'''.pv-logo {{ --pv-line: {BLUE}; }}
.dark .pv-logo {{ --pv-line: {TILE_V}; }}
{css(prefix='pv-logo__', ink='currentColor', blue='var(--pv-line)')}
.pv-logo__spark {{ opacity: 0; }}
.pv-logo--animated {{ overflow: hidden; }}
.pv-logo:not(.pv-logo--animated) * {{ animation: none !important; }}
'''
(UI / "src/components/app-shell/PilotVLogo.css").write_text(stylesheet)
print("Generated eight brand/public SVGs and React PilotVLogo")
