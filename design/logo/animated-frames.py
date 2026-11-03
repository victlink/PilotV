#!/usr/bin/env python3
"""Render the shared logo milestones as a reviewable frame strip."""
import subprocess
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parent / "animated-preview.py"))

HERE = Path(__file__).resolve().parent
page = HERE / "preview.html"
chrome = next((p for p in ("/snap/bin/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome") if Path(p).exists()), None)
if not chrome:
    raise SystemExit("Chromium required for frame strip")
subprocess.run([chrome, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                "--virtual-time-budget=9500", "--window-size=1400,950",
                f"--screenshot={HERE / 'frame-strip.png'}", f"file://{page}"], check=True)
print(HERE / "frame-strip.png")
