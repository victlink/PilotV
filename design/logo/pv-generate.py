#!/usr/bin/env python3
"""Generate six transparent, path-only PV monograms and a review board."""
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile
import os
import json
import urllib.request
import urllib.error

# --------------------------------------------------------------------- 成果台发布

_ARTIFACTS_BASE = os.environ.get("ARTIFACTS_BASE", "http://127.0.0.1:8799")
_ARTIFACTS_TOKEN = os.environ.get("ARTIFACTS_TOKEN", "")


def _call(method, path, payload=None):
    url = _ARTIFACTS_BASE.rstrip("/") + path
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if _ARTIFACTS_TOKEN:
        req.add_header("Authorization", f"Bearer {_ARTIFACTS_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode("utf-8")) if r.read else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": body[:300]}
    except Exception as exc:
        return 0, {"error": f"{type(exc).__name__}: {exc}"}


def publish(path, kind, title, run_id, deliverable="final"):
    """将已写入磁盘的文件注册到成果台。静默失败，不阻塞生成流程。"""
    if not run_id:
        return None
    status, data = _call("POST", "/api/artifacts", {
        "kind": kind, "title": title, "path": path,
        "run_id": run_id, "agent": "pilotdeck", "deliverable": deliverable,
    })
    if status == 200:
        aid = data.get("id", "?")
        print(f"  → 成果台 {aid} ({title})")
        return aid
    else:
        print(f"  ! 成果台发布失败 {status}: {data.get('error', '')[:80]}")
        return None

ROOT = Path(__file__).resolve().parent / 'pv-concepts'
ROOT.mkdir(exist_ok=True)
INK = '#182320'
GREEN = '#277564'
# All letters are hand-built paths, not text or font glyphs.
P = 'M40 220V40H123C164 40 187 63 187 100S164 160 123 160H80V220ZM80 78V122H120C138 122 147 115 147 100S138 78 120 78Z'

def path(d, color, extra=''):
    return f'<path d="{d}" fill="{color}" fill-rule="evenodd" {extra}/>'

def build(n, ink=INK, accent=GREEN):
    if n == 1:
        return path(P, ink) + path('M198 40H243L281 168L319 40H364L302 220H260Z', ink)
    if n == 2:
        # The left leg of the V grows from the foot of the P bowl.
        return path('M64 220V40H144C184 40 207 62 207 99C207 137 184 160 144 160H104V220ZM104 78V122H141C158 122 167 115 167 100S158 78 141 78Z', ink) + path('M132 122H176L218 205L286 40H330L241 248H197Z', accent)
    if n == 3:
        # A continuous P returns to its shared stem before sweeping into V.
        return f'<path d="M70 220V54H143C207 54 207 140 143 140H70L193 220L303 54" fill="none" stroke="{ink}" stroke-width="27" stroke-linejoin="round" stroke-linecap="round"/>'
    if n == 4:
        # Forward-leaning separate letters, with a precise diagonal rhythm.
        return '<g transform="translate(12 0) skewX(-10)">' + path(P, ink) + path('M190 40H235L274 171L313 40H358L295 220H253Z', accent) + '</g>'
    if n == 5:
        # Broad geometric P with a sharp V sharing its right contour.
        return path('M48 220V40H143C187 40 212 65 212 101C212 139 187 164 143 164H91V220ZM91 79V125H139C158 125 170 117 170 102S158 79 139 79Z', ink) + path('M183 40H225L264 170L305 40H350L287 220H243Z', ink)
    if n == 6:
        # Contrast-serif direction: bracketless stems, bowl, and fine V stroke.
        return path('M35 220V210H58V50H35V40H129C177 40 202 60 202 96C202 135 172 153 130 153H98V210H125V220ZM98 51V142H123C148 142 162 126 162 97C162 68 148 51 123 51Z', ink) + path('M192 40H268V50H251L293 170L335 50H315V40H369V50H349L289 223H277L213 50H192Z', ink)

