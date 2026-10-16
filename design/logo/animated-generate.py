#!/usr/bin/env python3
"""Animated PilotV logo assets.

Letters are outlined (font independent) so the mark renders identically
everywhere and each letter can be animated independently.

Motion, one CYCLE_SECONDS lap:

    A blue line lies under the V like a stroke of wet ink. The lowercase
    i/l/o/t are drawn out of it one at a time -- bottom-anchored, so each one
    first lies flat as a bar-thick sliver, then grows upward while arcing over
    to its slot behind the P. The finished word holds, then folds back
    right-to-left and is swallowed by the line again. The V keeps turning
    about its vertical axis throughout. The compact mark has no lowercase
    letters to draw, so it only turns the V and breathes its bar.

The flying letters live in viewBox space: the animated group wraps the group
that carries the glyph placement, so a CSS `translate()` is measured in the
same units as the geometry instead of being scaled by 0.05.
"""
from pathlib import Path
import os
import subprocess
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from xml.etree import ElementTree as ET

BRAND = Path(__file__).resolve().parents[2] / "brand"
BRAND.mkdir(parents=True, exist_ok=True)


def _lato_black():
    """The brand face, or a hard error.

    `fc-match` never fails, it just returns the closest face it can find, so a
    machine without Lato used to silently outline the wordmark in whatever it
    did have (here: Noto Sans CJK). Verify the family instead of trusting it.
    """
    override = os.environ.get("PILOTV_LOGO_FONT")
    if override:
        return override
    found = subprocess.check_output(
        ["fc-match", "-f", "%{file}", "Lato:style=Black"], text=True
    ).strip()
    if ":" in found:
        found = next((p for p in found.split(":") if p.endswith((".ttf", ".otf"))),
                     found)
    return found


FONT = _lato_black()
tt = TTFont(FONT)
FAMILY = tt["name"].getDebugName(1) or ""
if "lato" not in FAMILY.lower():
    sys.exit(
        f"ERROR: {FONT} is '{FAMILY}', not Lato Black.\n"
        "       Install Lato (apt install fonts-lato) or point "
        "PILOTV_LOGO_FONT at Lato-Black.ttf -- outlining from another face "
        "would silently change the wordmark."
    )
glyphs = tt.getGlyphSet()
cmap = tt.getBestCmap()
upm = tt["head"].unitsPerEm
print("outlining from", FONT, f"({FAMILY})")

INK = "#0A0A0A"
BLUE = "#2F5FE0"
TILE_V = "#4F7DFF"

# Motion knobs. One lap = the line draws the word, the word is read, the word
# goes back into the line. FLIP_SECONDS divides it evenly so the V turn loops
# with the letters instead of drifting against them.
CYCLE_SECONDS = 8.4
FLIP_SECONDS = CYCLE_SECONDS / 2

# The line under the V, in viewBox units. Its thickness is also the height a
# letter collapses to, so a folded letter is exactly the line segment again.
BAR_T = 5.5                  # thickness
BAR_GAP = 11.0               # baseline -> top of the line
BAR_INSET = 1.2              # pull the ends just inside the V's stroke
BAR_STATIONS = (0.18, 0.39, 0.55, 0.72)   # where each letter is drawn from

# How a letter travels home. It cannot go over the V -- the V is as tall as the
# wordmark -- and it cannot stand up underneath it either, or half a letter
# would be swallowed by the stroke. So it stays flat and slides along the line
# through the gap under the V's foot, and only grows once it has slid clear of
# the V's left diagonal, leaning past its slot before it swings back into it.
# The flat height stays near the line's own thickness: any taller and the
# letter reads as standing on the line rather than lying in it -- and a
# squashed o grows a visible slit, which looks like a smudge, not a letter.
CRUISE_FLAT = 0.088                        # flat height while it slides
CRUISE_W = 0.995                           # width scale while it slides
CRUISE_X, CRUISE_Y = 0.55, 0.92            # how far along the line it goes
LIFT_Y, LIFT_SCALE = 0.30, 0.88            # drop and growth at lift-off
LEAN = 3.0                                 # past the slot, before it swings back
CLEAR_GAP = 3.0                            # room kept between a letter and the V

