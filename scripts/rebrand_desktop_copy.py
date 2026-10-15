#!/usr/bin/env python3
"""Rebrand user-visible PilotDeck copy in the desktop shell to PilotV.

Only dialog/menu/window-title/error text is rewritten. Anything that is an
identifier rather than copy is deliberately left alone:

  * ``"OpenBMB/PilotDeck"``            auto-update repository slug
  * ``readPilotDeckConfigFile()``      config-service method name
  * ``PilotDeck Computer Use.app``     bundled macOS driver bundle name
  * ``permissionOwner = 'PilotDeck'``  must equal the driver's code-signing identity
  * ``https://github.com/OpenBMB/...``  real project URLs
  * console/``this.log`` lines         developer logs, not surfaced in the UI

Every rule asserts its expected hit count, so a drifted upstream file fails
loudly instead of silently skipping a replacement.

Usage: python3 scripts/rebrand_desktop_copy.py [--dry-run]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path("pilotdeck-mobile/upstream-official/apps/desktop/src")

# file -> list of (exact old substring, expected occurrences)
RULES: dict[str, list[tuple[str, int]]] = {
    "appearance.ts": [
        ('"Preparing PilotDeck runtime..."', 2),
        ('"PilotDeck is ready for model setup."', 1),
        ('"PilotDeck runtime stopped."', 1),
        ('"PilotDeck is ready."', 1),
        ('"PilotDeck failed to start."', 1),
        ('"PilotDeck failed to restore window."', 1),
        ('"Starting PilotDeck..."', 2),
        ('"PilotDeck could not stop"', 1),
        ("<title>PilotDeck</title>", 1),
        ('<div class="mark">P</div><div>PilotDeck</div>', 1),
    ],
    "applicationMenu.ts": [
        ("'关于 PilotDeck'", 2),
        ("'About PilotDeck'", 2),
        ("'退出 PilotDeck'", 1),
        ("'Quit PilotDeck'", 1),
        ("'隐藏 PilotDeck'", 1),
        ("'Hide PilotDeck'", 1),
        ("label: 'PilotDeck'", 1),
    ],
    "computerUse.ts": [
        ("'Bundled Driver is missing. Reinstall PilotDeck.'", 1),
        ("'Driver is not directly hosted by PilotDeck.'", 1),
        ("'Driver permission identity does not match PilotDeck.'", 1),
    ],
    "desktopAbout.ts": [
        ("'关于 PilotDeck'", 1),
        ("'About PilotDeck'", 1),
        ("message: 'PilotDeck'", 1),
        ("`PilotDeck: ${version}`", 1),
    ],
    "desktopLifecycle.ts": [
        ("title: 'PilotDeck'", 1),
        ("'是否要退出 PilotDeck？'", 1),
        ("'Quit PilotDeck?'", 1),
    ],
    "desktopTray.ts": [
        ("`PilotDeck — ${quittingLabel}`", 1),
        (": 'PilotDeck'", 1),
    ],
    "main.ts": [
        ('message: "Preparing PilotDeck runtime..."', 1),
        ('message: "PilotDeck is ready for model setup."', 1),
        ('message: "PilotDeck runtime stopped."', 1),
        ('"PilotDeck is ready for model setup."', 1),
        ('message: "PilotDeck is ready."', 1),
        ('title: "PilotDeck"', 1),
        ('message: "PilotDeck failed to start."', 2),
        ('"Invalid PilotDeck proxy configuration"', 1),
        ('startupText("PilotDeck could not stop"', 1),
        ('"PilotDeck menu bar icon is missing"', 1),
        ('"PilotDeck tray icon is missing"', 1),
        ('"PilotDeck tray icon is invalid"', 1),
    ],
    "rendererRecovery.ts": [
        ("title: 'PilotDeck'", 1),
    ],
}

# Never rewrite these, even though they contain the brand token.
GUARDED = [
    ("main.ts", '"OpenBMB/PilotDeck"'),
    ("main.ts", "readPilotDeckConfigFile"),
    ("computerUse.ts", "PilotDeck Computer Use.app"),
    ("computerUse.ts", "'Electron' : 'PilotDeck'"),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    total = 0
    failures: list[str] = []

    for rel, rules in RULES.items():
        path = ROOT / rel
        if not path.exists():
            failures.append(f"{rel}: file missing")
            continue
        text = original = path.read_text(encoding="utf-8")
        for old, expected in rules:
            found = text.count(old)
            if found != expected:
                failures.append(
                    f"{rel}: expected {expected} of {old!r}, found {found}"
                )
                continue
            text = text.replace(old, old.replace("PilotDeck", "PilotV"))
            total += found
        if text != original and not args.dry_run:
            path.write_text(text, encoding="utf-8")

    # Guard rails: these must survive untouched.
    for rel, guarded in GUARDED:
        path = ROOT / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if guarded not in text:
            failures.append(f"GUARD VIOLATED {rel}: {guarded!r} no longer present")

    for line in failures:
        print(f"ERROR {line}", file=sys.stderr)
    if failures:
        return 1

    verb = "would rebrand" if args.dry_run else "rebranded"
    print(f"{verb} {total} user-visible string(s) across {len(RULES)} files")
    print(f"guards verified: {len(GUARDED)} sensitive tokens untouched")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
