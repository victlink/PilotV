#!/usr/bin/env python3
"""Three V identity constructions with outlined typography and self-contained boards."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from xml.etree import ElementTree as ET
from zipfile import ZipFile
import subprocess
ROOT=Path(__file__).resolve().parent/'refined'
ROOT.mkdir(exist_ok=True)
# Resolve installed typeface rather than assume a machine-specific font location.
fontpath=subprocess.check_output(['fc-match','-f','%{file}','Lato:style=Semibold'],text=True)
f=TTFont(fontpath); gs=f.getGlyphSet(); cmap=f.getBestCmap(); upm=f['head'].unitsPerEm

def letters(text,x,y,size,fill='currentColor',tracking=0):
    out=[]; pos=0; scale=size/upm
    for c in text:
        name=cmap[ord(c)]; pen=SVGPathPen(gs); gs[name].draw(pen)
        out.append(f'<path d="{pen.getCommands()}" transform="translate({x+pos:.3f} {y}) scale({scale} {-scale})"/>')
        pos+=gs[name].width*scale+tracking
    return f'<g fill="{fill}">'+''.join(out)+'</g>'

# 240 x 240 masters. Distinct contours; all features work without color.
marks=[
    # A converging, curved channel separates asymmetric masses.
    '<path d="M27 40H86L126 155L104 209Z M106 209L155 74Q167 40 205 40H223L149 209Z"/>',
    # Broad V with a controlled oblique incision (negative space).
    '<path d="M22 48H82L119 144L162 48H224L179 145L134 171L188 145L157 212H103Z"/>',
    # Calligraphic continuous V with an extended upward terminal.
    '<path d="M26 59Q54 37 80 53Q91 61 99 88L128 173Q138 204 152 166L184 77Q197 39 224 33L213 67Q205 73 197 96L165 185Q153 219 127 219Q100 219 88 185L56 94Q47 69 26 77Z"/>',
]
names=['汇流 / CONFLUENCE','切向 / VECTOR CUT','回转 / CONTINUUM']
notes=['两条不等宽的笔画，围出一条向下收束的弧形通道。','把方向感藏进一道斜切口，而不是额外加箭头或翅膀。','将 V 写成一次连续转向，用曲线与上扬末梢形成记忆点。']

def mark(n, color='#17201E'):
    return f'<g fill="{color}">{marks[n]}</g>'
def svg(body,w=240,h=240):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{body}</svg>'
def lock(n,color='#17201E'):
    # pilot is aligned with the V shoulder, not isolated as a footnote.
    return svg(letters('pilot',10,147,91,color,-2.3)+f'<g transform="translate(178 0)">{mark(n,color)}</g>',430,240)

sections=[]
for i in range(3):
    outputs={'mark':svg(mark(i)), 'reverse':svg(mark(i,'#F7F5EE')), 'lockup':lock(i), 'lockup-reverse':lock(i,'#F7F5EE')}
    for suffix,source in outputs.items():
        ET.fromstring(source)
        assert '<text' not in source
        (ROOT/f'pilotv-{i+1:02}-{suffix}.svg').write_text(source)
    tests=''.join(f'<div>{svg(mark(i))}<span>{s}px</span></div>'.replace('<svg ',f'<svg style="width:{s}px;height:{s}px" ',1) for s in [64,32,16])
    sections.append(f'''<section><div class="caption"><b>0{i+1}</b><h2>{names[i]}</h2></div><div class="symbol">{svg(mark(i))}</div><div class="lock">{outputs['lockup']}</div><div class="proof"><div class="inverse">{outputs['reverse']}</div><div class="sizes">{tests}</div></div><p>{notes[i]}</p></section>''')
html='''<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>PilotV / Identity constructions</title><style>*{box-sizing:border-box}body{margin:0;width:1500px;padding:50px 56px 36px;background:#F4F2EB;color:#17201E;font-family:"Noto Sans CJK SC",sans-serif}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #C7CDC5;padding-bottom:24px}.eyebrow{font-size:12px;letter-spacing:2px;color:#778177}h1{font-size:37px;margin:12px 0 0;letter-spacing:-1px;font-weight:500}.aside{font-size:12px;color:#6C786E;line-height:1.9;text-align:right}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:28px}section{min-width:0}.caption{display:flex;align-items:center;gap:16px}.caption b{font-size:12px;font-weight:400;color:#8A9389}h2{font-size:14px;font-weight:500;letter-spacing:.7px;margin:0}.symbol{height:300px;display:flex;justify-content:center;align-items:center}.symbol svg{width:265px;height:265px}.lock{border-top:1px solid #D8DCD3;height:182px;display:flex;justify-content:center;align-items:center}.lock svg{width:315px;height:176px}.proof{height:130px;display:grid;grid-template-columns:1fr 1.15fr;gap:16px}.inverse{display:flex;align-items:center;justify-content:center;background:#17201E}.inverse svg{width:100px;height:100px}.sizes{display:flex;align-items:center;justify-content:center;gap:15px;background:#EAECE4}.sizes div{display:flex;flex-direction:column;align-items:center;gap:10px}.sizes span{font-size:9px;color:#8A9389}p{font-size:12px;line-height:1.9;color:#69756B;margin:19px 0 0;min-height:48px}footer{display:flex;justify-content:space-between;border-top:1px solid #C7CDC5;margin-top:24px;padding-top:18px;font-size:11px;color:#7F897E;letter-spacing:1px}</style><header><div><div class="eyebrow">PILOTV / RECONSTRUCTION — 04</div><h1>不是给 V 加装饰，而是重新构造 V。</h1></div><div class="aside">三种构形 · 同一黑白标准<br>主标 / 字标组合 / 反白 / 缩小测试</div></header><div class="grid">'''+''.join(sections)+'''</div><footer><span>FORM FIRST. COLOR LATER.</span><span>探索稿 · 未定稿 · 未做商标近似检索</span></footer></html>'''
(ROOT/'identity-board.html').write_text(html)
with ZipFile(ROOT/'PilotV-Reconstruction.zip','w') as z:
    for file in sorted(ROOT.glob('*.svg')):z.write(file,file.name)
    z.write(ROOT/'identity-board.html','identity-board.html')
print('Validated 12 outlined SVGs; generated standalone board and ZIP.')
