from pathlib import Path
p=Path('design/logo/animated-generate.py')
s=p.read_text()
s=s.replace('# --- keyframes --------------------------------------------------------------', '''# V and underline share a carriage; leave enough room for the last standing
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
    return "@keyframes carriage{\\n" + "\\n".join(
        f"  {_pct(i/400)} {{transform:translateX({carriage_x(i/400):.3f}px)}}"
        for i in range(401)) + "\\n}"

# --- keyframes --------------------------------------------------------------''')
s=s.replace('    def frame(at, transform, opacity, fill, ease=None):\n        body', '''    def frame(at, transform, opacity, fill, ease=None):
        # Seated slivers move with the underline, cruise remains below the V.
        if transform == seated:
            transform = f"translate({dx + carriage_x(at):.3f}px,{dy:.2f}px) scale(1,{flat:.3f})"
        elif transform == cruise:
            transform = (f"translate({g['cruise_x'] + carriage_x(at):.3f}px,{dy * CRUISE_Y:.2f}px) "
                         f"rotate({-TILT}deg) scale({CRUISE_W},{CRUISE_FLAT:.3f})")
        body''')
# Add matching samples while sliver stays attached; no ease between these.
s=s.replace('{frame(seat, seated, 1, "@line", LAUNCH)}', '''{chr(10).join(frame(i/400, seated, 1, "@line") for i in range(401) if spawn < i/400 < seat)}
{frame(seat, seated, 1, "@line", LAUNCH)}''')
s=s.replace('    if letters:\n        for ch in BUILD:', '''    if letters:
        out.append(carriage_keyframes())
        out.append(f".{prefix}carriage{{animation:carriage {CYCLE_SECONDS}s linear infinite}}")
        movers.append("carriage")
        for ch in BUILD:''')
s=s.replace('parts.append(f"<g{cls}{note}><g{place}>{path}</g></g>")', '''node = f"<g{cls}{note}><g{place}>{path}</g></g>"
            if ch == flip_char:
                node = f'<g class="{prefix}carriage">{node}</g>'
            parts.append(node)''')
s=s.replace('<rect class="bar" x="{BAR_X:.2f}"', '<g class="carriage"><rect class="bar" x="{BAR_X:.2f}"')
s=s.replace('rx="{BAR_T / 2:.2f}"/></g></svg>', 'rx="{BAR_T / 2:.2f}"/></g></g></svg>')
s=s.replace('''          return letter.cls ? (
            <g key={{letter.ch}} className={{letter.cls}}>{{glyph}}</g>''','''          return letter.ch === 'V' ? (
            <g key={{letter.ch}} className="pv-logo__carriage">
              <g className={{letter.cls}}>{{glyph}}</g>
            </g>
          ) : letter.cls ? (
            <g key={{letter.ch}} className={{letter.cls}}>{{glyph}}</g>''')
s=s.replace('''        <rect
          className="pv-logo__bar"''','''        <g className="pv-logo__carriage">
        <rect
          className="pv-logo__bar"''')
s=s.replace('''          rx={{BAR.h / 2}}
        />''','''          rx={{BAR.h / 2}}
        />
        </g>''')
p.write_text(s)
print('Patched carriage choreography')
