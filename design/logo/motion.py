#!/usr/bin/env python3
"""Read the motion back out of the generated asset, for the QA scripts.

The animation is described once, in animated-generate.py. A QA script that
re-types the schedule is a second copy of it, and copies drift: a phase list
written out by hand kept labelling frames with the wrong letter long after the
timing itself was correct. So the milestones here are *parsed out of the
shipped SVG* -- its keyframe percentages and its animation durations -- and a
script that needs to know when the i lands asks the file that draws the i.

Usage: from motion import load; m = load(); m.cycle, m.keys["i"]
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

BRAND = Path(__file__).resolve().parents[2] / "brand"
NS = "{http://www.w3.org/2000/svg}"


def _at_origin(transform):
    """True when a transform puts the letter back where it started. CSS drops
    the unit on a bare zero, so `translate(0,0)` and `translate(0px,0px)` are
    the same place and both spellings turn up in the generated keyframes."""
    x, y = re.match(r"translate\((-?[\d.]+)(?:px)?,(-?[\d.]+)(?:px)?\)",
                    transform).groups()
    return float(x) == 0 and float(y) == 0


def _scaley(transform):
    """The vertical squash of a frame's scale()."""
    m = re.search(r"scale\([^,]+,([\d.]+)\)", transform)
    return float(m.group(1)) if m else 1.0


def _offset(transform):
    """A frame's horizontal translate, in user units."""
    x, _y = re.match(r"translate\((-?[\d.]+)(?:px)?,(-?[\d.]+)(?:px)?\)",
                     transform).groups()
    return float(x)


