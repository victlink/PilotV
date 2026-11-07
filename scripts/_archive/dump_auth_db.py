#!/usr/bin/env python3
"""Dump the local PilotDeck auth.db so we can see users / sessions / login rows."""
import sqlite3
import sys

DB = "/home/marc/.pilotdeck/auth.db"

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = con.cursor()

tables = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print("TABLES:", tables)

for t in tables:
    try:
        cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})")]
        n = cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"\n=== {t} ({n} rows) cols={cols}")
        if n == 0 or n > 40:
            continue
        rows = cur.execute(f"SELECT * FROM {t} LIMIT 40").fetchall()
        for r in rows:
            # redact anything that looks like a secret
            safe = []
            for c, v in zip(cols, r):
                s = str(v)
                if any(k in c.lower() for k in ("password", "hash", "secret", "token")):
                    s = f"<len={len(s)}:{s[:8]}...>" if s else "<empty>"
                if len(s) > 120:
                    s = s[:120] + "..."
                safe.append(s)
            print("  ", dict(zip(cols, safe)))
    except Exception as e:  # noqa: BLE001
        print(f"  !! {t}: {e}", file=sys.stderr)
con.close()
