#!/usr/bin/env python3
"""Where does each flying letter actually stand?

A still of the whole wordmark cannot answer this: the letters are small, the
line is thin, and "the i is six units off" is invisible at 200px. So each
letter is rendered alone and the browser is asked to report its own box, in
viewBox units, at an exact phase of the animation.

Two marks it must hit, or it is a bug:

  seated -> its station on the line, flat and line coloured
  landed -> its slot in the word, full height and ink coloured

In between, the two marks that are easy to get wrong:

  sliding -> folded flat, running along the line, and clear of the V's feet
  airborne -> up in the air, on its way, touching neither line nor word

This is the check that caught the animation class sitting on the inner group,
where every animated distance was silently scaled by the glyph factor.

The slot is measured in a separate pass with the animation cancelled, because
cancelling is the only reliable way to get back to the untransformed letter,
and a cancelled CSS animation does not come back on its own.

Usage: python3 design/logo/probe-fly-position.py
"""
import html
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motion import load

HERE = Path(__file__).resolve().parent
OUT = HERE / "animated-frames"
OUT.mkdir(parents=True, exist_ok=True)
BRAND = HERE.parents[1] / "brand"
CHROME = next(p for p in ("/snap/bin/chromium", "/usr/bin/chromium",
                          "/usr/bin/google-chrome") if Path(p).exists())
NS = "{http://www.w3.org/2000/svg}"
ET.register_namespace("", NS[1:-1])   # keep the default xmlns, not ns0:
SCALE = 4                              # the svg is forced to this scale

MOTION = load()
BUILD = "".join(MOTION.keys)           # drawn left to right, as in the file

# The four moments of each letter, read out of its own keyframes by motion.py
# rather than re-typed here: a schedule copied twice is a schedule that drifts.
CHECKS = [(MOTION.seconds(pct), ch, state)
          for ch in BUILD for pct, state, _label in MOTION.milestones(ch)]

PAGE = """<!doctype html><meta charset="utf-8"><title></title>
<style>html,body{margin:0;background:#fff}
svg{display:block;width:%(W).0fpx;height:%(H).0fpx}</style>
%(SVG)s
<script>
(function () {
  const svg = document.querySelector('svg');
  const letter = document.querySelector('[data-probe]');
  const base = svg.getBoundingClientRect();
  const out = {};
  const unit = b => ({x: +((b.left - base.left) / %(SCALE)d).toFixed(2),
                      y: +((b.top - base.top) / %(SCALE)d).toFixed(2),
                      w: +(b.width / %(SCALE)d).toFixed(2),
                      h: +(b.height / %(SCALE)d).toFixed(2)});
  if ('%(MODE)s' === 'slot') {
    // Cancel first: that is the only way back to the untransformed letter.
    // Then map the glyph's own bounding box up to viewBox units.
    letter.getAnimations().forEach(a => a.cancel());
    const inner = letter.firstElementChild;
    const bb = inner.getBBox();
    const m = inner.getScreenCTM();
    const at = (x, y) => new DOMPoint(x, y).matrixTransform(m);
    const c = [at(bb.x, bb.y), at(bb.x + bb.width, bb.y + bb.height)];
    out.slot = {x: +(Math.min(c[0].x, c[1].x) / %(SCALE)d).toFixed(2),
                y: +(Math.min(c[0].y, c[1].y) / %(SCALE)d).toFixed(2),
                w: +(Math.abs(c[1].x - c[0].x) / %(SCALE)d).toFixed(2),
                h: +(Math.abs(c[1].y - c[0].y) / %(SCALE)d).toFixed(2)};
    // The V is the one thing a letter cannot be allowed to touch, so pin its
    // own footprint down in the same units while we are here.
    const v = document.querySelector('[data-v]');
    if (v) {
      v.getAnimations().forEach(a => a.cancel());
      out.v = unit(v.getBoundingClientRect());
    }
  } else {
    // A CSS delay is part of local time, so the currentTime that lands on
    // local time P is P plus the delay. Hold the animation there.
    const at = letter.getAnimations();
    at.forEach(a => a.pause());
    const hold = t => at.forEach(a => {
      const d = a.effect.getTiming().delay || 0;
      a.currentTime = t * 1000 + d;
    });
    if (%(TIMES)s) {
      // Walk the whole flight in one load: keyframes only say where a letter
      // is four times, and a path that clips the V does so in between.
      out.boxes = %(TIMES)s.map(t => {
        hold(t);
        return unit(letter.getBoundingClientRect());
      });
      out.times = %(TIMES)s;
    } else {
      hold(%(PHASE)s);
      const cs = getComputedStyle(letter);
      out.box = unit(letter.getBoundingClientRect());
      out.transform = cs.transform;
      out.opacity = cs.opacity;
      out.fill = cs.fill;
      out.localTime = at.length
        ? at[0].effect.getComputedTiming().localTime / 1000 : -1;
    }
  }
  document.title = JSON.stringify(out);
})().catch(e => { document.title = JSON.stringify({error: '' + e}); });
</script>"""