# The write/read/return schedule, as fractions of the cycle.
BUILD = "ilot"                       # drawn left to right, into the word
FADE = BUILD[::-1]                   # absorbed right to left, into the line
SPAWN_FIRST, SPAWN_STEP = 0.070, 0.105
SEED, FLY = 0.020, 0.100             # sliver rests on the line, then flies
HOLD_UNTIL, RETURN_STEP = 0.640, 0.075
FOLD, BACK = 0.028, 0.062            # sliver folds in place, then sinks home

# Easing, one curve per move so the timing reads as intent rather than as a
# linear ramp between hand-placed keyframes.
LAUNCH = "cubic-bezier(.62,.02,.83,.4)"     # leaning over before it lets go
DRIFT = "cubic-bezier(.12,.6,.3,1)"         # decelerating into the slot
SETTLE = "cubic-bezier(.32,1.32,.52,1)"     # overshoot, then settle back
DRAIN = "cubic-bezier(.66,0,.83,.3)"        # collapsing into a sliver
FALL = "cubic-bezier(.3,.7,.42,1)"          # sinking into the line
TILT = 2.2                                 # degrees of lean while airborne

# The V reads heavier than the Lato Black body text next to it.
V_BOLD = round(upm * 0.016)  # glyph units, applied as a stroke on the V only


def outline(ch):
    name = cmap[ord(ch)]
    pen = SVGPathPen(glyphs)
    glyphs[name].draw(pen)
    box = BoundsPen(glyphs)
    glyphs[name].draw(box)
    return pen.getCommands(), glyphs[name].width, box.bounds


def layout(text, size, tracking):
    """Return (total_width, cap_height, [(char, path, x, advance_width)]).

    Glyph origins sit on the baseline, so the baseline must be placed at
    `pad + cap` for the cap tops to land on the top edge instead of clipping.
    """
    scale = size / upm
    cap = (getattr(tt["OS/2"], "sCapHeight", size * 0.716) or size * 0.716) * scale
    out, x = [], 0.0
    for ch in text:
        d, w, _ = outline(ch)
        out.append((ch, d, x, w * scale))
        x += w * scale + tracking
    return x - tracking, cap, out


def _pct(fraction):
    return f"{fraction * 100:.2f}%"


# --- geometry of the line and of the letters that come off it ---------------

SIZE, TRACKING, PAD = 100.0, -4.0, 8.0
SCALE = SIZE / upm
TOTAL, CAP, LETTERS = layout("PilotV", SIZE, TRACKING)
BASELINE = PAD + CAP
HEIGHT = BASELINE + PAD + SIZE * 0.12      # descender buffer
WIDTH = TOTAL + PAD * 2

# The line spans the V, minus a hair of the stroke that fattens it.
_vx, _vd = next((x, d) for ch, d, x, _w in LETTERS if ch == "V")
_bounds = outline("V")[2]
BAR_X = PAD + _vx + _bounds[0] * SCALE + BAR_INSET
BAR_W = (_bounds[2] - _bounds[0]) * SCALE - BAR_INSET * 2
BAR_Y = BASELINE + BAR_GAP
assert BAR_Y + BAR_T < HEIGHT, "the line does not fit the viewBox"

# The V's leftmost ink, boldening stroke included. Every letter is born under
# the V, so this is the edge the flight plan has to get each one clear of
# before it is allowed to stand up.
V_LEFT = PAD + _vx + _bounds[0] * SCALE - V_BOLD * SCALE / 2

