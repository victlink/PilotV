#!/usr/bin/env python3
"""Live preview page for the animated PilotV assets.

Assets are embedded with <img> on purpose: that is how a brand file is normally
consumed, and it is the context where "does the CSS animation even run?" needs
to be proven rather than assumed. The frozen frames inline the SVG instead, so a
paused cell can be posed at an exact second of the lap.

Frame times and captions come from the asset itself (motion.py), so the page
cannot drift away from the shipped timing.
"""
import base64
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motion import load

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
OUT = Path(__file__).resolve().parent / "animated-preview"
OUT.mkdir(parents=True, exist_ok=True)

word = (BRAND / "pilotv-logo-animated.svg").read_text()
word_dark = (BRAND / "pilotv-logo-animated-dark.svg").read_text()
icon = (BRAND / "pilotv-icon-animated.svg").read_text()
icon_plain = (BRAND / "pilotv-icon-animated-plain.svg").read_text()

MOTION = load()
CYCLE = MOTION.cycle
# The V's own turn is a separate, shorter animation, so its length is read from
# the asset rather than assumed to be half the lap.
TURN = float(re.search(r"animation:flip\s+([\d.]+)s", word).group(1))

# Which frozen frames to show, and what to call each, comes from the asset: one
# per milestone of the lap, plus the line alone before anything grows out of it.
POINTS = [(0.30, "", "只有 V 和横线")] + MOTION.marks()

# The compact mark only turns its V and breathes its bar, so a quarter of the
# V's own turn says all of it.
ICON_POINTS = [(i * TURN / 4, "") for i in range(4)]


# Same trick as the frame sheet: pause the cycle at a chosen phase. Only the
# animated class names are renamed — a loose `\.([a-z0-9]+)` also rewrites
# decimal steps such as cubic-bezier(.45,.05,.35,1) and breaks the sheet. Both
# longhands need !important: a bare `*` loses to the class rules it overrides.
def frozen(src, phase, uid):
    cls = r"(?:track|flip|bar|fly-[a-z])"
    src = re.sub(rf'class="({cls})"', lambda m: f'class="{m.group(1)}{uid}"', src)
    src = re.sub(rf'(?<![\d.])\.({cls})(?![a-z0-9])',
                 lambda m: f".{m.group(1)}{uid}", src)
    owned = ",".join(f".{n}" for n in dict.fromkeys(
        re.findall(r'class="([a-z0-9-]+)"', src)))
    return src.replace("</style>",
                       f"{owned}{{animation-play-state:paused !important;"
                       f"animation-delay:-{phase:.3f}s !important}}</style>", 1)


def word_cells(src):
    out = []
    for i, (sec, _ch, label) in enumerate(POINTS):
        body = frozen(src, sec, f"w{i}")
        out.append(f'<figure><div class="art">{body}</div>'
                   f'<figcaption><b>{sec:.2f}s</b> {label}</figcaption></figure>')
    return "".join(out)


def icon_cells(src):
    out = []
    for i, (sec, _label) in enumerate(ICON_POINTS):
        body = frozen(src, sec, f"m{i}")
        out.append(f'<figure><div class="art">{body}</div>'
                   f'<figcaption>{sec:.2f}s</figcaption></figure>')
    return "".join(out)