class Asset:
    """The generated wordmark, read as the geometry the keyframes assume."""

    def __init__(self, name="pilotv-logo-animated.svg"):
        self.text = (BRAND / name).read_text(encoding="utf-8")
        root = ET.fromstring(self.text)
        self.view = [float(v) for v in root.get("viewBox").split()[2:]]
        bar = root.find(f".//{NS}rect[@class='bar']")
        self.bar = {k: float(bar.get(k)) for k in ("x", "y", "width", "height")}
        self.stations = MOTION.stations

    def solo(self, letter):
        """The wordmark with only one flying letter left, marked for the probe.

        The V and the line stay: the V is the obstacle a letter must not cross,
        and a clearance check run without the obstacle in the page would be a
        check of nothing."""
        root = ET.fromstring(self.text)
        for parent in list(root.iter()):
            for child in list(parent):
                cls = child.get("class")
                drop = (cls == "bar"
                        or (cls and cls.startswith("fly-") and cls != f"fly-{letter}"))
                if drop:
                    parent.remove(child)
        flip = root.find(f".//{NS}g[@class='flip']")
        if flip is not None:
            flip.set("data-v", "1")
        root.find(f".//{NS}g[@class='fly-{letter}']").set("data-probe", "1")
        return ET.tostring(root, encoding="unicode")

    def run(self, letter, phase=None, times=None):
        """Ask the browser about one letter: its slot, its box at `phase`, or
        its box at every moment in `times`."""
        page = OUT / "probe-fly.html"
        page.write_text(PAGE % {
            "W": self.view[0] * SCALE, "H": self.view[1] * SCALE,
            "SCALE": SCALE, "PHASE": phase or 0,
            "MODE": "slot" if phase is None else "one",
            "TIMES": json.dumps(times) if times else "null",
            "SVG": self.solo(letter)}, encoding="utf-8")
        res = subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                              "--hide-scrollbars", "--virtual-time-budget=1500",
                              "--dump-dom", "--window-size=1200,600",
                              f"file://{page}"],
                             capture_output=True, text=True, check=True)
        title = re.search(r"<title>(.*?)</title>", res.stdout, re.S)
        got = json.loads(html.unescape(title.group(1))) if title else {}
        if "error" in got:                  # a silent probe is worse than none
            sys.exit(f"probe page failed: {got['error']}")
        if "v" in got:                    # the V's footprint, once per run
            self.vbox = got["v"]
        return got

    def expected(self, ch, state, slot):
        """What the box should be, derived from the letter's own slot."""
        cx = self.stations[ch]
        seated = {"x": round(cx - slot["w"] / 2, 2), "y": self.bar["y"],
                  "w": slot["w"], "h": self.bar["height"]}
        if state == "landed":
            return slot
        if state == "sliding":
            # The slide: still flat, running along the line, and clear of the
            # V's feet. The keyframe's translate is measured from the slot, and
            # a tilted sliver is taller than the line it rides, so its box is
            # not the seated box moved along -- x and the foot are what pin.
            return dict(seated, x=round(slot["x"] + MOTION.slide_x(ch), 2))
        return seated

    def clearance(self, letter, span, slot, steps=120):
        """Walk one letter's whole flight and report any moment it meets the V.

        Keyframes only say where a letter is at four instants; a path that
        clips the V does so somewhere in between, which is exactly the kind of
        fault four stills cannot see.

        Two exemptions, both deliberate:

        * Under the V is not a fault. Threading the gap below its feet is how a
          letter gets from the line to the word at all, so the V's box is cut at
          its lowest point and only the part above it counts.
        * Neither is grazing the V the way the wordmark already does. `t` is
          drafted tight against the V by the wordmark's own tracking, so at rest
          its box already reaches into the V's. The test is therefore not "never
          touch" but "never reach in further than you do at rest", and for a
          letter whose resting box is clear of the V entirely, that is zero.

        What is left is the path in between, sampled -- keyframes only say
        where a letter is at four instants, and a path that clips the V does so
        somewhere in the gaps.
        """
        t0, t1 = span
        times = [round(t0 + (t1 - t0) * i / steps, 4) for i in range(steps + 1)]
        got = self.run(letter, phase=span[0], times=times)
        v, boxes = self.vbox, got.get("boxes") or []
        if not v or not boxes:
            return None, "nothing reported"

        def beside(a, b):
            return a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"]

        floor = v["y"] + v["h"]              # the V's feet

        def reach(box):                     # how deep a box gets into the V
            if beside(box, v) or box["y"] >= floor:
                return 0.0
            return floor - box["y"]

        allowed = reach(slot)
        worst = None
        for t, box in zip(times, boxes):
            if max(abs(box[k] - slot[k]) for k in "xywh") < 1.5:
                continue                      # parked in the word: not on the path
            over = reach(box) - allowed
            if worst is None or over > worst[0]:
                worst = (over, t, box)
        over, t, _box = worst
        if over <= 0.05:
            # Report the margin: a pass with no number is not evidence. For a
            # letter whose resting box is clear of the V, the whole flight
            # staying at zero is the strong result, not a rounding accident.
            if allowed <= 0.05:
                return True, "never reaches into the V at all"
            return True, (f"{over:+.2f} vs the resting reach at its tightest "
                          f"({t:.2f}s)")
        return False, (f"{t:.2f}s reaches {over:.2f} further into the V than at "
                       f"rest (box {tuple(_box[k] for k in 'xywh')})")

    def judge(self, state, ch, box, slot, opacity):
        """(passed, expected box or None, reason) for one sampled state."""
        exp = self.expected(ch, state, slot)
        by = self.bar["y"]
        alpha = float(opacity)
        if state == "home":
            # Arrival and swallow overlap: the letter is home exactly, and is
            # part way through being taken back by the line.
            err = max(abs(box[k] - exp[k]) for k in "xywh")
            if err >= 1.5:
                return False, exp, f"off by {err:.2f}"
            if not 0.01 < alpha < 0.99:
                return False, exp, f"opacity {opacity}, expected mid-swallow"
            return True, exp, ""
        if state == "sliding":
            if alpha < 0.99:
                return False, exp, f"invisible ({opacity})"
            if abs(box["x"] - exp["x"]) >= 1.5:
                return False, exp, f"off by {abs(box['x'] - exp['x']):.2f}"
            if abs(box["y"] + box["h"] - (by + self.bar["height"])) >= 2.0:
                return False, exp, "not riding the line"
            return True, exp, ""
        if state in ("seated", "landed"):
            err = max(abs(box[k] - exp[k]) for k in "xywh")
            if err >= 1.5:
                return False, exp, f"off by {err:.2f}"
            if alpha < 0.99:
                return False, exp, f"invisible ({opacity})"
            return True, exp, ""
        # Airborne: neither of the two marks, fully clear of the line, opaque.
        if alpha < 0.99:
            return False, None, f"invisible ({opacity})"
        if max(abs(box[k] - exp[k]) for k in "xywh") < 3:
            return False, None, "still on the line"
        if max(abs(box[k] - slot[k]) for k in "xywh") < 3:
            return False, None, "already in the word"
        if box["y"] + box["h"] > by - 1:
            return False, None, "still touching the line"
        return True, None, ""