# Each letter needs to know where its own bottom-left corner is so it can be
# told to stand on the line, then sent back to its slot. Offsets are measured
# from the letter's bottom centre -- the same point `transform-origin` uses --
# so scaling always happens from the foot of the letter.
GEOMETRY = {}
for _i, ch in enumerate(BUILD):
    _d, _w, (_xmin, _ymin, _xmax, _ymax) = outline(ch)
    _x = next(x for c, _dd, x, _ww in LETTERS if c == ch)
    foot_x = PAD + _x + (_xmin + _xmax) / 2 * SCALE      # bottom centre, in place
    foot_y = BASELINE - _ymin * SCALE                     # baseline for all four
    station = BAR_X + BAR_W * BAR_STATIONS[_i]
    width = (_xmax - _xmin) * SCALE
    # How far left the letter slides before it may stand up: far enough that
    # its right edge has cleared the V's left diagonal. A letter that starts
    # growing while still under the V is a letter that grows through it. Where
    # the nominal slide falls short, slide it further -- and for the last letter
    # that means past its own slot, so it has to swing back right into place
    # rather than simply dropping in.
    cruise_x = min((station - foot_x) * CRUISE_X,
                   V_LEFT - CLEAR_GAP - width * CRUISE_W - (foot_x - width / 2))
    GEOMETRY[ch] = {
        "offset": (station - foot_x, BAR_Y + BAR_T - foot_y),
        "station": station,
        "foot_x": foot_x,
        "width": width,
        "cruise_x": cruise_x,
        # scaleY that squashes the letter to exactly the thickness of the line
        "flat": BAR_T / ((_ymax - _ymin) * SCALE),
        # spawn / land / return cues, as fractions of the cycle
        "spawn": SPAWN_FIRST + _i * SPAWN_STEP,
        "return": HOLD_UNTIL + FADE.index(ch) * RETURN_STEP,
    }


# V and underline share a carriage; leave enough room for the last standing
# lowercase before retracting further. Smoothstep gives each passage a soft
# arrival without a velocity jump at the compact/expanded resting poses.
CARRIAGE = [(0, -125), (.04, -125), (.19, -100), (.295, -78),
            (.40, -30), (.505, 0), (.73, 0), (.805, -30),
            (.88, -78), (.955, -125), (1, -125)]

def carriage_x(at):
    for (a, x), (b, y) in zip(CARRIAGE, CARRIAGE[1:]):
        if a <= at <= b:
            t = (at-a)/(b-a)
            return x + (y-x)*t*t*(3-2*t)
    return CARRIAGE[-1][1]

def carriage_keyframes():
    return "@keyframes carriage{\n" + "\n".join(
        f"  {_pct(i/400)} {{transform:translateX({carriage_x(i/400):.3f}px)}}"
        for i in range(401)) + "\n}"

# --- keyframes --------------------------------------------------------------

def flip_keyframes():
    """Turn the V about its vertical axis: edge-on, mirrored, edge-on."""
    return """
@keyframes flip{
  0%   { transform: scaleX(1); animation-timing-function: cubic-bezier(.45,.05,.35,1); }
  50%  { transform: scaleX(-1); animation-timing-function: cubic-bezier(.45,.05,.35,1); }
  100% { transform: scaleX(1); }
}"""


