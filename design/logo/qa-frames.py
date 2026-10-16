#!/usr/bin/env python3
"""Browser assertions for the point → line → V → PilotV one-shot sequence."""
from pathlib import Path
import re
from xml.etree import ElementTree as ET
from playwright.sync_api import sync_playwright
from motion import PHASES

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / 'pilotdeck-mobile/upstream-official/ui'
NAMES = ['pilotv-logo-animated.svg', 'pilotv-logo-animated-dark.svg',
         'pilotv-icon-animated.svg', 'pilotv-icon-animated-plain.svg']
NS = {'s': 'http://www.w3.org/2000/svg'}
word = (ROOT / 'brand' / NAMES[0]).read_text()
paths = [p.attrib['d'] for p in ET.fromstring(word).findall('.//s:path', NS)]
tsx = (UI / 'src/components/app-shell/PilotVLogo.tsx').read_text()
assert re.findall(r"d: '([^']+)'", tsx) == paths, 'React glyph geometry drift'
css = (UI / 'src/components/app-shell/PilotVLogo.css').read_text()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/snap/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page()
    def state(second):
        return page.evaluate('''t => {
          for (const a of document.getAnimations()) {a.pause(); a.currentTime = t * 1000;}
          const get = suffix => {const el = document.querySelector('.' + suffix) || document.querySelector('.pv-logo__' + suffix); const c = getComputedStyle(el); return {opacity:+c.opacity, transform:c.transform};};
          return {spark:get('spark'), bar:get('bar'), v:get('v'), letters:[...'Pilot'].map(ch=>get('letter-'+ch))};
        }''', second)
    sources = []
    for name in NAMES:
        svg = (ROOT / 'brand' / name).read_text()
        assert svg == (UI / 'public/brand' / name).read_text(), name
        tree = ET.fromstring(svg)
        assert len(tree.findall('.//s:rect', NS)) == 1, 'Boxed icon returned'
        assert len(tree.findall('.//s:path', NS)) == 6
        assert 'infinite' not in svg
        sources.append((name, svg))
    # Exercise the shipped component stylesheet with the identical outlined geometry.
    component = re.sub(r'<style>.*?</style>', '<style>'+css+'</style>', word, flags=re.S)
    component = re.sub(r'class="([^"]+)"', r'class="pv-logo__\1"', component)
    component = component.replace('<svg ', '<svg class="pv-logo pv-logo--animated" ')
    sources.append(('React stylesheet / shared geometry', component))
    for name, svg in sources:
        page.emulate_media(reduced_motion='no-preference')
        page.set_content(svg)
        start = state(.55)
        assert start['spark']['opacity'] == 1 and start['v']['opacity'] == 0
        line = state(1.6)
        assert line['bar']['opacity'] == 1 and line['v']['opacity'] == 0
        supported = state(2.62)
        assert supported['v']['opacity'] > .98 and all(x['opacity'] == 0 for x in supported['letters']), (name, supported)
        for count, (second, _) in enumerate(PHASES[4:9], 1):
            s = state(second)
            assert [x['opacity'] for x in s['letters']] == [1]*count + [0]*(5-count), (name, second, s)
        assert state(9) == state(60), 'Final logo must hold, never rewind'
        page.emulate_media(reduced_motion='reduce')
        reduced = state(0)
        assert reduced['spark']['opacity'] == 0
        assert reduced['v']['opacity'] == reduced['bar']['opacity'] == 1
        assert all(x['opacity'] == 1 and x['transform'] == 'none' for x in reduced['letters'])
        assert page.evaluate('document.getAnimations().length') == 0
        print('PASS', name, ': point, line, unboxed V, P/i/l/o/t order, 60s hold, reduced motion')
    browser.close()
print('PASS all 4 public copies, 6 outlined glyphs, React glyph parity; no infinite animation or box')