def main():
    a = Asset()
    bx, by, bw, bh = a.bar["x"], a.bar["y"], a.bar["width"], a.bar["height"]
    print(f"line  x {bx:6.2f}..{bx + bw:6.2f}  y {by:6.2f}..{by + bh:6.2f}"
          f"   ({bw:.1f} long, {bh:.1f} thick)\n")
    slots = {}
    for ch in BUILD:
        slots[ch] = a.run(ch)["slot"]
        s = slots[ch]
        print(f"{ch}  slot x {s['x']:6.2f}..{s['x'] + s['w']:6.2f}"
              f"  y {s['y']:6.2f}..{s['y'] + s['h']:6.2f}"
              f"   station {a.stations[ch]:6.2f}")
    print()

    bad = 0
    for phase, ch, want in CHECKS:
        got = a.run(ch, phase)
        if not got.get("box"):
            print(f"{phase:5.2f}s {ch} {want:9} nothing reported")
            bad += 1
            continue
        ok, exp, why = a.judge(want, ch, got["box"], slots[ch], got["opacity"])
        drift = abs(got["localTime"] - phase)
        if drift >= 0.02:
            ok, why = False, f"phase drift {drift:.3f}s"
        bad += not ok
        want_txt = ("-" if exp is None
                    else str(tuple(round(exp[k], 2) for k in "xywh")))
        print(f"{phase:5.2f}s {ch} {want:9} box {tuple(got['box'][k] for k in 'xywh')}"
              f"  want {want_txt:24} op={got['opacity']} {got['fill']}"
              f"  {'ok' if ok else 'FAIL: ' + why}")

    # Four stills cannot show a path that grazes the V between them, so the
    # whole flight is walked once per letter and checked against the V's box.
    print("\nV clearance, sampled across each flight")
    spans = {ch: (MOTION.seconds(mil[0][0]), MOTION.seconds(mil[-1][0]))
             for ch, mil in ((ch, MOTION.milestones(ch)) for ch in BUILD)}
    for ch in BUILD:
        ok, why = a.clearance(ch, spans[ch], slots[ch])
        bad += ok is False
        print(f"{ch}  {spans[ch][0]:.2f}-{spans[ch][1]:.2f}s  "
              f"{'clear, ' + why if ok else 'FAIL: ' + why}")

    print("\nevery letter reaches its mark" if not bad
          else f"\n{bad} checks failed")


if __name__ == "__main__":
    main()
