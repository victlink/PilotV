#!/usr/bin/env python3
"""Live preview page for the animated PilotV assets.

Assets are embedded with <img> on purpose: that is how a brand file is normally
consumed, and it is the context where "does the CSS animation even run?" needs
to be proven rather than assumed.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
OUT = Path(__file__).resolve().parent / "animated-preview"
OUT.mkdir(parents=True, exist_ok=True)

word = (BRAND / "pilotv-logo-animated.svg").read_text()
word_dark = (BRAND / "pilotv-logo-animated-dark.svg").read_text()
icon = (BRAND / "pilotv-icon-animated.svg").read_text()
icon_plain = (BRAND / "pilotv-icon-animated-plain.svg").read_text()

# Same trick as the frame sheet: pause the cycle at a chosen phase. Only the
# animated class names are renamed — a loose `\.([a-z0-9]+)` also rewrites
# decimal steps such as cubic-bezier(.45,.05,.35,1) and breaks the sheet. Both
# longhands need !important: a bare `*` loses to the class rules it overrides.
def frozen(src, phase, uid):
    import re

    cls = r"(?:track|flip|b|type\d+)"
    src = re.sub(rf'class="({cls})"', lambda m: f'class="{m.group(1)}{uid}"', src)
    src = re.sub(rf'(?<![\d.])\.({cls})(?![a-z0-9])',
                 lambda m: f".{m.group(1)}{uid}", src)
    owned = ",".join(f".{n}" for n in dict.fromkeys(
        re.findall(r'class="([a-z0-9]+)"', src)))
    return src.replace("</style>",
                       f"{owned}{{animation-play-state:paused !important;"
                       f"animation-delay:-{phase:.3f}s !important}}</style>", 1)


def frame_cells(src, points, cls=""):
    return "".join(f"<div>{frozen(src, p, f'{cls}{i}')}</div>"
                   for i, p in enumerate(points))


html = f"""<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<title>PilotV · 动画 logo</title><style>
*{{box-sizing:border-box}}
body{{margin:0;width:1280px;padding:48px 56px 56px;background:#F4F2EB;color:#0A0A0A;
font-family:"Noto Sans CJK SC",system-ui,sans-serif}}
header{{border-bottom:1px solid #C7CDC5;padding-bottom:22px;margin-bottom:26px}}
h1{{font-size:34px;margin:8px 0 10px;letter-spacing:-.8px}}
p{{font-size:13.5px;color:#5C6A60;line-height:1.9;margin:0;max-width:760px}}
section{{margin-bottom:34px}}h2{{font-size:13px;letter-spacing:1.6px;color:#77817a;font-weight:500;margin:0 0 14px}}
.hint{{letter-spacing:0;font-weight:400;color:#9aa39c;margin-left:10px}}
.panel{{background:#fff;border:1px solid #D8DCD3;border-radius:16px;padding:26px 28px;display:flex;
align-items:center;gap:40px}}
.panel.dark{{background:#0A0A0A;border-color:#0A0A0A}}
.tag{{font-size:11px;color:#8A9389;letter-spacing:.6px}}
.hero img{{width:430px;display:block}}
.icons{{display:flex;align-items:flex-end;gap:30px}}
.icons figure{{margin:0;display:flex;flex-direction:column;align-items:center;gap:9px}}
.icons figcaption{{font-size:10.5px;color:#8A9389}}
.strip img{{width:190px}}
.actual,.zoom,.chip{{display:inline-flex;align-items:center}}
.actual,.chip{{background:#F1F3EE;border-radius:6px;padding:10px 12px}}
.chip{{background:#0A0A0A}}
.frozen.three{{grid-template-columns:repeat(3,1fr)!important}}
.frozen{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}
.frozen div{{background:#fff;border:1px solid #D8DCD3;border-radius:12px;padding:12px}}
.frozen img{{width:100%}}
code{{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:#EEEFE8;border-radius:6px;
padding:2px 6px;color:#2A3B31}}
</style>
<header><div class="tag">PILOTV / BRAND MOTION</div>
<h1>字标打字机动画 + V 翻转</h1>
<p>整词不做横向位移：<b>P</b> 静止不动，<b>V</b> 加粗且只绕竖轴左右翻转；
小写 <b>i / l / o / t</b> 依次落位、随后逆序下沉消失，不停循环。
周期 6.8s（V 翻转 3.4s），已内置 <code>prefers-reduced-motion</code> 静态回退。</p></header>

<section><h2>实时 · 浅色底（当前左上角用法）<span class="hint">实时画面停在打字机中途，请看下方冻结帧</span></h2>
<div class="panel"><img src="pilotv-logo-animated.svg" alt="PilotV">
<span class="tag">img 引入 430px</span></div></section>

<section><h2>实时 · 深色底</h2>
<div class="panel dark"><img src="pilotv-logo-animated-dark.svg" alt="PilotV"
style="width:430px"></div></section>

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
<div class="panel"><div class="strip">
<span class="actual"><img src="pilotv-logo-animated.svg" height="17"></span>
<span class="zoom"><img src="pilotv-logo-animated.svg" height="51"></span>
<span class="chip"><img src="pilotv-logo-animated-dark.svg" height="17"></span>
<span class="chip"><img src="pilotv-logo-animated-dark.svg" height="51"></span></div>
<span class="tag">左侧为真实 17px，右侧为 3 倍放大；动作在小尺寸下收敛为轻微摆动</span></div></section>

<section><h2>冻结帧 · 字标一个周期</h2><div class="frozen three">
{frame_cells(word, [0.0, 0.55, 1.10, 2.10, 3.40, 5.30])}
</div></section>

<section><h2>冻结帧 · 图标</h2><div class="frozen">
{frame_cells(icon, [0.0, 0.85, 1.70, 2.55])}
</div></section>

<section><h2>用法</h2>
<div class="panel" style="display:block;font-size:12.5px;color:#3C4A40;line-height:2.1">
直接 <code>&lt;img src="/brand/pilotv-logo-animated.svg" /&gt;</code>；动画在 img 内联场景同样生效。<br>
在 React 里需要跟随主题色时用 <code>PilotVLogo</code> 组件（内联 SVG + 同目录 CSS）。<br>
favicon 请用静态 <code>pilotv-mark.svg</code>：动画 favicon 仅部分浏览器支持。
</div></section></html>"""

(OUT / "preview.html").write_text(html)

# Same page as a single file with assets inlined, for delivery.
inlined = (OUT / "preview.html").read_text().replace(
    "", ""
)
(OUT / "preview-standalone.html").write_text(inlined)
for name, src in [("logo.svg", word), ("logo-dark.svg", word_dark),
                  ("icon.svg", icon), ("icon-plain.svg", icon_plain)]:
    (OUT / name).write_text(src)
print("preview + standalone written to", OUT)
