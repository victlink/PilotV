#!/usr/bin/env python3
"""定位某一档位下把 .art-body 撑宽的元素（自适应改造的溢出排查）。

只读诊断：用项目自带的 CDP 客户端量真实盒子，不改任何项目文件。
用法: python3 scripts/check_overflow.py 393 852
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from artifacts_cdp import run_script  # noqa: E402

URL = os.environ.get("ARTIFACTS_URL", "http://127.0.0.1:8799/artifacts.html")

JS = r"""
(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {w: Math.round(r.width), h: Math.round(r.height),
            scrollW: el.scrollWidth, pos: cs.position, disp: cs.display,
            minW: cs.minWidth, gridCols: cs.gridTemplateColumns};
  };
  // 全页扫一遍：谁比视口还宽
  const vw = document.documentElement.clientWidth;
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > vw + 1 || r.right > vw + 1) {
      wide.push({tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 40),
                 w: Math.round(r.width), right: Math.round(r.right),
                 pos: getComputedStyle(el).position, disp: getComputedStyle(el).display});
    }
    if (wide.length > 12) break;
  }
  // 顶栏 / 工具条逐个子元素量宽度，定位是谁把整条撑宽
  const kids = (sel) => {
    const host = document.querySelector(sel);
    if (!host) return [];
    return [...host.children].map((el) => {
      const r = el.getBoundingClientRect();
      return {cls: (el.className || '').toString().slice(0, 26) || el.tagName.toLowerCase(),
              w: Math.round(r.width), right: Math.round(r.right),
              disp: getComputedStyle(el).display};
    });
  };
  return JSON.stringify({
    vw, innerW: window.innerWidth,
    shell: rect('.art-shell'),
    body: rect('.art-body'),
    main: rect('.art-main'),
    toolbar: rect('.art-toolbar'),
    stage: rect('.art-stage'),
    stageInner: rect('.art-stage-inner'),
    render: rect('.art-render'),
    side: rect('.art-side'),
    anno: rect('.art-anno'),
    bodyClass: (document.querySelector('.art-body') || {}).className,
    bodyCols: (() => { const b = document.querySelector('.art-body');
                        return b ? getComputedStyle(b).gridTemplateColumns : ''; })(),
    topbarKids: kids('.art-topbar'),
    toolbarKids: kids('.art-toolbar'),
    wide,
  });
})()
"""


async def main() -> int:
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 393
    h = int(sys.argv[2]) if len(sys.argv) > 2 else 852
    res = await run_script(URL, JS, viewport=(w, h), wait_timeout=6)
    raw = (res or {}).get("value") or ""
    if not raw:
        print("页面没打开")
        return 1
    d = json.loads(raw)
    print(f"视口 clientWidth={d['vw']} innerWidth={d['innerW']}  body.class={d['bodyClass']!r}")
    print(f"body 计算列宽 = {d['bodyCols']}")
    for k in ("shell", "body", "main", "toolbar", "stage", "stageInner", "render", "side", "anno"):
        b = d.get(k)
        if b:
            print(f"  {k:<11} w={b['w']:<6} h={b['h']:<6} scrollW={b['scrollW']:<6} "
                  f"pos={b['pos']:<7} disp={b['disp']:<7} minW={b['minW']}")
    print("超宽元素:")
    for e in d.get("wide", []):
        print(f"  {e['tag']}.{e['cls']:<40} w={e['w']:<6} right={e['right']:<6} "
              f"pos={e['pos']} disp={e['disp']}")
    if not d.get("wide"):
        print("  （无）")
    for host in ("topbar", "toolbar"):
        print(f"{host} 子元素宽度（视口 {d['vw']}）:")
        for c in d.get(host + "Kids", []):
            flag = "  <-- 超" if c["right"] > d["vw"] else ""
            print(f"  {c['cls']:<26} w={c['w']:<5} right={c['right']:<5}{flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