def svg(body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 280" width="400" height="280">{body}</svg>'

run_id = os.environ.get("PILOTDECK_SESSION_ID", "")

items = [
    ('01', '并列几何', '清晰、稳重，优先保证 P 与 V 的辨识度。'),
    ('02', '共笔折线', '从 P 的腹部延伸出 V，更像一枚整体徽记。'),
    ('03', '一笔连写', '圆角线条贯穿两个字母，轻盈、有连接感。'),
    ('04', '前倾动势', '字母整体前倾，用深绿区分 V，强调行动感。'),
    ('05', '紧凑融合', 'P 与 V 相互咬合，压缩成更紧凑的标识。'),
    ('06', '衬线字标', '粗细对比和细衬线，偏编辑、精品工具气质。'),
]
cards = []
for num, title, desc in items:
    n = int(num)
    body = build(n)
    for suffix, content in [('color', body), ('mono', build(n, INK, INK)), ('reverse', build(n, '#F5F5EF', '#92C9B1'))]:
        source = svg(content)
        ElementTree.fromstring(source)
        (ROOT / f'pv-{num}-{suffix}.svg').write_text(source)
        publish(str(ROOT / f'pv-{num}-{suffix}.svg'), "image", f'pv-{num}-{suffix}.svg', run_id)
    cards.append(f'''<section class="card"><div class="label"><b>{num}</b><h2>{title}</h2></div>
<div class="main">{svg(body)}</div>
<div class="samples"><div class="reverse">{svg(build(n, '#F5F5EF', '#92C9B1'))}</div><div class="mono">{svg(build(n, INK, INK))}<span>单色 / 缩小</span></div></div>
<p>{desc}</p></section>''')
html = '''<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>PilotV · PV 字母组合</title><style>
*{box-sizing:border-box}body{margin:0;background:#F3F1EA;color:#182320;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;padding:48px 52px;width:1440px}header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:30px}.eyebrow{font-size:13px;letter-spacing:3px;color:#62736B}h1{font-size:38px;letter-spacing:-1px;margin:12px 0 0;font-weight:700}.meta{text-align:right;font-size:14px;line-height:1.9;color:#6A756E}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.card{background:#FFFEFA;border:1px solid #DEDCD2;padding:22px 24px 18px;border-radius:4px}.label{display:flex;gap:14px;align-items:center}.label b{font-size:13px;font-weight:500;color:#79867F}h2{font-size:17px;margin:0;font-weight:600}.main{height:232px;display:flex;justify-content:center;align-items:center}.main svg{width:320px;height:224px}.samples{display:grid;grid-template-columns:1fr 1fr;gap:12px;height:90px}.reverse{background:#182320;display:flex;align-items:center;justify-content:center;border-radius:3px}.reverse svg{width:120px;height:84px}.mono{display:flex;align-items:center;justify-content:center;flex-direction:column;background:#F3F1EA;border-radius:3px}.mono svg{width:72px;height:50px}.mono span{font-size:10px;color:#79867F}p{font-size:12px;color:#68776F;margin:18px 0 0;line-height:1.7;white-space:nowrap}footer{display:flex;justify-content:space-between;margin-top:28px;font-size:12px;color:#7A847E;letter-spacing:.5px}</style>
<header><div><div class="eyebrow">PILOTV / IDENTITY EXPLORATION</div><h1>让 P 与 V 成为一个标识。</h1></div><div class="meta">六种字母组合 · 无外框设计<br>透明背景 SVG / 彩色 · 单色 · 反白</div></header><div class="grid">'''+''.join(cards)+'''</div><footer><span>PILOTV — PV MONOGRAM STUDIES</span><span>概念稿 / 02</span></footer></html>'''
(ROOT / 'preview.html').write_text(html)
publish(str(ROOT / 'preview.html'), "page", "pv-concepts preview.html", run_id, deliverable="aux")
with ZipFile(ROOT / 'PilotV-PV-SVG.zip', 'w') as z:
    for f in sorted(ROOT.glob('*.svg')):
        z.write(f, f.name)
    z.write(ROOT / 'preview.html', 'preview.html')
publish(str(ROOT / 'PilotV-PV-SVG.zip'), "doc", "PilotV-PV-SVG.zip", run_id)
print(f'Generated and XML-validated 18 SVGs, preview.html, and ZIP in {ROOT.name}')
