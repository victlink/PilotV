#!/usr/bin/env python3
"""Motion milestones shared by logo review and QA tooling."""
from pathlib import Path
import re

BRAND = Path(__file__).resolve().parents[2] / "brand"
CYCLE = 7.2
PHASES = [
    (0.0, "起点"),
    (.55, "蓝色亮点"),
    (1.35, "亮点拉成蓝线"),
    (2.62, "蓝线托起 V"),
    (3.25, "P · V"),
    (3.97, "Pi · V"),
    (4.69, "Pil · V"),
    (5.41, "Pilo · V"),
    (6.13, "PilotV"),
    (9.0, "完整 PilotV 持续停留"),
]


def load(name="pilotv-logo-animated.svg"):
    text = (BRAND / name).read_text()
    cycle = float(re.search(r"animation:pv-line ([\d.]+)s", text).group(1))
    assert cycle == CYCLE
    return type("Motion", (), {"text": text, "cycle": cycle,
                                "marks": lambda self: [(t, label, label) for t, label in PHASES]})()
