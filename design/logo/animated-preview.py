#!/usr/bin/env python3
"""Generate a self-contained review page for the PilotV motion."""
from pathlib import Path
from motion import load, PHASES

HERE = Path(__file__).resolve().parent
BRAND = HERE.parents[1] / "brand"
word = load().text
dark = (BRAND / "pilotv-logo-animated-dark.svg").read_text()


cells = "".join(
    f'<figure><div class="frame" data-time="{t}">{word}</div><figcaption>{t:.2f}s · {label}</figcaption></figure>'
    for t, label in PHASES
)
html = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PilotV animation</title>
<style>body{{margin:0;padding:32px;background:#f4f2eb;font:16px system-ui;color:#111}}
.panel{{padding:28px;background:white;margin:16px 0;border-radius:12px}}.dark{{background:#111}}
.panel svg{{width:380px;max-width:100%;height:auto}}.grid{{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}}
figure{{margin:0;background:white;border-radius:10px;padding:14px}}figure svg{{width:100%;height:90px}}
figcaption{{font-size:12px;color:#555}}</style>
<h1>PilotV · 蓝点 → 蓝线 → V → P i l o t → 完整字标</h1>
<div class="panel">{word}</div>
<div class="panel dark">{dark}</div>
<div class="grid">{cells}</div>
<script>for (const frame of document.querySelectorAll('.frame')) {{
  for (const node of frame.querySelectorAll('*')) for (const animation of node.getAnimations()) {{
    animation.pause(); animation.currentTime = Number(frame.dataset.time) * 1000;
  }}
}}</script></html>'''
(HERE / "preview.html").write_text(html)
print(HERE / "preview.html")
