#!/usr/bin/env python3
"""标注闭环验收：点选 / 框选 / 写说明 / 改说明 / 删除 / 提交。

    python3 scripts/verify_annotate.py [--api http://127.0.0.1:8899] [--shot /tmp/artifacts-anno.png]

之前标注一直点不动，根因是监听挂在了 bind() 时还不存在的 #overlay 上。
这个脚本走真实指针事件（pointerdown/move/up），所以只要还挂在不存在的节点上，
第 1 项就会挂 —— 不用看代码也知道坏没坏。
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import asyncio
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import artifacts_cdp  # noqa: E402
from verify_import import build_dir, req, start_server, up  # noqa: E402

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


# 真手势：CDP 的 Input.dispatchMouseEvent 会合成出 pointer 事件。
# 注意 mode 必须是 'pointer' 系事件能带起来的路径 —— 用 CDP 鼠标事件天然带 pointer。
UI_SCRIPT = r"""
(async () => {
 try {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};

  const stage = () => document.querySelector('.art-stage-inner');
  const rect = () => stage().getBoundingClientRect();

  /* 真指针序列：pointerdown → pointermove* → pointerup。
     用 elementFromPoint 定位落点，和人手点下去一样会命中覆盖层。 */
  async function gesture(x0, y0, x1, y1, steps = 6) {
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    });
    /* 每次事件都重新定位节点：舞台可能被异步重绘换掉，
       抓着旧引用发事件等于往一个已经不在文档里的节点上派发。 */
    const hit = () => document.elementFromPoint(x0, y0) || stage();
    hit().dispatchEvent(mk('pointerdown', x0, y0));
    for (let i = 1; i <= steps; i++) {
      window.dispatchEvent(mk('pointermove', x0 + (x1 - x0) * i / steps,
                              y0 + (y1 - y0) * i / steps));
      await sleep(10);
    }
    window.dispatchEvent(mk('pointerup', x1, y1));
  }

  /* 等成果选中、舞台出图 */
  for (let i = 0; i < 120; i++) {
    if (stage()) break;
    await sleep(150);
  }
  const b = rect();
  out.armed = $('#overlay') ? $('#overlay').classList.contains('armed') : false;
  out.modePointActive = !!document.querySelector('[data-note-mode="point"].active');

  /* ---------- 1 点选 ---------- */
  await gesture(b.left + b.width * 0.40, b.top + b.height * 0.40, b.left + b.width * 0.40, b.top + b.height * 0.40);
  await sleep(400);
  out.draftCards = $$('.art-note.draft').length;
  out.draftPins = $$('#overlay .art-pin.draft').length;
  out.composer = !!$('[data-ctext]');
  out.composerFocused = document.activeElement && document.activeElement.matches('[data-ctext]');
  out.count1 = $('#annoCount').textContent.trim();
  out.submitDisabledDraft = $('#btnSubmit').disabled;

  /* 空说明不该能提交 */
  const save = $('[data-save]');
  if (save) save.click();
  await sleep(300);
  out.stillDraft = $$('.art-note.draft').length;

  /* 写说明再保存 → 应该 POST 出去 */
  const ta = $('[data-ctext]');
  if (ta) {
    ta.value = '标题字号太大，和正文不在一个层级';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  out.hoverCaption = ($$('#overlay .art-pin.draft')[0] || {}).title || '';
  const save2 = $('[data-save]');
  if (save2) save2.click();
  for (let i = 0; i < 40 && $$('.art-note.draft').length; i++) await sleep(150);
  out.draftsAfterSave = $$('.art-note.draft').length;
  out.notes = $$('#overlay .art-pin').length;
  out.noteCards = $$('.art-note').length;
  out.bodies = $$('.art-note .n-body').map(x => x.textContent.trim());

  /* ---------- 2 框选 ---------- */
  const modeBox = document.querySelector('[data-note-mode="box"]');
  modeBox.click();
  await sleep(200);
  out.modeBoxActive = !!document.querySelector('[data-note-mode="box"].active');
  await gesture(b.left + b.width * 0.20, b.top + b.height * 0.60,
                b.left + b.width * 0.55, b.top + b.height * 0.80, 8);
  await sleep(400);
  out.boxDraft = $$('#overlay .art-box.draft').length;
  out.boxWidth = Math.round(($$('#overlay .art-box.draft')[0] || {getBoundingClientRect:()=>({width:0})})
                 .getBoundingClientRect().width);

  const ta2 = $('[data-ctext]');
  if (ta2) {
    ta2.value = '底部这一块留白不对，和上面不齐';
    ta2.dispatchEvent(new Event('input', { bubbles: true }));
    $('[data-save]').click();
  }
  for (let i = 0; i < 40 && $$('.art-note.draft').length; i++) await sleep(150);
  out.boxes = $$('#overlay .art-box').length;
  out.captionOnBox = !!$('#overlay .art-box .art-pin-body');
  out.count2 = $('#annoCount').textContent.trim();
  out.submitEnabled = !$('#btnSubmit').disabled;

  /* ---------- 3 改说明 ---------- */
  const ed = $('.art-note .n-body[data-edit]');
  if (ed) ed.click();
  await sleep(250);
  out.editingComposer = !!$('.art-note [data-ctext]');
  const NEW_BODY = '底部留白要和标题左边缘对齐';
  const ta3 = $('.art-note [data-ctext]');
  if (ta3) {
    ta3.value = NEW_BODY;
    ta3.dispatchEvent(new Event('input', { bubbles: true }));
    $('.art-note .n-compose [data-save]').click();
  }
  /* 改写要走一次 PATCH + 重载，正文是异步回来的，等它落定再读 */
  for (let i = 0; i < 40; i++) {
    const cur = $('.art-note .n-body');
    if (cur && cur.textContent.trim() === NEW_BODY) break;
    await sleep(150);
  }
  out.bodiesAfterEdit = $$('.art-note .n-body').map(x => x.textContent.trim());

  /* ---------- 4 删除（两步确认） ---------- */
  out.delExists = !!$('.art-note .n-del');
  out.notesBefore = $$('.art-note').length;
  const del1 = $('.art-note .n-del');
  if (del1) del1.click();
  await sleep(200);
  out.delArmedLabel = ($('.art-note .n-del') || {}).textContent || '';
  out.afterFirstClick = $$('.art-note').length;
  /* 列表随时可能整块重画，第二次必须重新取节点，不能点旧引用 */
  const del2 = $('.art-note .n-del');
  out.del2Armed = del2 ? del2.dataset.armed : 'missing';
  if (del2) del2.click();
  await sleep(600);
  out.toastAfterDelete = $$('.toast, .art-toast').map(t => t.textContent.trim()).join(' | ');
  out.idsAfterDelete = $$('.art-note').map(n => n.dataset.id).join(',');
  for (let i = 0; i < 40 && $$('.art-note').length >= out.notesBefore; i++) await sleep(150);
  out.notesAfter = $$('.art-note').length;
  out.marksAfter = $$('#overlay .art-pin, #overlay .art-box').length;

  /* ---------- 5 序号是否重排 ---------- */
  out.seqs = $$('.art-note .n-seq').map(x => x.textContent.trim());
  out.annoCount = $('#annoCount').textContent.trim();
  out.treeBadges = $$('.art-seq-mini').map(x => x.textContent.trim());

  return out;
 } catch (err) {
  return { FATAL: String(err && err.stack || err) };
 }
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
    ap.add_argument("--shot", default="/tmp/artifacts-anno.png")
    ap.add_argument("--force", action="store_true",
                    help="确实要写进这个数据目录（默认拒绝写正式库）")
    args = ap.parse_args()
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。护栏放在 parse_args 之后。
    try:
        assert_test_server(getattr(args, "api", None), getattr(args, "token", None) or os.environ.get("ARTIFACTS_TOKEN"), force=getattr(args, "force", False))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    api = args.api.rstrip("/")
    proc = start_server(api)
    tag = str(int(time.time()))
    src = os.path.join(ROOT, ".artifacts-data", f"anno-{tag}")
    os.makedirs(src, exist_ok=True)

    try:
        print("\n[1 造一份 page 成果]", flush=True)
        build_dir(src, tag)
        imp = req(api, "/api/artifacts/import", "POST", {"dir": src})
        check(imp["counts"]["imported"] >= 1, "导入成功", str(imp["counts"]))
        up(api)

        print("\n[2 浏览器里走一遍标注]", flush=True)
        res = asyncio.run(artifacts_cdp.run_script(
            f"{api}/artifacts.html", UI_SCRIPT,
            wait_js="!!document.querySelector('.art-stage-inner')",
            screenshot_path=args.shot))
        val = res.get("value") or {}
        print(json.dumps(val, ensure_ascii=False, indent=2), flush=True)
        print("del2Armed=%r toast=%r ids=%r" % (val.get("del2Armed"), val.get("toastAfterDelete"), val.get("idsAfterDelete")), flush=True)

        check(val.get("armed") is True, "标注工具默认在位（overlay 有 armed 态）")
        check(val.get("modePointActive") is True, "「点选」按钮默认高亮")

        check(val.get("draftCards") == 1 and val.get("draftPins") == 1,
              "点一下画面落下一个带序号的标记",
              f"cards={val.get('draftCards')} pins={val.get('draftPins')}")
        check(val.get("composer") is True and val.get("composerFocused") is True,
              "落点后自动展开说明框并聚焦")
        check(val.get("stillDraft") == 1, "空说明不落库")
        check("待写" in (val.get("count1") or ""), "计数提示有草稿未写", val.get("count1"))
        # 这条断言原来正好把 bug 当规范写死了：草稿一多就把提交按钮锁死，
        # 实测点下去 0 个网络请求，按钮看上去就是坏的。
        # 现在提交动作自己先落库（flushDrafts），所以有草稿也必须点得动。
        check(val.get("submitDisabledDraft") is False,
              "有草稿时「确认提交」仍可点（提交时自己先落库，不能锁死）")

        check(val.get("draftsAfterSave") == 0 and val.get("notes") == 1,
              "写完说明保存后成为正式标注", f"drafts={val.get('draftsAfterSave')} notes={val.get('notes')}")
        check(any("字号" in b for b in (val.get("bodies") or [])),
              "说明正文写进去了", str(val.get("bodies"))[:70])

        check(val.get("modeBoxActive") is True, "切到「框选」按钮高亮")
        check(val.get("boxDraft") == 1 and (val.get("boxWidth") or 0) > 40,
              "按住拖动框出一块区域", f"w={val.get('boxWidth')}")
        check(val.get("boxes") == 1, "框选说明保存后成为正式标注")
        check(val.get("captionOnBox") is True, "框上印着说明文字")

        check(val.get("editingComposer") is True, "点正文能就地改写")
        check(any("左边缘" in b for b in (val.get("bodiesAfterEdit") or [])),
              "改写后的说明生效", str(val.get("bodiesAfterEdit"))[:70])

        check(val.get("delExists") is True, "每条标注有删除按钮")
        check("确认" in (val.get("delArmedLabel") or ""), "删除是两步确认", val.get("delArmedLabel"))
        check(val.get("notesBefore") == 2, "删前有 2 条", str(val.get("notesBefore")))
        check(val.get("notesAfter") == 1 and val.get("marksAfter") == 1,
              "确认后标注和画面标记一起消失",
              f"cards={val.get('notesAfter')} marks={val.get('marksAfter')}")
        check(val.get("seqs") == ["1"], "删除后序号重排，不留空洞",
              str(val.get("seqs")))
        check(val.get("submitEnabled") is True, "没有草稿时提交可用")

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            pass

    print(f"\n通过 {len(PASS)}，失败 {len(FAIL)}")
    if FAIL:
        print("失败项：" + "; ".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
