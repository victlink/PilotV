#!/usr/bin/env python3
"""Compare a whole directory tree between local and remote by md5.

Usage (remote side):
    python3 ui_tree_check.py --root <dir> --manifest manifest.json

Prints JSON: {"missing": [...], "different": [...], "same": N}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os


def md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--manifest", required=True)
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as fh:
        manifest = json.load(fh)

    missing, different, same = [], [], []
    for rel, want in sorted(manifest.items()):
        full = os.path.join(args.root, rel)
        if not os.path.isfile(full):
            missing.append(rel)
            continue
        try:
            got = md5(full)
        except OSError:
            missing.append(rel)
            continue
        if got == want:
            same.append(rel)
        else:
            different.append(rel)

    print(json.dumps({"missing": missing, "different": different, "same": len(same)}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
