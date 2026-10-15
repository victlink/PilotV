#!/usr/bin/env python3
"""Animated PilotV logo assets.

Letters are outlined (font independent) so the mark renders identically
everywhere and each letter can be animated independently.

Motion: the wordmark does not travel. P holds still, the heavier blue V turns
about its vertical axis, and i/l/o/t type in one after another before sinking
away again, looping forever. The compact mark has no letters to type, so it
only turns the V.
"""
from pathlib import Path
import subprocess
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from xml.etree import ElementTree as ET

BRAND = Path(__file__).resolve().parents[2] / "brand"
BRAND.mkdir(parents=True, exist_ok=True)

FONT = subprocess.check_output(
    ["fc-match", "-f", "%{file}", "Lato:style=Black"], text=True
).strip()
if ":" in FONT:
    FONT = next((p for p in FONT.split(":") if p.endswith(".ttf")), FONT)
tt = TTFont(FONT)
glyphs = tt.getGlyphSet()
cmap = tt.getBestCmap()
upm = tt["head"].unitsPerEm
print("outlining from", FONT)

INK = "#0A0A0A"
BLUE = "#2F5FE0"
TILE_V = "#4F7DFF"

# Motion knobs. The word does not travel: P holds still, the blue V turns about
# its vertical axis, and i/l/o/t resolve like a typewriter then sink away again.
CYCLE_SECONDS = 6.8          # half the speed of the previous 3.4s lap
FLIP_SECONDS = 3.4           # the V turns left and right, half the previous speed

# Typewriter, as fractions of the cycle. Each lowercase letter resolves on its
# own cue; the word then erases in reverse order, each letter sinking downward.
TYPE_LETTERS = {"i": 0.06, "l": 0.14, "o": 0.22, "t": 0.30}
TYPE_DURATION = 0.06
TYPE_RISE = 10.0            # user units, up from the baseline
TYPE_SINK = 16.0            # user units, down as it disappears
TYPE_SCALE = 0.86
ERASE_START = 0.66
ERASE_STEP = 0.055
ERASE_DURATION = 0.06

# The V reads heavier than the Lato Black body text next to it.
V_BOLD = round(upm * 0.016)  # glyph units, applied as a stroke on the V only


def outline(ch):
    name = cmap[ord(ch)]
    pen = SVGPathPen(glyphs)
    glyphs[name].draw(pen)
    return pen.getCommands(), glyphs[name].width


def layout(text, size, tracking):
    """Return (total_width, cap_height, [(char, path, x, advance_width)]).

    Glyph origins sit on the baseline, so the baseline must be placed at
    `pad + cap` for the cap tops to land on the top edge instead of clipping.
    """
    scale = size / upm
    cap = (getattr(tt["OS/2"], "sCapHeight", size * 0.716) or size * 0.716) * scale
    out, x = [], 0.0
    for ch in text:
        d, w = outline(ch)
        out.append((ch, d, x, w * scale))
        x += w * scale + tracking
    return x - tracking, cap, out


def _letters(text, size, tracking, pad, baseline, colors, flip_char=None,
             typed=False, prefix=""):
    """One copy of the word as positioned <g> elements, ready to repeat.

    Position lives in the transform attribute so CSS can own the inner group;
    that keeps the flips and the typewriter reveals independent per letter.
    """
    scale = size / upm
    parts = []
    for ch, d, x, _w in layout(text, size, tracking)[2]:
        fill = (colors or {}).get(ch, INK)
        cls = ""
        stroke = ""
        if ch == flip_char:
            cls = f' class="{prefix}flip"'
            # The V carries the mark on its own, so it is drawn heavier than the
            # Lato Black body: a same-colour stroke laid behind the fill.
            stroke = f' stroke="{fill}" stroke-width="{V_BOLD}" paint-order="stroke"'
        elif typed and ch in TYPE_LETTERS:
            cls = f' class="{prefix}type{TYPE_LETTERS[ch] * 100:.0f}"'
        parts.append(
            f'<g transform="translate({x + pad:.2f} {baseline:.2f}) '
            f'scale({scale} {-scale})"><g{cls}><path d="{d}" fill="{fill}"{stroke}/>'
            f'</g></g>'
        )
    return "".join(parts)


def _pct(fraction):
    return fraction * 100.0


def flip_keyframes():
    """Turn the V about its vertical axis: edge-on, mirrored, edge-on."""
    return """
@keyframes flip{
  0%   { transform: scaleX(1); animation-timing-function: cubic-bezier(.45,.05,.35,1); }
  50%  { transform: scaleX(-1); animation-timing-function: cubic-bezier(.45,.05,.35,1); }
  100% { transform: scaleX(1); }
}"""


