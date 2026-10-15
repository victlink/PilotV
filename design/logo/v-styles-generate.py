#!/usr/bin/env python3
"""Six V-led identity studies. All SVG lettering is vector geometry."""
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent / 'v-styles'
ROOT.mkdir(exist_ok=True)

def path(d, fill):
    return f'<path d="{d}" fill="{fill}"/>'

def pilot(color, y=264, tracking=0):
    # Custom monoline lowercase pilot; no installed-font dependency.
    letters = [
        ('M0 28V0H10C24 0 24 18 10 18H0', 29),
        ('M0 0V18M0 -8V-7', 12),
        ('M0 -10V18', 12),
        ('M10 0C-3 0 -3 18 10 18C23 18 23 0 10 0Z', 29),
        ('M6 -8V12Q6 18 14 18M0 0H15', 19),
    ]
    total = sum(w for _, w in letters) + 4*tracking
    x = (400-total)/2
    parts = []
    for d, w in letters:
        parts.append(f'<path transform="translate({x} {y})" d="{d}"/>')
        x += w+tracking
    return f'<g fill="none" stroke="{color}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">'+''.join(parts)+'</g>'

def mark(n, ink, accent, mono=False):
    if n == 1:
        return path('M94 48H151L200 171L249 48H306L224 224H176Z', ink)
    if n == 2:
        return path('M53 82L171 110L199 220L146 160Z', ink)+path('M199 220L222 103L352 45L270 164Z', accent)
    if n == 3:
        return f'<path d="M105 65L170 190Q200 245 230 190L297 63" fill="none" stroke="{ink}" stroke-width="32" stroke-linecap="round"/>' + f'<path d="M91 106L129 182" fill="none" stroke="{accent}" stroke-width="7" stroke-linecap="round"/>'
    if n == 4:
        # Folded ribbon V; in monochrome a cut separates the overlapping faces.
        return path('M91 52H150L219 221H163Z', ink)+path('M163 221L252 52H312L222 221Z', accent)+('' if mono else path('M163 221H222L196 157Z', '#254683'))
    if n == 5:
        return path('M79 49H182V58H158L214 187L269 58H239V49H319V58H287L215 222H199L119 58H79Z', ink)
    if n == 6:
        return path('M88 51H136V91H160V131H184V171H216V131H240V91H264V51H312V111H288V151H264V191H240V231H160V191H136V151H112V111H88Z', ink)+path('M285 24H312V40H285Z', accent)

def svg(n, ink, accent, mono=False, with_pilot=True):
    content = mark(n, ink, accent, mono)
    if with_pilot:
        content += pilot(ink, tracking=4 if n in (2,5) else 0)
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 320" width="400" height="320">'+content+'</svg>'

items = [
    ('几何极简','清晰 / 克制 / 通用','宽肩与平切底部，适合长期使用的主标。','#18211F','#18211F','#F4F3EC'),
    ('飞翼导航','锐利 / 方向 / 轻快','不对称双翼，让 V 带有领航与起飞的意味。','#123849','#118998','#EFF7F6'),
    ('流线圆角','柔和 / 连接 / 亲和','连续圆弧与短回声线，偏轻量软件气质。','#246451','#76AD83','#EFF5EC'),
    ('折纸空间','折叠 / 层次 / 科技','交叠色面构成 V，像一条折起的带子。','#182E5C','#527DEC','#F0F3FA'),
    ('精品衬线','优雅 / 编辑 / 精致','粗细笔画与细衬线，避免常见的科技符号感。','#51312C','#51312C','#F8F0E9'),
    ('像素模块','复古 / 开发者 / 实验','阶梯轮廓与小信号块，更鲜明、更有游戏感。','#343246','#AC4D28','#F4F0E7'),
]
cards=[]
for n,(title,tags,desc,ink,accent,bg) in enumerate(items,1):
    variants = {'color':svg(n,ink,accent),'mono':svg(n,'#1C2220','#1C2220',True),'reverse':svg(n,'#F5F5EF','#F5F5EF',True),'mark':svg(n,ink,accent,with_pilot=False)}
    for suffix,source in variants.items():
        ET.fromstring(source)
        assert '<text' not in source
        (ROOT/f'v-{n:02}-{suffix}.svg').write_text(source)
    cards.append(f'''<section><div class="heading"><span>0{n}</span><h2>{title}</h2><small>{tags}</small></div><div class="hero" style="background:{bg}">{variants['color']}</div><div class="bottom"><div class="dark">{variants['reverse']}</div><div class="small">{variants['mono']}<em>单色 · 缩小组合</em></div><div class="solo">{svg(n,ink,accent,with_pilot=False)}<em>独立 V</em></div></div><p>{desc}</p></section>''')
html='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PilotV · V 风格探索</title><style>
*{box-sizing:border-box}body{margin:0;width:1500px;padding:42px 48px 26px;background:#F5F4EF;color:#202723;font-family:"Noto Sans CJK SC",sans-serif}header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:26px}.kicker{font-size:12px;letter-spacing:3px;color:#758078}h1{font-size:36px;margin:8px 0 0;font-weight:650;letter-spacing:-1px}.note{text-align:right;font-size:13px;color:#737D76;line-height:1.9}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}section{padding:20px;background:#FFFEFA;border:1px solid #E0E1D9;border-radius:5px}.heading{display:flex;gap:12px;align-items:center;margin-bottom:15px}.heading span{color:#849087;font-size:12px}h2{font-size:17px;margin:0}.heading small{margin-left:auto;font-size:10px;color:#7C867F}.hero{height:260px;display:flex;align-items:center;justify-content:center;border-radius:3px}.hero svg{width:310px;height:248px}.bottom{margin-top:12px;display:grid;grid-template-columns:1.15fr 1fr .8fr;gap:10px;height:90px}.dark{background:#1C2522;border-radius:3px;display:flex;align-items:center;justify-content:center}.dark svg{width:104px;height:83px}.small,.solo{display:flex;flex-direction:column;align-items:center;justify-content:center;background:#F4F4EF;border-radius:3px}.small svg{width:72px;height:58px}.solo svg{width:62px;height:50px}em{font-style:normal;font-size:9px;color:#8A928C}p{font-size:12px;color:#747E76;margin:15px 0 0;white-space:nowrap}footer{display:flex;justify-content:space-between;margin-top:22px;font-size:11px;color:#859087;letter-spacing:1px}
</style><header><div><div class="kicker">PILOTV / SIX VISUAL DIRECTIONS</div><h1>V 为主角，pilot 为签名。</h1></div><div class="note">六种结构与气质，不只是六种配色<br>无外框 · 透明矢量 · 独立主标与组合标</div></header><div class="grid">'''+''.join(cards)+'''</div><footer><span>PILOTV — V-LED IDENTITY STUDIES</span><span>CONCEPT ROUND / 03</span></footer></html>'''
(ROOT/'preview.html').write_text(html)
with ZipFile(ROOT/'PilotV-V-Styles.zip','w') as z:
    for f in sorted(ROOT.glob('*.svg')):
        z.write(f,f.name)
    z.write(ROOT/'preview.html','preview.html')
print('Validated 24 path-only SVG files; generated review board and ZIP.')