class Motion:
    """The generated wordmark, read as the timing and geometry it asserts."""

    def __init__(self, name="pilotv-logo-animated.svg"):
        self.name = name
        self.text = (BRAND / name).read_text(encoding="utf-8")
        root = ET.fromstring(self.text)
        self.view = [float(v) for v in root.get("viewBox").split()[2:]]
        bar = root.find(f".//{NS}rect[@class='bar']")
        self.bar = {k: float(bar.get(k)) for k in ("x", "y", "width", "height")}
        # The lap is the longest duration in the stylesheet; the V's turn is
        # deliberately half of it, so max picks the lap and not the flip.
        self.cycle = max(float(d) for d in
                         re.findall(r"animation:\S+\s+([\d.]+)s", self.text))
        self.keys = {ch: self._frames(ch) for ch in re.findall(
            r"@keyframes fly-([a-z])\s*\{", self.text)}
        # Where each letter is meant to start and end, as the generator
        # recorded them: its station on the line, and the foot of its glyph.
        self.stations, self.feet = {}, {}
        for group in root.iter(f"{NS}g"):
            if (group.get("class") or "").startswith("fly-"):
                self.stations[group.get("class")[4:]] = float(group.get("data-station"))
                self.feet[group.get("class")[4:]] = float(group.get("data-foot"))

    # --- reading the keyframes ------------------------------------------

    def _frames(self, ch):
        block = re.search(rf"@keyframes fly-{ch}\s*\{{(.*?)\n\}}", self.text, re.S)
        frames = []
        for pct, body in re.findall(r"([\d.]+)%\s*\{([^}]*)\}", block.group(1)):
            frames.append({
                "pct": float(pct),
                "transform": (re.search(r"transform:([^;]+)", body) or [None, ""])[1],
                "opacity": float((re.search(r"opacity:([\d.]+)", body)
                                  or [None, 0])[1]),
            })
        return frames

    def at(self, ch, pct):
        """The state of a letter at `pct` of the cycle, by interpolation."""
        keys = self.keys[ch]
        pct = pct % 100.0
        for a, b in zip(keys, keys[1:]):
            if a["pct"] <= pct <= b["pct"]:
                t = 0.0 if b["pct"] == a["pct"] else (pct - a["pct"]) / (b["pct"] - a["pct"])
                return {"transform": b["transform"] if t > 0.5 else a["transform"],
                        "opacity": round(a["opacity"] + (b["opacity"] - a["opacity"]) * t, 3)}
        return keys[-1]

    # --- what each milestone means ---------------------------------------

    def milestones(self, ch):
        """[(pct, state, label)] for one letter's moments, straight from its
        own keyframes: flat on the line, running along it, mid arc, at rest in
        the word, and sinking back. Taken from the frames themselves so a label
        can only ever describe the frame next to it.
        """
        keys = self.keys[ch]
        pct = lambda i: keys[i]["pct"]                                    # noqa: E731
        # First frame at full opacity: the letter has been born on the line.
        born = next(i for i, k in enumerate(keys) if k["opacity"] >= 1)
        # First rotated frame: the slide along the line, then the lift out of
        # it. The tallest of them is the one worth looking at -- the letter up
        # in the air -- and the last rotated frame is the way home.
        arcs = [i for i, k in enumerate(keys) if "rotate(" in k["transform"]]
        cruise = arcs[0]
        air = max(arcs, key=lambda i: _scaley(keys[i]["transform"]))
        # First frame after the arc that is back at its own x: at rest in the
        # word. The last of the run of identical frames is the held read.
        home = next(i for i, k in enumerate(keys)
                    if i > arcs[0] and _at_origin(k["transform"]))
        rest = max(i for i, k in enumerate(keys)
                   if k["transform"] == keys[home]["transform"])
        # Half way from the last visible frame to the one that hides it: on the
        # line again, part way through being taken by it.
        last = max(i for i, k in enumerate(keys) if k["opacity"] >= 1)
        gone = next((i for i, k in enumerate(keys[last + 1:], last + 1)
                     if k["opacity"] == 0), len(keys) - 1)
        return [(pct(born), "seated", "平躺在横线上"),
                *([(pct(cruise), "sliding", "沿横线滑行")] if cruise != air else []),
                (pct(air), "airborne", "弧线飞行中"),
                ((pct(home) + pct(rest)) / 2, "landed", "归位停读"),
                ((pct(last) + pct(gone)) / 2, "home", "汇入横线")]

    def marks(self, held=True):
        """[(seconds, letter, label)] in the order the lap actually plays them.

        `held=True` collapses the four at-rest frames into the one held-word
        frame a contact sheet has room for; pass False to get all sixteen.
        """
        rows = sorted((self.seconds(pct), ch, state, label)
                      for ch in self.keys
                      for pct, state, label in self.milestones(ch))
        if held:
            rest = [t for t, _ch, state, _l in rows if state == "landed"]
            rows = [r for r in rows if r[2] != "landed"]
            rows.append((sum(rest) / len(rest), "i l o t", "landed", "整词停读（全字在位）"))
        return [(t, ch, label) for t, ch, _state, label in sorted(rows)]

    def seated_dx(self, ch):
        """How far the letter travels from its slot to its station on the line,
        taken from its own seated keyframe."""
        return _offset(self.keys[ch][-1]["transform"])

    def slide_x(self, ch):
        """How far the letter has run along the line when it gets under the V.
        It has to stay flat here -- the gap between the V's foot and the line is
        only a letter's width tall -- so this is the frame that decides whether
        the choreography works."""
        return _offset(self.frame(ch, "sliding")["transform"])

    def frame(self, ch, state):
        """The keyframe one named milestone points at, for probing geometry."""
        pct = next(p for p, s, _l in self.milestones(ch) if s == state)
        return next(k for k in self.keys[ch] if k["pct"] == pct)

    def seconds(self, pct):
        return pct / 100.0 * self.cycle


def load(name="pilotv-logo-animated.svg"):
    return Motion(name)


if __name__ == "__main__":
    m = load()
    print(f"{m.name}: lap {m.cycle}s, viewBox {m.view[0]:.0f}x{m.view[1]:.0f}")
    for ch, keys in m.keys.items():
        print(f"\n{ch}  station offset {m.seated_dx(ch):+.2f}  "
              f"{len(keys)} keyframes")
        for k in keys:
            print(f"   {k['pct']:6.2f}%  op {k['opacity']:.2f}  {k['transform']}")
        for pct, state, label in m.milestones(ch):
            print(f"   -> {m.seconds(pct):5.2f}s  {state:9} {label}")