def type_keyframes(ch):
    """One letter of the typewriter pass.

    It rises into place on its cue, then later sinks back down and out. The
    last keyframe returns to the armed state so the loop restarts cleanly;
    both ends are transparent, so the jump is never visible.
    """
    appear = TYPE_LETTERS[ch]
    order = list(TYPE_LETTERS)[::-1].index(ch)       # t erases first, i last
    erase = ERASE_START + order * ERASE_STEP
    rest = f"transform: translate(0,0) scale({1:.2f}); opacity: 1;"
    armed = (f"transform: translate(0,{-TYPE_RISE:.1f}px) scale({TYPE_SCALE:.2f});"
             " opacity: 0;")
    sunk = (f"transform: translate(0,{TYPE_SINK:.1f}px) scale({TYPE_SCALE:.2f});"
            " opacity: 0;")
    return f"""
@keyframes type{ch}{{
  0%    {{{armed}}}
  {_pct(appear):.2f}%  {{{armed}}}
  {_pct(appear + TYPE_DURATION):.2f}%  {{{rest}}}
  {_pct(erase):.2f}%  {{{rest}}}
  {_pct(erase + ERASE_DURATION):.2f}%  {{{sunk}}}
  100%  {{{armed}}}
}}"""


def motion_css(prefix="", typed=False, bar=False):
    """Every rule an asset needs, in one stylesheet."""
    out = [flip_keyframes()]
    out.append(f".{prefix}flip{{transform-box:fill-box;transform-origin:50% 50%;"
               f"animation:flip {FLIP_SECONDS}s ease-in-out infinite}}")
    if typed:
        out += [type_keyframes(ch) for ch in TYPE_LETTERS]
        for ch in TYPE_LETTERS:
            out.append(f".{prefix}type{TYPE_LETTERS[ch] * 100:.0f}"
                       f"{{animation:type{ch} {CYCLE_SECONDS}s linear infinite}}")
    if bar:
        out.append("@keyframes bar{0%,66%,100%{transform:scaleX(.42);opacity:.45}"
                   "22%,56%{transform:scaleX(1);opacity:1}}")
        out.append(f".{prefix}b{{transform-box:fill-box;transform-origin:50% 50%;"
                   f"animation:bar {CYCLE_SECONDS}s cubic-bezier(.45,.05,.35,1) infinite}}")
    movers = ",".join(f".{prefix}{n}" for n in
                      ["flip", "b"] + ([f"type{TYPE_LETTERS[c] * 100:.0f}"
                                        for c in TYPE_LETTERS] if typed else []))
    out.append(f"@media (prefers-reduced-motion:reduce){{{movers}{{animation:none}}}}")
    return "\n".join(out)


def wordmark(color=INK, vcolor=BLUE):
    """One fixed word: P holds, the V turns, i/l/o/t type in and sink out."""
    size, tracking, pad = 100.0, -4.0, 8.0
    total, cap, _ = layout("PilotV", size, tracking)
    baseline = pad + cap
    height = baseline + pad + size * 0.12          # descender buffer
    width = total + pad * 2
    word = _letters("PilotV", size, tracking, pad, baseline,
                    colors={"V": vcolor}, flip_char="V", typed=True)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} {height:.1f}" width="{width:.0f}" height="{height:.0f}" role="img" aria-label="PilotV">
<style>
{motion_css(typed=True)}
</style>
<g class="track">{word}</g></svg>"""


def icon(bg=INK, pcolor="#FAFAFA", vcolor=TILE_V, bar=True):
    """Compact mark: P holds still, the V turns, the bar breathes."""
    size, tracking = 100.0, -1.0
    total, cap, _ = layout("PV", size, tracking)
    tile = 240
    x0 = (tile - total) / 2
    baseline = 58 + cap
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {tile} {tile}" width="{tile}" height="{tile}" role="img" aria-label="PilotV">
<style>
{motion_css(bar=bar)}
</style>
<rect width="{tile}" height="{tile}" rx="52" fill="{bg}"/>
{_letters("PV", size, tracking, x0, baseline,
          colors={"P": pcolor, "V": vcolor}, flip_char="V")}
{f'<rect class="b" x="{x0:.1f}" y="{baseline + 38:.1f}" width="{total:.1f}" height="14" rx="7" fill="{vcolor}"/>' if bar else ""}
</svg>"""