def fly_keyframes(ch):
    """One letter of the draw.

    Born flat on the line, where it is invisible because it *is* the line; it
    slides left along the line, still flat, threading the gap under the V's
    foot, then grows and swings into its slot with a small overshoot; later it
    folds back into a sliver and slides home into the line. Both ends are back
    on the line at zero opacity, so the loop never shows a seam.
    """
    g = GEOMETRY[ch]
    dx, dy = g["offset"]
    flat = g["flat"]
    spawn, seat = g["spawn"], g["spawn"] + SEED
    land = seat + FLY
    back_start, home = g["return"], g["return"] + FOLD
    home_done = home + BACK

    seated = f"translate({dx:.2f}px,{dy:.2f}px) scale(1,{flat:.3f})"
    folded = f"translate(0,0) scale(1.05,{max(flat * 1.35, 0.12):.3f})"
    cruise = (f"translate({g['cruise_x']:.2f}px,{dy * CRUISE_Y:.2f}px) "
              f"rotate({-TILT}deg) scale({CRUISE_W},{CRUISE_FLAT:.3f})")
    lift = (f"translate({-LEAN:.2f}px,{dy * LIFT_Y:.2f}px) "
            f"rotate({-TILT * 0.6:.2f}deg) scale(.97,{LIFT_SCALE:.3f})")
    # The settle leans in and widens, but it must not stand taller than the
    # letter it is settling into: a touch above its own resting height it
    # breaks the cap line, and for the last letter -- drafted tight against the
    # V -- it breaks the V too.
    settle = "translate(-2.2px,0) scale(1.05,1)"

    def frame(at, transform, opacity, fill, ease=None):
        # Seated slivers move with the underline, cruise remains below the V.
        if transform == seated:
            transform = f"translate({dx + carriage_x(at):.3f}px,{dy:.2f}px) scale(1,{flat:.3f})"
        elif transform == cruise:
            transform = (f"translate({g['cruise_x'] + carriage_x(at):.3f}px,{dy * CRUISE_Y:.2f}px) "
                         f"rotate({-TILT}deg) scale({CRUISE_W},{CRUISE_FLAT:.3f})")
        body = f"transform:{transform};opacity:{opacity};fill:{fill}"
        if ease:
            body += f";animation-timing-function:{ease}"
        return f"  {_pct(at):>7} {{ {body} }}"

    return f"""
@keyframes fly-{ch}{{
{frame(0.0, seated, 0, "@line")}
{frame(max(spawn - 0.02, 0.0), seated, 0, "@line")}
{frame(spawn, seated, 1, "@line")}
{chr(10).join(frame(i/400, seated, 1, "@line") for i in range(401) if spawn < i/400 < seat)}
{frame(seat, seated, 1, "@line", LAUNCH)}
{frame(seat + FLY * 0.40, cruise, 1, "@line", DRIFT)}
{frame(land - 0.016, lift, 1, "@line", DRIFT)}
{frame(land - 0.008, settle, 1, "@ink", SETTLE)}
{frame(land, "translate(0,0) scale(1,1)", 1, "@ink")}
{frame(back_start, "translate(0,0) scale(1,1)", 1, "@ink", DRAIN)}
{frame(home, folded, 1, "@line", FALL)}
{frame(home + BACK * 0.62, cruise, 1, "@line")}
{frame(home_done, seated, 1, "@line")}
{chr(10).join(frame(i/400, seated, round(1-(i/400-home_done)/.012, 3), "@line") for i in range(401) if home_done < i/400 < home_done+.012)}
{frame(home_done + 0.012, seated, 0, "@line")}
{frame(1.0, seated, 0, "@line")}
}}"""


def bar_keyframes():
    """The line dips as it gives a letter away and swells as it takes one back.

    Both events are read off the letter schedule, so the line always reacts on
    the same beat as the letter it belongs to.
    """
    rest = "transform:scaleY(1);opacity:1"
    events = [(g["spawn"] + SEED * 0.75, "transform:scaleY(.58);opacity:.72")
              for ch in BUILD for g in [GEOMETRY[ch]]]
    events += [(g["return"] + FOLD + BACK * 0.8, "transform:scaleY(1.34);opacity:1")
               for ch in FADE for g in [GEOMETRY[ch]]]

    frames = [f"  0% {{ {rest} }}"]
    for at, peak in sorted(events):
        frames.append(f"  {_pct(at - 0.010)} {{ {rest} }}")
        frames.append(f"  {_pct(at)} {{ {peak} }}")
        frames.append(f"  {_pct(at + 0.030)} {{ {rest} }}")
    frames.append(f"  100% {{ {rest} }}")
    return "\n@keyframes bar{\n" + "\n".join(frames) + "\n}"


