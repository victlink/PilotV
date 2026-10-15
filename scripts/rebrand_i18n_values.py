#!/usr/bin/env python3
"""Replace the PilotDeck brand with PilotV inside i18n string VALUES only.

JSON object keys are never rewritten: keys such as `runPilotDeckCli` and
`chatInPilotDeck` are referenced from component code via t('...'), so renaming
them would silently break those call sites. Lowercase path tokens such as
`~/.pilotdeck/mcp.json` are also preserved because the match is case-sensitive
on the capitalised brand token.

Formatting is preserved line-by-line, so the diff stays limited to the values
that actually changed.

Usage:
    python3 scripts/rebrand_i18n_values.py [--root <i18n locales dir>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BRAND = "PilotDeck"
NEW_BRAND = "PilotV"

# `"key": value` on one line -- only group 2 (the value) may be rewritten.
KV_LINE = re.compile(r'^(\s*"[^"]*"\s*:\s*)(.*?)(,?)$')


def rebrand_value(value: str) -> str:
    """Swap the brand token inside a single JSON string literal."""
    if BRAND not in value:
        return value
    # Protect JSON escapes so we only touch real text, then swap and restore.
    return value.replace(BRAND, NEW_BRAND)


def rebrand_file(path: Path, dry_run: bool) -> int:
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    changed = 0
    out: list[str] = []

    for line in lines:
        stripped = line.rstrip("\n")
        newline = line[len(stripped):]
        match = KV_LINE.match(stripped)
        if not match:
            out.append(line)
            continue
        prefix, value, comma = match.groups()
        new_value = rebrand_value(value)
        if new_value != value:
            changed += 1
            out.append(f"{prefix}{new_value}{comma}{newline}")
        else:
            out.append(line)

    if changed and not dry_run:
        path.write_text("".join(out), encoding="utf-8")

    # Fail loudly if the rewrite produced invalid JSON.
    if changed:
        json.loads(path.read_text(encoding="utf-8"))

    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        default="pilotdeck-mobile/upstream-official/ui/src/i18n/locales",
        help="i18n locales directory",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f"ERROR: locales dir not found: {root}", file=sys.stderr)
        return 1

    total = 0
    for path in sorted(root.rglob("*.json")):
        count = rebrand_file(path, args.dry_run)
        if count:
            total += count
            verb = "would change" if args.dry_run else "changed"
            print(f"{verb:>12} {count:>3} value(s)  {path}")

    print(f"\n{'DRY RUN: ' if args.dry_run else ''}total values rewritten: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