outputs = {
    "pilotv-logo-animated.svg": wordmark(),
    "pilotv-logo-animated-dark.svg": wordmark(color="#FAFAFA", vcolor=TILE_V),
    "pilotv-icon-animated.svg": icon(),
    "pilotv-icon-animated-plain.svg": icon(bg="none", pcolor=INK, vcolor=BLUE),
}
for name, svg in outputs.items():
    ET.fromstring(svg)          # structural validation
    assert "<text" not in svg, "logo must be outlined"
    (BRAND / name).write_text(svg)
    print("wrote", BRAND / name, f"{len(svg)//1024}KB")


# --- React component -------------------------------------------------------
# Inline (not <img>) so the wordmark can follow the app theme via currentColor.
TSX = Path(__file__).resolve().parents[2] / (
    "pilotdeck-mobile/upstream-official/ui/src/components/app-shell/PilotVLogo.tsx"
)
size, tracking, pad = 100.0, -4.0, 8.0
total, cap, letters = layout("PilotV", size, tracking)
baseline = pad + cap
height = baseline + pad + size * 0.12
pitch = total + pad * 2
def _tsx_cls(ch):
    """Class the React component puts on the letter's inner group."""
    if ch == "V":
        return '"pv-logo__flip"'
    if ch in TYPE_LETTERS:
        return f'"pv-logo__type{TYPE_LETTERS[ch] * 100:.0f}"'
    return "undefined"          # P rides along without its own motion


rows = "\n".join(
    f"    {{ ch: '{ch}', x: {x + pad:.2f}, cls: {_tsx_cls(ch)}, d: '{d}' }},"
    for ch, d, x, w in letters
)

TSX_BODY = f'''/**
 * PilotV animated wordmark.
 *
 * Generated by design/logo/animated-generate.py — edit the generator, not this
 * file. Letterforms are outlined (no font dependency). The word runs as a
 * turn; the blue V turns about its vertical axis; i/l/o/t resolve one after
 * another like a typewriter and erase again in reverse.
 */
import type {{ CSSProperties }} from 'react';
import './PilotVLogo.css';

const LETTERS = [
{rows}
] as const;

const SCALE = {size / upm:.6f};
const VIEW_W = {total + pad * 2:.2f};
const VIEW_H = {height:.2f};
const BASELINE = {baseline:.2f};

export type PilotVLogoProps = {{
  /** Rendered height in px; the wordmark keeps its aspect ratio. */
  height?: number;
  /** Set false to freeze the resting wordmark (screenshots, static contexts). */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Hide from assistive tech when nearby text already names the brand. */
  'aria-hidden'?: boolean;
}};

export function PilotVLogo({{
  height = 20,
  animated = true,
  className,
  style,
  'aria-hidden': ariaHidden,
}}: PilotVLogoProps) {{
  return (
    <svg
      viewBox={{`0 0 ${{VIEW_W}} ${{VIEW_H}}`}}
      width={{VIEW_W}}
      height={{height}}
      preserveAspectRatio="xMinYMid meet"
      {{...(ariaHidden
        ? {{ 'aria-hidden': true }}
        : {{ role: 'img', 'aria-label': 'PilotV' }})}}
      className={{['pv-logo', animated && 'pv-logo--animated', className]
        .filter(Boolean)
        .join(' ')}}
      style={{style}}
    >
      <g className="pv-logo__track">
        {{LETTERS.map((letter) => (
          <g
            key={{letter.ch}}
            transform={{`translate(${{letter.x}} ${{BASELINE}}) scale(${{SCALE}} ${{-SCALE}})`}}
          >
            <g className={{letter.cls}}>
              <path
                d={{letter.d}}
                fill={{letter.ch === 'V' ? undefined : 'currentColor'}}
                className={{letter.ch === 'V' ? 'fill-blue-600 dark:fill-blue-400' : undefined}}
                stroke={{letter.ch === 'V' ? 'currentColor' : undefined}}
                strokeWidth={{letter.ch === 'V' ? {V_BOLD} : undefined}}
                paintOrder={{letter.ch === 'V' ? 'stroke' : undefined}}
              />
            </g>
          </g>
        ))}}
      </g>
    </svg>
  );
}}

export default PilotVLogo;
'''

CSS_BODY = f"""/* Generated by design/logo/animated-generate.py; edit the generator. */

{motion_css(prefix="pv-logo__", typed=True)}

.pv-logo--animated {{
  overflow: hidden;
}}
"""

TSX.write_text(TSX_BODY)
print("wrote", TSX)
TSX.with_suffix(".css").write_text(CSS_BODY)
print("wrote", TSX.with_suffix(".css"))