def breath_keyframes():
    """The icon has no letters to draw, so its line just breathes."""
    return """
@keyframes bar{
  0%,66%,100% { transform: scaleX(.42); opacity: .45; }
  22%,56%     { transform: scaleX(1);   opacity: 1;   }
}"""


def motion_css(prefix="", *, ink=INK, line=BLUE, letters=False, bar="line"):
    """Every rule an asset needs, in one stylesheet."""
    out = [flip_keyframes(),
           f".{prefix}flip{{transform-box:fill-box;transform-origin:50% 50%;"
           f"animation:flip {FLIP_SECONDS}s ease-in-out infinite}}"]
    movers = ["flip"]

    if letters:
        out.append(carriage_keyframes())
        out.append(f".{prefix}carriage{{animation:carriage {CYCLE_SECONDS}s linear infinite}}")
        movers.append("carriage")
        for ch in BUILD:
            body = fly_keyframes(ch).replace("@ink", ink).replace("@line", line)
            out.append(body)
            out.append(f".{prefix}fly-{ch}{{transform-box:fill-box;"
                       f"transform-origin:50% 100%;fill:{ink};"
                       f"animation:fly-{ch} {CYCLE_SECONDS}s linear infinite}}")
            movers.append(f"fly-{ch}")

    if bar == "line":
        out.append(bar_keyframes())
        out.append(f".{prefix}bar{{transform-box:fill-box;transform-origin:50% 50%;"
                   f"fill:{line};animation:bar {CYCLE_SECONDS}s "
                   f"cubic-bezier(.45,.05,.35,1) infinite}}")
    elif bar:
        out.append(breath_keyframes())
        out.append(f".{prefix}bar{{transform-box:fill-box;transform-origin:50% 50%;"
                   f"animation:bar {CYCLE_SECONDS}s "
                   f"cubic-bezier(.45,.05,.35,1) infinite}}")
    movers.append("bar")

    out.append("@media (prefers-reduced-motion:reduce){"
               + ",".join(f".{prefix}{n}" for n in movers)
               + "{animation:none}}")
    return "\n".join(out)


# --- the wordmark -----------------------------------------------------------

def _word_group(letters, *, colors, flip_char=None, prefix="", ink=INK):
    """Positioned <g> elements, one per letter, ready to repeat.

    The animation class goes on the OUTER group so that it sits in viewBox
    units, with the glyph placement transform on the inner one. Keyframes then
    read as plain distances in the coordinate system the reader already has
    (the line, the slots), and `transform-box: fill-box` gives the letter's own
    foot as the origin. Reversing the nesting silently scales every animated
    distance by the glyph scale factor.
    """
    parts = []
    for ch, d, x, _w in letters:
        place = (f' transform="translate({x + PAD:.2f} {BASELINE:.2f}) '
                 f'scale({SCALE:.3f} {-SCALE:.3f})"')
        fill = (colors or {}).get(ch, ink)
        stroke, cls, note = "", "", ""
        if ch == flip_char:
            # The V carries the mark on its own, so it is drawn heavier than
            # the Lato Black body: a same-colour stroke laid behind the fill.
            stroke = (f' stroke="{fill}" stroke-width="{V_BOLD}"'
                      ' paint-order="stroke"')
            cls = f' class="{prefix}flip"'
        elif ch in BUILD:
            # No fill on the path: the animation drives fill so the letter can
            # fade from the line's colour into the word's as it takes shape.
            cls = f' class="{prefix}fly-{ch}"'
            fill = ""
            # Where this letter is meant to be, both ends of its journey, so
            # QA can check the rendered box against intent rather than against
            # a second copy of the numbers.
            note = (f' data-station="{GEOMETRY[ch]["station"]:.2f}"'
                    f' data-foot="{GEOMETRY[ch]["foot_x"]:.2f}"')
        path = (f'<path d="{d}"'
                f'{" fill=" + chr(34) + fill + chr(34) if fill else ""}'
                f"{stroke}/>")
        if cls:
            node = f"<g{cls}{note}><g{place}>{path}</g></g>"
            if ch == flip_char:
                node = f'<g class="{prefix}carriage">{node}</g>'
            parts.append(node)
        else:
            parts.append(f"<g{place}>{path}</g>")
    return "".join(parts)


