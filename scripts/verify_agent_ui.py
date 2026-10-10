#!/usr/bin/env python3
"""M4 前端验收：来源 agent 筛选条（多 agent 同流的可视化）。

    python3 scripts/verify_agent_ui.py [--api http://127.0.0.1:8899] [--shot /tmp/artifacts-agents.png]

造两份同名标题、不同 agent 的成果，在浏览器里确认筛选条出现、
点某个 agent 后列表只剩它的活、卡片上挂着来源标签。
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import artifacts_cdp  # noqa: E402
from verify_import import build_dir, req, start_server, up  # noqa: E402

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


UI_SCRIPT = r"""
(async () => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const row = $('#artAgents');
  for (let i = 0; i < 80 && (!row || !row.children.length); i++) await sleep(150);

  /* 本套件验的是「按来源 agent 筛选」，得先把项目/会话下拉摊回「全部」。
     不然左栏默认就收窄到某个对话，树里只剩几条成果，按 agent 筛无可筛 ——
     失败原因不是筛选坏了，是量错了集合。 */
  const sp = document.getElementById('selProject'), ss = document.getElementById('selSession');
  if (sp) { sp.value = ''; sp.dispatchEvent(new Event('change')); }
  if (ss) { ss.value = ''; ss.dispatchEvent(new Event('change')); }
  await sleep(500);
  for (let i = 0; i < 40 && !$('.art-node-artifact'); i++) await sleep(150);

  /* 1) 折叠态：默认只露前几个 + 「更多」，别把成果流挤下去屏 */
  out.collapsedChips = $$('.art-chip-agent').length;
  out.moreLabel = (document.querySelector('[data-agents-toggle]') || {}).textContent || '';
  out.rowHeight = Math.round(row.getBoundingClientRect().height);
  out.chips = $$('.art-chip-agent').map(c => c.textContent.trim());

  /* 2) 展开，把新 agent（计数小、排折叠线下）找出来点掉 */
  const want = document.body.dataset.wantAgent || '';
  const findTarget = () => $$('.art-chip-agent').find(c => c.dataset.agent === want);
  const more = document.querySelector('[data-agents-toggle]');
  if (more) { more.click(); for (let i = 0; i < 40; i++) await sleep(100); }
  out.expandedChips = $$('.art-chip-agent').length;
  out.expandedScrolls = (() => { const r = $('#artAgents');
    return r.scrollHeight > r.clientHeight + 2; })();
  const target = findTarget();
  if (target) target.click();
  for (let i = 0; i < 60; i++) await sleep(150);

  /* 3) 筛完的样子 */
  /* 成果流已经换成左侧目录树了，这里看树上挂出来的成果行，
     不再看 .art-card —— 那套卡片流连同 #artStream 一起被目录树取代了。 */
  out.after = document.querySelectorAll('.art-node-artifact').length;
  out.agents = $$('.art-src-agent').map(s => s.textContent.trim().replace('◈', '').trim());
  out.labels = out.agents.slice(0, 4).map(t => t.replace('◈ ', ''));
  /* 筛过之后树上只该剩选中 agent 的成果，标签也该全是它 */
  out.onlyPicked = out.agents.length > 0 && out.agents.every(t => t === want);
  out.active = ($('.art-chip-agent.active') || {}).textContent || '';

  /* 4) 收回去，确认还能收 —— 顺手记下全量卡片数用于比对 */
  out.totalCards = document.querySelectorAll('.art-node-artifact').length;
  const toggle = document.querySelector('[data-agents-toggle]');
  if (toggle) {
    toggle.click();
    for (let i = 0; i < 40; i++) await sleep(100);
  }
  /* 「还能看到好几行」要数真正落在可视区里的行。以前这里写死 96px 一行去
     除树高，而实际成果行只有 27px 高 —— 504/96=5 会算成 3，纯属量纲错。
     直接量有多少行的盒子真的落在树的可视范围内，结论才站得住。

     数的是**所有**树节点行（会话 + 成果），不是只有成果行：
     跑到这一步时上面刚断言过「筛完只剩那一个 agent 的成果」，全树一共就剩
     3 条成果，再要求「看得见 4 行成果」是自相矛盾的 —— 跟布局怎么排无关，
     旧布局新布局都必然失败。判据的本意是「agent 筛选条不许把成果流挤没」，
     所以按可见的树行数来量。 */
  const tree = $('#artTree') || $('#artSide') || document.body;
  const tb = tree.getBoundingClientRect();
  out.streamHeight = Math.round(tb.height);
  out.cardsPerView = [...document.querySelectorAll(
    '.art-node-artifact, .art-node-session')].filter((r) => {
    const b = r.getBoundingClientRect();
    return b.bottom > tb.top + 1 && b.top < tb.bottom - 1;
  }).length;
  return out;
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
    ap.add_argument("--shot", default="/tmp/artifacts-agents.png")
    ap.add_argument("--force", action="store_true",
                    help="确实要写进这个数据目录（默认拒绝写正式库）")
    ap.add_argument("--token", default=os.environ.get("ARTIFACTS_TOKEN"))
    args = ap.parse_args()
    api = args.api.rstrip("/")
    # 顺序很要紧：先起服务（start_server 会给自己隔离一个数据目录），
    # 再跑护栏。反过来的话，护栏在「服务还没起」时就只能干瞪眼，
    # 而一旦它没拦住、后面自起服务又没隔离，照样写进正式库。
    proc = start_server(api)
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。
    try:
        assert_test_server(args.api, args.token, force=getattr(args, "force", False))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    tag = str(int(time.time()))
    src = os.path.join(ROOT, ".artifacts-data", f"m4ui-{tag}")
    os.makedirs(src, exist_ok=True)

    try:
        print("\n[1 两个 agent 交同一批产出]", flush=True)
        build_dir(src, tag)
        a1 = req(api, "/api/artifacts/import", "POST", {"dir": src, "agent": f"uiagent-{tag}"})
        a2 = req(api, "/api/artifacts/import", "POST", {"dir": src, "agent": f"uiagent-b-{tag}"})
        check(a1["counts"]["imported"] == 3 and a2["counts"]["imported"] == 3,
              "两个 agent 各导 3 件", f"A={a1['counts']['imported']} B={a2['counts']['imported']}")

        # 再补一批「别的 agent」：折叠/滚动这两条断言只有在 agent 足够多时才有意义。
        # 之前靠库里历史残留凑数，干净数据目录下跑必挂 —— 自己种，别指望运气。
        for i in range(24):
            # 每件都要有真文件：没有文件的成果会被判成「显示不出来」并默认收起，
            # 树里就只剩两三条，下面「还能看到好几行」的布局断言必然挂。
            body = bytes([(i * 17 + k) % 251 for k in range(64 + i * 3)])
            fp = os.path.join(src, f"noise-{i}.png")
            with open(fp, "wb") as fh:
                fh.write(body)
            req(api, "/api/artifacts", "POST",
                {"agent": f"noise-{i}-{tag}", "kind": "image",
                 "title": f"噪音 {i}", "path": fp})
        noise = req(api, "/api/artifacts?limit=200")["total"]
        check(noise >= 30, "库里有足够多的 agent 可筛", f"共 {noise} 张卡片")

        print("\n[2 浏览器里看来源筛选]", flush=True)
        UI_SCRIPT_WANT = UI_SCRIPT.replace(
            "const want = document.body.dataset.wantAgent || '';",
            f"const want = {json.dumps(f'uiagent-{tag}')};")
        res = asyncio.run(artifacts_cdp.run_script(
            f"{api}/artifacts.html", UI_SCRIPT_WANT,
            wait_js="document.querySelectorAll('.art-project').length > 0",
            screenshot_path=args.shot))
        val = res.get("value") or {}
        check(bool(val.get("chips")), "来源筛选条渲染出来了", " / ".join(val.get("chips") or [])[:80])
        check(len(val.get("chips") or []) >= 3, "含「全部」与多个 agent",
              f"{len(val.get('chips') or [])} 个 chip")
        check(any(t.startswith(f"uiagent-{tag}") for t in (val.get("labels") or [])),
              "成果行上挂着来源标签", " ".join(val.get("labels") or [])[:60])
        total_now = req(api, "/api/artifacts?limit=200")["total"]
        check((val.get("after") or 0) > 0 and (val.get("after") or 0) < total_now,
              "点某个 agent 后列表收窄",
              f"全量 {total_now} → 只剩 {val.get('after')}")
        check(set(val.get("agents") or []) == {f"uiagent-{tag}"},
              "筛完只剩那一个 agent 的成果", " ".join(val.get("agents") or [])[:60])
        check(f"uiagent-{tag}" in (val.get("active") or ""), "选中的 chip 高亮",
              (val.get("active") or "").strip()[:40])
        check((val.get("collapsedChips") or 0) <= 4 and "更多" in (val.get("moreLabel") or ""),
              "agent 多时默认只露 3 个 + 「更多」",
              f"折叠 {val.get('collapsedChips')} 个 / 标签「{(val.get('moreLabel') or '').strip()}」")
        check((val.get("expandedChips") or 0) > (val.get("collapsedChips") or 0),
              "点「更多」展开全量",
              f"{val.get('collapsedChips')} → {val.get('expandedChips')}")
        check(val.get("expandedScrolls") is True, "展开后超高可滚动，不顶掉成果流")
        # 折叠态要「有上界」：agent 再多也不该把成果流挤没（看的是比例，不是绝对像素）
        check((val.get("rowHeight") or 0) <= 160, "折叠态占高有上界",
              f"{val.get('rowHeight')}px")
        check((val.get("cardsPerView") or 0) >= 4, "成果树仍能看到好几行",
              f"可视约 {val.get('cardsPerView')} 行（树高 {val.get('streamHeight')}px）")

        print("\n[3 左右边栏折叠]", flush=True)
        FOLD_SCRIPT = r"""
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const W = (s) => { const e = document.querySelector(s);
            return e ? Math.round(e.getBoundingClientRect().width) : null; };
          const snap = () => ({ side: W('.art-side'), anno: W('.art-anno'), main: W('.art-main') });
          const steps = [];
          const hit = (id) => { document.getElementById(id).click(); };
          hit('btnSideToggle'); await sleep(450); steps.push(Object.assign({ a: '收起左栏' }, snap()));
          hit('btnSideToggle'); await sleep(450); steps.push(Object.assign({ a: '展开左栏' }, snap()));
          hit('btnAnnoToggle'); await sleep(450); steps.push(Object.assign({ a: '收起右栏' }, snap()));
          hit('btnAnnoToggle'); await sleep(450); steps.push(Object.assign({ a: '展开右栏' }, snap()));
          hit('btnSideToggle'); hit('btnAnnoToggle'); await sleep(450);
          steps.push(Object.assign({ a: '两个都收起' }, snap()));
          /* 都收起时，会话下拉必须还在顶栏里、而且点得到 */
          const ss = document.getElementById('selSession');
          const b = ss.getBoundingClientRect();
          const onTop = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          const reachable = !!ss.closest('.art-topbar') && !!onTop && ss.contains(onTop);
          hit('btnSideToggle'); hit('btnAnnoToggle'); await sleep(450);
          return { steps: steps, reachable: reachable, restored: snap(),
                   stored: !!localStorage.getItem('pv.sidebars') };
        })()"""
        fres = asyncio.run(artifacts_cdp.run_script(
            f"{api}/artifacts.html", FOLD_SCRIPT,
            wait_js="document.querySelectorAll('.art-project').length > 0",
            screenshot_path=args.shot))
        fv = fres.get("value") or {}
        fsteps = {s.get("a"): s for s in (fv.get("steps") or [])}
        near0 = lambda v: v is not None and v <= 1
        check(near0(fsteps.get("收起左栏", {}).get("side")),
              "左栏能收起（列宽归零）", json.dumps(fsteps.get("收起左栏"), ensure_ascii=False))
        check(near0(fsteps.get("收起右栏", {}).get("anno")),
              "右栏能独立收起，不影响左栏",
              json.dumps(fsteps.get("收起右栏"), ensure_ascii=False))
        check(near0(fsteps.get("两个都收起", {}).get("side"))
              and near0(fsteps.get("两个都收起", {}).get("anno")),
              "左右栏能一起收起", json.dumps(fsteps.get("两个都收起"), ensure_ascii=False))
        check((fsteps.get("两个都收起", {}).get("main") or 0)
              > (fsteps.get("展开左栏", {}).get("main") or 0),
              "收起后舞台真的变宽了")
        check((fv.get("restored") or {}).get("side", 0) > 100
              and (fv.get("restored") or {}).get("anno", 0) > 100,
              "再点一次能还原回来", json.dumps(fv.get("restored"), ensure_ascii=False))
        check(fv.get("reachable") is True,
              "两栏都收起时，顶栏的会话下拉仍然点得到")
        check(fv.get("stored") is True, "折叠状态存进了 localStorage，刷新后还在")

        size = os.path.getsize(args.shot) if os.path.exists(args.shot) else 0
        check(size > 5000, "截图留证", f"{args.shot} {size}B")

        shutil.rmtree(src, ignore_errors=True)
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    print("\n" + "=" * 56, flush=True)
    print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败（共 {len(PASS) + len(FAIL)} 项）", flush=True)
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}", flush=True)
        sys.exit(1)
    print("全部通过 ✓", flush=True)


if __name__ == "__main__":
    # 必须把 main() 的返回值交给 SystemExit：护栏拒绝时 return 3，
    # 直接 main() 会把返回值丢掉、退出码恒为 0，回归脚本会以为这套「通过了」。
    raise SystemExit(main() or 0)
