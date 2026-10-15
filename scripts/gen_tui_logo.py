#!/usr/bin/env python3
"""Generate the PilotV TUI wordmark (ASCII art) for PilotVLogo.tsx.

The TUI drew "PilotDeck" with figlet in two fonts -- `ansi_shadow` for wide
terminals and `standard` for narrow ones -- colouring the first word with the
brand colour and the second with the accent. This script emits the same
structure for "PilotV" so only "V" picks up the accent colour.

Requires pyfiglet (pip install --break-system-packages pyfiglet).

Usage: python3 scripts/gen_tui_logo.py
"""

from __future__ import annotations

import pyfiglet

WORD = "Pilot"
ACCENT = "V"

SHADOW_FONT = "ansi_shadow"
SHADOW_ROWS = 6
STANDARD_FONT = "standard"
STANDARD_ROWS = 5


def render(text: str, font: str, rows: int) -> list[str]:
    lines = pyfiglet.figlet_format(text, font=font).rstrip("\n").split("\n")
    # figlet pads with a trailing blank row; keep only the glyph rows.
    return lines[:rows]


def split_width(font: str, rows: int) -> int:
    """Column where the accent word starts."""
    return max(len(line) for line in render(WORD, font, rows))


def emit(font: str, rows: int, name: str) -> None:
    full = render(WORD + ACCENT, font, rows)
    cut = split_width(font, rows)
    print(f"// {name} -- split at column {cut}")
    for line in full:
        print(f'  "{line}",')
    print()


def main() -> None:
    emit(SHADOW_FONT, SHADOW_ROWS, "ansi_shadow")
    emit(STANDARD_FONT, STANDARD_ROWS, "standard")


if __name__ == "__main__":
    main()