def wordmark(ink=INK, vcolor=BLUE, line=None):
    """P holds, the V turns, i/l/o/t are drawn from the line and put back."""
    line = line or vcolor
    css = motion_css(letters=True, bar="line", ink=ink, line=line)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH:.1f} {HEIGHT:.1f}" width="{WIDTH:.0f}" height="{HEIGHT:.0f}" role="img" aria-label="PilotV">
<style>
{css}
</style>
<g class="track">{_word_group(LETTERS, colors={"V": vcolor}, flip_char="V", ink=ink)}<g class="carriage"><rect class="bar" x="{BAR_X:.2f}" y="{BAR_Y:.2f}" width="{BAR_W:.2f}" height="{BAR_T}" rx="{BAR_T / 2:.2f}"/></g></g></svg>"""


# --- the compact mark -------------------------------------------------------

def icon(bg=INK, pcolor="#FAFAFA", vcolor=TILE_V, bar=True):
    """Compact mark: P holds still, the V turns, the bar breathes."""
    size, tracking = 100.0, -1.0
    total, cap, _ = layout("PV", size, tracking)
    tile = 240
    x0 = (tile - total) / 2
    baseline = 58 + cap
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {tile} {tile}" width="{tile}" height="{tile}" role="img" aria-label="PilotV">
<style>
{motion_css(bar=bool(bar))}
</style>
<rect width="{tile}" height="{tile}" rx="52" fill="{bg}"/>
{_letters("PV", size, tracking, x0, baseline,
          colors={"P": pcolor, "V": vcolor}, flip_char="V")}
{f'<rect class="bar" x="{x0:.1f}" y="{baseline + 38:.1f}" width="{total:.1f}" height="14" rx="7" fill="{vcolor}"/>' if bar else ""}
</svg>"""


def _letters(text, size, tracking, pad, baseline, colors, flip_char=None):
    """Icon letters: glyph placement inside, animation class on the outside."""
    scale = size / upm
    parts = []
    for ch, d, x, _w in layout(text, size, tracking)[2]:
        fill = (colors or {}).get(ch, INK)
        stroke = ""
        if ch == flip_char:
            stroke = (f' stroke="{fill}" stroke-width="{V_BOLD}"'
                      ' paint-order="stroke"')
        place = (f' transform="translate({x + pad:.2f} {baseline:.2f}) '
                 f'scale({scale:.3f} {-scale:.3f})"')
        glyph = f'<path d="{d}" fill="{fill}"{stroke}/>'
        if ch == flip_char:
            parts.append(f'<g class="flip"><g{place}>{glyph}</g></g>')
        else:
            parts.append(f"<g{place}>{glyph}</g>")
    return "".join(parts)


outputs = {
    "pilotv-logo-animated.svg": wordmark(),
    "pilotv-logo-animated-dark.svg": wordmark(ink="#FAFAFA", vcolor=TILE_V),
    "pilotv-icon-animated.svg": icon(),
    "pilotv-icon-animated-plain.svg": icon(bg="none", pcolor=INK, vcolor=BLUE),
}
for name, svg in outputs.items():
    ET.fromstring(svg)          # structural validation
    assert "<text" not in svg, "logo must be outlined"
    (BRAND / name).write_text(svg)
    print("wrote", BRAND / name, f"{len(svg) // 1024}KB")