html = f"""<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<title>PilotV · 动画 logo</title><style>
*{{box-sizing:border-box}}
body{{margin:0;width:1280px;padding:48px 56px 56px;background:#F4F2EB;color:#0A0A0A;
font-family:"Noto Sans CJK SC",system-ui,sans-serif}}
header{{border-bottom:1px solid #C7CDC5;padding-bottom:22px;margin-bottom:26px}}
h1{{font-size:34px;margin:8px 0 10px;letter-spacing:-.8px}}
p{{font-size:13.5px;color:#5C6A60;line-height:1.9;margin:0;max-width:780px}}
section{{margin-bottom:34px}}h2{{font-size:13px;letter-spacing:1.6px;color:#77817a;font-weight:500;margin:0 0 14px}}
.hint{{letter-spacing:0;font-weight:400;color:#9aa39c;margin-left:10px}}
.panel{{background:#fff;border:1px solid #D8DCD3;border-radius:16px;padding:26px 28px;display:flex;
align-items:center;gap:40px}}
.panel.dark{{background:#0A0A0A;border-color:#0A0A0A}}
.tag{{font-size:11px;color:#8A9389;letter-spacing:.6px}}
.icons{{display:flex;align-items:flex-end;gap:30px}}
.icons figure{{margin:0;display:flex;flex-direction:column;align-items:center;gap:9px}}
.icons figcaption{{font-size:10.5px;color:#8A9389}}
.actual,.zoom,.chip{{display:inline-flex;align-items:center}}
.actual,.chip{{background:#F1F3EE;border-radius:6px;padding:10px 12px}}
.chip{{background:#0A0A0A}}
.grid{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}}
.grid.icons4{{grid-template-columns:repeat(4,1fr)}}
.grid figure{{margin:0;background:#fff;border:1px solid #D8DCD3;border-radius:12px;padding:12px;
display:flex;flex-direction:column;gap:9px}}
.art{{display:flex;align-items:center;justify-content:center;height:64px}}
.art svg{{display:block;height:56px;width:auto}}
.grid figcaption{{font-size:10.5px;color:#77817a;line-height:1.5}}
.grid figcaption b{{color:#2A3B31;font-weight:600}}
code{{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:#EEEFE8;border-radius:6px;
padding:2px 6px;color:#2A3B31}}
</style>
<header><div class="tag">PILOTV / BRAND MOTION</div>
<h1>横线生字 · 落位 · 归线</h1>
<p>V 下方的那条横线是「墨线」：小写 <b>i / l / o / t</b> 从线上平躺的短画里逐个长起来，
保持低姿态滑到 V 左侧的空档，才起身飞到 P 的身后归位；<b>P</b> 全程静止，
<b>V</b> 加粗且只绕竖轴左右翻转。整词停读后，字母再<b>从右到左</b>依次折叠、汇回线上，循环往复。
周期 {CYCLE}s（V 翻转 {TURN}s），已内置 <code>prefers-reduced-motion</code> 静态回退。</p></header>

<section><h2>实时 · 浅色底（当前左上角用法）<span class="hint">实时画面正在循环，请看下方冻结帧</span></h2>
<div class="panel"><img src="pilotv-logo-animated.svg" alt="PilotV" width="430">
<span class="tag">img 引入 430px</span></div></section>

<section><h2>实时 · 深色底</h2>
<div class="panel dark"><img src="pilotv-logo-animated-dark.svg" alt="PilotV" width="430"></div></section>

<section><h2>实时 · 紧凑图标</h2>
<div class="panel"><div class="icons">
<figure><img src="pilotv-icon-animated.svg" width="128"><figcaption>128px</figcaption></figure>
<figure><img src="pilotv-icon-animated.svg" width="64"><figcaption>64px</figcaption></figure>
<figure><img src="pilotv-icon-animated.svg" width="40"><figcaption>40px</figcaption></figure>
<figure><img src="pilotv-icon-animated.svg" width="24"><figcaption>24px</figcaption></figure>
<figure><img src="pilotv-icon-animated.svg" width="16"><figcaption>16px</figcaption></figure>
<figure><img src="pilotv-icon-animated-plain.svg" width="64"><figcaption>无底版</figcaption></figure>
</div></div></section>

<section><h2>实时 · 侧边栏实际尺寸</h2>
<div class="panel"><span class="actual"><img src="pilotv-logo-animated.svg" height="17"></span>
<span class="zoom"><img src="pilotv-logo-animated.svg" height="51"></span>
<span class="chip"><img src="pilotv-logo-animated-dark.svg" height="17"></span>
<span class="chip"><img src="pilotv-logo-animated-dark.svg" height="51"></span>
<span class="tag">左侧为真实 17px，右侧为 3 倍放大；动作在小尺寸下收敛为轻微摆动</span></div></section>

<section><h2>冻结帧 · 字标一个循环</h2><div class="grid">
{word_cells(word)}
</div></section>

<section><h2>冻结帧 · 图标</h2><div class="grid icons4">
{icon_cells(icon)}
</div></section>

<section><h2>用法</h2>
<div class="panel" style="display:block;font-size:12.5px;color:#3C4A40;line-height:2.1">
直接 <code>&lt;img src="/brand/pilotv-logo-animated.svg" /&gt;</code>；动画在 img 内联场景同样生效。<br>
在 React 里需要跟随主题色时用 <code>PilotVLogo</code> 组件（内联 SVG + 同目录 CSS）。<br>
favicon 请用静态 <code>pilotv-mark.svg</code>：动画 favicon 仅部分浏览器支持。
</div></section></html>"""

(OUT / "preview.html").write_text(html)

ASSETS = {
    "pilotv-logo-animated.svg": word,
    "pilotv-logo-animated-dark.svg": word_dark,
    "pilotv-icon-animated.svg": icon,
    "pilotv-icon-animated-plain.svg": icon_plain,
}
for name, src in ASSETS.items():
    (OUT / name).write_text(src)

# Same page as a single self-contained file: swap the sibling references for
# data URIs so the preview survives being sent on its own.
standalone = html
for name, src in ASSETS.items():
    uri = "data:image/svg+xml;base64," + base64.b64encode(src.encode()).decode()
    standalone = standalone.replace(f'src="{name}"', f'src="{uri}"')
(OUT / "preview-standalone.html").write_text(standalone)

# Only real <img> tags count: the usage section quotes an /brand/... path as
# escaped documentation text, which must survive into the standalone file.
leftover = re.findall(r'<img\b[^>]*\bsrc="(?!data:)([^"]+)"', standalone)
print(f"preview + standalone written to {OUT} (cycle {CYCLE}s, {len(POINTS)} frozen frames)")
if leftover:
    raise SystemExit(f"standalone still references external files: {leftover}")

# Screenshot the page so the layout can be judged, not assumed. Skipped quietly
# where no chromium is installed; the html files are the deliverable either way.
CHROME = next((p for p in ("/snap/bin/chromium", "/usr/bin/chromium",
                           "/usr/bin/google-chrome") if Path(p).exists()), None)
if CHROME:
    import subprocess
    subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                    "--hide-scrollbars", "--virtual-time-budget=5000",
                    f"--screenshot={OUT / 'preview.png'}", "--window-size=1320,2400",
                    f"file://{OUT / 'preview-standalone.html'}"],
                   check=True, capture_output=True)
    print("preview screenshot ->", OUT / "preview.png")
else:
    print("no chromium found; skipped preview screenshot")
