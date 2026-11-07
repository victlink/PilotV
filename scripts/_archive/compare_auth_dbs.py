#!/usr/bin/env python3
"""Compare the users row across every auth.db copy so we can see when Marc's
credentials changed. Password hashes are only fingerprinted, never printed."""
import glob
import hashlib
import os
import sqlite3

paths = sorted(glob.glob("/home/marc/.pilotdeck/auth.db*"))
paths += sorted(glob.glob("/home/marc/.pilotdeck/backups/**/auth.db*", recursive=True))

for p in paths:
    if not os.path.isfile(p):
        continue
    st = os.stat(p)
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        cur = con.cursor()
        rows = cur.execute(
            "SELECT id, username, password_hash, created_at, last_login,"
            " is_active, has_completed_onboarding FROM users"
        ).fetchall()
        secret = cur.execute(
            "SELECT value FROM app_config WHERE key='jwt_secret'"
        ).fetchone()
    except Exception as e:  # noqa: BLE001
        print(f"{p}: !! {e}")
        continue
    con.close()

    jf = (hashlib.sha256(secret[0].encode()).hexdigest()[:12]
          if secret and secret[0] else "none")
    print(f"\n{os.path.basename(p)}  mtime={st.st_mtime_ns and __import__('datetime').datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S')}  jwt={jf}")
    for (uid, un, ph, ca, ll, act, onb) in rows:
        print(f"  id={uid} user={un!r} bcrypt={ph[:7]}... sha={hashlib.sha256(ph.encode()).hexdigest()[:10]}"
              f" created={ca} last_login={ll} active={act} onboarded={onb}")