# --- React component -------------------------------------------------------
# Inline (not <img>) so the wordmark can follow the app theme via currentColor.
UI = Path(__file__).resolve().parents[2] / "pilotdeck-mobile/upstream-official/ui"
TSX = UI / "src/components/app-shell/PilotVLogo.tsx"
CSS = TSX.with_suffix(".css")


def _tsx_cls(ch):
    """Classes the React component puts on the letter's animated group."""
    if ch == "V":
        return "'pv-logo__flip'"
    if ch in BUILD:
        return f"'pv-logo__fly-{ch}'"
    return "undefined"          # P rides along without its own motion


rows = "\n".join(
    f"    {{ ch: '{ch}', x: {x + PAD:.2f}, cls: {_tsx_cls(ch)}, d: '{d}' }},"
    for ch, d, x, _w in LETTERS
)

TSX_BODY = f'''/**
 * PilotV animated wordmark.
 *
 * Generated by design/logo/animated-generate.py -- edit the generator, not this
 * file. Letterforms are outlined (no font dependency). The blue V turns about
 * its vertical axis; the lowercase i/l/o/t are drawn out of the line under the
 * V, arc into their slots behind the P, and are folded back into the line.
 */
import type {{ CSSProperties }} from 'react';
import './PilotVLogo.css';

const LETTERS = [
{rows}
] as const;

const SCALE = {SCALE:.6f};
const VIEW_W = {WIDTH:.2f};
const VIEW_H = {HEIGHT:.2f};
const BASELINE = {BASELINE:.2f};
const BAR = {{ x: {BAR_X:.2f}, y: {BAR_Y:.2f}, w: {BAR_W:.2f}, h: {BAR_T:.1f} }};

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
        {{LETTERS.map((letter) => {{
          // The flying letters must stay fill-less: the animation drives
          // fill so they can fade out of the line's colour. This note sits
          // above the element because JSX comments are illegal in the
          // attribute list, which is where it used to be.
          const glyph = (
            <g
              transform={{`translate(${{letter.x}} ${{BASELINE}}) scale(${{SCALE}} ${{-SCALE}})`}}
            >
              <path
                d={{letter.d}}
                fill={{letter.ch === 'V' || letter.cls ? undefined : 'currentColor'}}
                className={{letter.ch === 'V' ? 'fill-blue-600 dark:fill-blue-400' : undefined}}
                stroke={{letter.ch === 'V' ? 'currentColor' : undefined}}
                strokeWidth={{letter.ch === 'V' ? {V_BOLD} : undefined}}
                paintOrder={{letter.ch === 'V' ? 'stroke' : undefined}}
              />
            </g>
          );
          return letter.ch === 'V' ? (
            <g key={{letter.ch}} className="pv-logo__carriage">
              <g className={{letter.cls}}>{{glyph}}</g>
            </g>
          ) : letter.cls ? (
            <g key={{letter.ch}} className={{letter.cls}}>{{glyph}}</g>
          ) : (
            <g key={{letter.ch}}>{{glyph}}</g>
          );
        }})}}
        <g className="pv-logo__carriage">
        <rect
          className="pv-logo__bar"
          x={{BAR.x}}
          y={{BAR.y}}
          width={{BAR.w}}
          height={{BAR.h}}
          rx={{BAR.h / 2}}
        />
        </g>
      </g>
    </svg>
  );
}}

export default PilotVLogo;
'''

CSS_BODY = f"""/* Generated by design/logo/animated-generate.py; edit the generator. */

.pv-logo {{
  --pv-line: {BLUE};
}}

.dark .pv-logo {{
  --pv-line: {TILE_V};
}}

{motion_css(prefix="pv-logo__", ink="currentColor", line="var(--pv-line)", letters=True, bar="line")}

.pv-logo--animated {{
  overflow: hidden;
}}

.pv-logo:not(.pv-logo--animated) * {{
  animation: none !important;
}}
"""

TSX.write_text(TSX_BODY)
print("wrote", TSX)
CSS.write_text(CSS_BODY)
print("wrote", CSS)
