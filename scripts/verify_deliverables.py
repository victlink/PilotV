#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""需求 1-5 的 REST 层验收。

只起 REST 服务，不需要浏览器；真实浏览器手势在 verify_gestures.mjs 里验。

  python3 scripts/verify_deliverables.py --api http://127.0.0.1:8899

用 ARTIFACTS_API 指定时不自管服务（跟 verify_import 一个规矩，
别把回归套件共用的服务杀掉）。
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    return ok


def req(api, path, method="GET", body=None, raw=False):
    url = api + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as f:
            payload = f.read()
            return f.status, (payload if raw else json.loads(payload or b"{}"))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload or b"{}")
        except Exception:
            return e.code, {"error": payload.decode("utf-8", "replace")[:200]}


def section(t):
    print(f"\n[{t}]", flush=True)


GLB_MINIMAL = b"glTF\x02\x00\x00\x00" + b"\x20\x00\x00\x00" + b"\x00" * 24


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("ARTIFACTS_API", "http://127.0.0.1:8899"))
    ap.add_argument("--force", action="store_true",
                    help="确实要写进这个数据目录（默认拒绝写正式库）")
    a = ap.parse_args()
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。护栏放在 parse_args 之后。
    try:
        assert_test_server(getattr(a, "api", None), getattr(a, "token", None) or os.environ.get("ARTIFACTS_TOKEN"), force=getattr(a, "force", False))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    api = a.api.rstrip("/")
    src = tempfile.mkdtemp(prefix="verify-deliver-")
    home = os.path.expanduser("~")

    try:
        # ---------------------------------------------------------- 需求 1
        section("1 只收独立最终成果")
        page = os.path.join(src, "site", "index.html")
        os.makedirs(os.path.dirname(page), exist_ok=True)
        open(page, "w").write("<!doctype html><title>成品页</title><h1>成品</h1>")
        hero = os.path.join(src, "site", "assets", "hero.png")
        os.makedirs(os.path.dirname(hero), exist_ok=True)
        open(hero, "wb").write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        standalone = os.path.join(src, "renders", "final.png")
        os.makedirs(os.path.dirname(standalone), exist_ok=True)
        open(standalone, "wb").write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        thumb = os.path.join(src, "renders", "final-thumb.png")
        open(thumb, "wb").write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

        st, r = req(api, "/api/artifacts", "POST", {
            "kind": "page", "title": "成品页", "path": page, "agent": "verify-deliver"})
        check(st == 200, "独立页面照收", f"HTTP {st} {r.get('error', '')}")
        st, r = req(api, "/api/artifacts", "POST", {
            "kind": "image", "title": "页面元素图", "path": hero, "agent": "verify-deliver"})
        check(st == 409, "页面里的元素图被拦下", f"HTTP {st} {r.get('error', '')}")
        check("assets" in str(r.get("error", "")) or "从属" in str(r.get("reason", "")),
              "拦下的理由说清了为什么（从属资源）", str(r)[:140])
        st, r = req(api, "/api/artifacts", "POST", {
            "kind": "image", "title": "成片", "path": standalone, "agent": "verify-deliver"})
        check(st == 200, "独立图片照收", f"HTTP {st} {r.get('error', '')}")
        st, r = req(api, "/api/artifacts", "POST",
                    {"kind": "image", "title": "缩略图", "path": thumb, "agent": "verify-deliver"})
        check(st == 409, "缩略图被拦下", f"HTTP {st} {r.get('error', '')}")
        st, r = req(api, "/api/artifacts", "POST", {
            "kind": "image", "title": "显式收编的零件", "path": hero,
            "agent": "verify-deliver", "deliverable": "final"})
        check(st == 200, "发布方显式声明 final 可以放行（逃生舱）", f"HTTP {st} {r.get('error', '')}")

        # 品牌/标识类交付物曾经整批被误杀：文件名带 "icon" 的按网页小图标丢掉，
        # 落在 public/ 里的按从属资源丢掉，而 logo 定稿恰恰要拷进 ui/public/brand/
        # 才生效。整批丢失用户根本看不出来 —— 成果页只是「少了东西」。
        brand_dir = os.path.join(src, "ui", "public", "brand")
        os.makedirs(brand_dir, exist_ok=True)
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>'
        for name, label in [("animated-icon.svg", "brand/ 里的动画图标"),
                            ("lockup.svg", "brand/ 里的组合锁定"),
                            ("pilotv-mark.svg", "brand/ 里的标记图形")]:
            p = os.path.join(brand_dir, name)
            open(p, "w").write(svg)
            st, r = req(api, "/api/artifacts", "POST", {
                "kind": "drawing", "title": "logo 成果 " + name, "path": p,
                "agent": "verify-deliver"})
            check(st == 200, f"{label}不被误判成附属产物", f"HTTP {st} {r.get('error', '')}")
            check((r.get("artifact") or {}).get("kind") == "image",
                  f"{label}归到图片而不是图纸",
                  f"kind={(r.get('artifact') or {}).get('kind')}")

        # 反例：判定的本意不能被破坏 —— 真的中间产物、真的资源目录还得照拦。
        # 放在 brand/ 里也不行：brand-logo-preview.png 仍然是渲染过程中的中间帧。
        for name, token in [("brand-logo-preview.png", "中间产物"),
                            ("brand-logo-thumbnail.png", "中间产物")]:
            p = os.path.join(brand_dir, name)
            open(p, "wb").write(b"\x89PNG\r\n\x1a\n")
            st, r = req(api, "/api/artifacts", "POST", {
                "kind": "image", "title": "应该被拦 " + name, "path": p,
                "agent": "verify-deliver"})
            check(st == 409 and token in str(r.get("reason", "")),
                  f"brand 目录里的 {name} 仍按中间产物拦下",
                  f"HTTP {st} {str(r.get('reason', ''))[:60]}")
        # 「icon」退出词表后靠目录兜底：public/ 下的小图标仍是从属资源
        plain_dir = os.path.join(src, "ui", "public")
        for name in ("icon.svg", "icon-180.png"):
            p = os.path.join(plain_dir, name)
            open(p, "wb").write(svg.encode() if name.endswith(".svg") else b"\x89PNG\r\n\x1a\n")
            st, r = req(api, "/api/artifacts", "POST", {
                "kind": "image" if name.endswith(".png") else "drawing",
                "title": "应该被拦 " + name, "path": p, "agent": "verify-deliver"})
            check(st == 409 and "从属资源" in str(r.get("reason", "")),
                  f"public/ 里的 {name} 仍按从属资源拦下",
                  f"HTTP {st} {str(r.get('reason', ''))[:60]}")

        # ---------------------------------------------------------- 需求 2
        section("2 部件树：图纸/三维能拆成独立部件")
        mdir = os.path.join(src, "asm")
        os.makedirs(mdir, exist_ok=True)
        for n in ("body", "wing-l", "wing-r"):
            open(os.path.join(mdir, n + ".glb"), "wb").write(GLB_MINIMAL + n.encode())
        open(os.path.join(mdir, "plate.svg"), "w").write(
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">'
            '<rect width="40" height="40" fill="#39f"/></svg>')
        model = os.path.join(mdir, "asm.glb")
        open(model, "wb").write(GLB_MINIMAL + b"root")
        open(os.path.join(mdir, "asm.parts.json"), "w").write(json.dumps({
            "version": 1, "label": "装配体", "parts": [
                {"id": "body", "label": "机身", "path": "body.glb"},
                {"id": "wing", "label": "机翼组", "children": [
                    {"id": "wing-l", "label": "左翼", "path": "wing-l.glb"},
                    {"id": "wing-r", "label": "右翼", "path": "wing-r.glb"},
                ]},
                {"id": "plate", "label": "底板", "path": "plate.svg"},
                {"id": "gone", "label": "缺失件", "path": "not-here.glb"},
            ]}, ensure_ascii=False))
        st, r = req(api, "/api/artifacts", "POST",
                    {"kind": "model3d", "title": "装配体", "path": model, "agent": "verify-deliver"})
        check(st == 200, "带部件树的三维模型能发布", f"HTTP {st} {r.get('error', '')}")
        aid_m = r.get("id")
        st, r = req(api, f"/api/artifacts/{aid_m}/parts")
        parts = (r or {}).get("parts") or {}
        # 5 个叶子：body / wing-l / wing-r / plate / gone（gone 是清单里写了
        # 但文件没进来的占位，也必须出现在树上，否则评审看不出「少了个件」）
        check(st == 200 and parts.get("count") == 5, "部件树读得回来（5 个叶子）",
              json.dumps(parts.get("tree"), ensure_ascii=False)[:160])
        ids = []

        def walk(nodes):
            for n in nodes or []:
                if n.get("children"):
                    walk(n["children"])
                else:
                    ids.append(n["id"])
        walk(parts.get("tree"))
        check(ids == ["body", "wing-l", "wing-r", "plate", "gone"],
              f"叶子顺序与清单一致：{ids}")
        wing = []

        def find(nodes):
            for n in nodes or []:
                if n["id"] == "wing-l":
                    wing.append(n)
                find(n.get("children"))
        find(parts.get("tree"))
        check(bool(wing) and wing[0].get("depth") == 1, "子部件带层级深度",
              json.dumps(wing[0], ensure_ascii=False)[:120] if wing else "没找到")
        check(bool(wing) and wing[0].get("url", "").startswith(f"/api/artifacts/{aid_m}/files/"),
              "子部件有自己的可访问 URL", (wing[0].get("url") if wing else ""))
        u = (wing[0].get("url") if wing else "") or "/"
        st, blob = req(api, u, raw=True)
        check(st == 200 and isinstance(blob, bytes) and len(blob) > 0,
              "按 URL 能取到部件文件本体", f"HTTP {st} {len(blob) if isinstance(blob, bytes) else '?'}B")
        flat = []

        def flat_walk(nodes):
            for n in nodes or []:
                if n.get("children"):
                    flat_walk(n["children"])
                else:
                    flat.append(n)
        flat_walk(parts.get("tree"))
        miss = [n for n in flat if n["id"] == "gone"]
        check(bool(miss) and miss[0].get("missing") is True,
              "清单里写了但文件没进来的部件标成 missing", json.dumps(miss[0], ensure_ascii=False)[:100])
        st, _ = req(api, f"/api/artifacts/{aid_m}/files/../../../artifacts_store.py")
        check(st == 404, "部件 URL 不给穿越目录", f"HTTP {st}")

        # ---------------------------------------------------------- 需求 4
        section("4 文字成果可直接改，保存即生效")
        doc = os.path.join(src, "readme.md")
        open(doc, "w", encoding="utf-8").write("# 标题\n\n第一段。\n")
        st, r = req(api, "/api/artifacts", "POST",
                    {"kind": "doc", "title": "说明文档", "path": doc, "agent": "verify-deliver"})
        check(st == 200, "md 能发布", f"HTTP {st} {r.get('error', '')}")
        aid_d = r.get("id")
        st, r = req(api, f"/api/artifacts/{aid_d}/text")
        check(st == 200 and "# 标题" in r.get("text", ""), "能读回原文", str(r)[:120])
        st, r = req(api, f"/api/artifacts/{aid_d}/text", "PUT",
                    {"text": "# 改过的标题\n\n第二段。\n"})
        check(st == 200 and r.get("changed", {}).get("edited") is True,
              "保存成功并报告了相对发布时的差异", json.dumps(r.get("changed", {}), ensure_ascii=False))
        st, r = req(api, f"/api/artifacts/{aid_d}/text")
        check(r.get("text") == "# 改过的标题\n\n第二段。\n", "成果台副本确实变了")
        st, raw = req(api, f"/api/artifacts/{aid_d}/raw", raw=True)
        check(b"\xe6\x94\xb9\xe8\xbf\x87\xe7\x9a\x84" in (raw or b""), "raw 也是改后的内容")
        check(open(doc, encoding="utf-8").read() == "# 标题\n\n第一段。\n",
              "原项目文件没被动过（只改副本）")
        st, r = req(api, f"/api/artifacts/{aid_m}/text")
        check(st in (400, 409, 415), "三维模型这类不可编辑的成果不给写文本", f"HTTP {st}")
        st, r = req(api, f"/api/artifacts/{aid_d}/text", "PUT", {"text": ""})
        check(st == 400, "空文本被拒", f"HTTP {st}")

        # ---------------------------------------------------------- 需求 3 + 5
        section("3/5 标注 → 应用：落原项目目录、归会话、唤醒")
        st, r = req(api, f"/api/artifacts/{aid_d}/annotations", "POST", {
            "surface": "doc", "severity": "major", "body": "第二段要展开成三段",
            "anchor": {"rect": {"x": 0.2, "y": 0.4, "w": 0.3, "h": 0.1},
                       "text": "第二段", "part": ""}})
        check(st in (200, 201), "标注能加上（含文字锚点）", f"HTTP {st} {r.get('error', '')}")
        nid = (r.get("annotation") or {}).get("id") or r.get("id")
        check(bool(nid), "创建后拿到了标注 id", str(r)[:120])
        st, r = req(api, f"/api/artifacts/{aid_m}/annotations", "POST", {
            "surface": "model3d", "severity": "major", "body": "左翼加倒角",
            "anchor": {"rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, "part": "wing-l"}})
        check(st in (200, 201), "部件上的标注能加上", f"HTTP {st} {r.get('error', '')}")
        st, r = req(api, f"/api/artifacts/{aid_m}/parts")
        check(st == 200, "部件树在加标注后仍可读")

        st, r = req(api, f"/api/artifacts/{aid_d}/apply", "POST", {})
        check(st == 200, "apply 跑通了", f"HTTP {st} {r.get('error', '')}")
        ch = r.get("channels") or {}
        check(set(ch) >= {"project_dir", "session_queue", "agent_wake"},
              "三条通道都有明确结论", json.dumps(ch, ensure_ascii=False)[:220])
        for k in ("project_dir", "session_queue", "agent_wake"):
            check(isinstance(ch.get(k), dict) and "ok" in ch[k],
                  f"通道 {k} 报了成败而不是含糊带过", json.dumps(ch.get(k), ensure_ascii=False)[:120])
        check(r.get("notes") == 1, "送出去的意见条数对得上", str(r.get("notes")))
        check(r.get("text_changed") is True, "手工改动被一并带上了")
        pdir = (ch.get("project_dir") or {}).get("path", "")
        if (ch.get("project_dir") or {}).get("ok"):
            check(os.path.isfile(pdir), "返工单真落在磁盘上", pdir)
            body = open(pdir, encoding="utf-8").read()
            check("第二段要展开成三段" in body, "返工单里带着原始意见原文")
            check(pdir.startswith(home) or "verify" in pdir, "返工单落在原项目目录下", pdir)
        # 空跑防护要拿「一条标注都没有」的成果验：刚应用过的那份意见还没被
        # agent 解决，再点一次本来就应该再送一遍，这不是 bug。
        st, r = req(api, "/api/artifacts", "POST", {
            "kind": "doc", "title": "没有意见的文档", "path": doc, "agent": "verify-deliver"})
        aid_empty = r.get("id")
        st, r = req(api, f"/api/artifacts/{aid_empty}/apply", "POST", {})
        check(st == 409, "没有待处理意见时不空跑", f"HTTP {st} {r.get('error','')}")

        st, r = req(api, f"/api/artifacts/{aid_d}/annotations/{nid}", "PATCH", {"status": "resolved"})
        check(st == 200, "标注能改成已解决（长按菜单里的动作）", f"HTTP {st} {r.get('error','')}")
        st, r = req(api, f"/api/artifacts/{aid_d}/annotations/{nid}", "DELETE")
        check(st == 200, "标注能删（长按菜单里的动作）", f"HTTP {st} {r.get('error','')}")
        # ------------------------------------------------ 需求 5 的正路（真项目）
        # ------------------------------------------------ 部件清单不许越权读文件
        section("5c 部件清单不许越权读文件")
        secret = os.path.join(src, "secret.txt")
        with open(secret, "w") as fh:
            fh.write("TOP SECRET")
        bad_dir = os.path.join(src, "bad-parts")
        os.makedirs(bad_dir, exist_ok=True)
        with open(os.path.join(bad_dir, "ok.glb"), "wb") as fh:
            fh.write(b"glTF\x02\x00\x00\x00")
        with open(os.path.join(bad_dir, "x.parts.json"), "w") as fh:
            json.dump({"version": 1, "parts": [
                {"id": "esc", "label": "相对越权", "path": "../secret.txt"},
                {"id": "abs", "label": "绝对越权", "path": secret},
                {"id": "ok", "label": "正常部件", "path": "ok.glb"},
            ]}, fh, ensure_ascii=False)
        main_glb = os.path.join(bad_dir, "x.glb")
        with open(main_glb, "wb") as fh:
            fh.write(b"glTF\x02\x00\x00\x00")
        st, r = req(api, "/api/artifacts", "POST", {
            "kind": "model3d", "title": "越权清单", "path": main_glb, "agent": "verify-deliver"})
        check(st == 200, "带越权清单的成果也能发布（清单本身不拦，拦的是取文件）", f"HTTP {st} {r.get('error','')}")
        st, pl = req(api, f"/api/artifacts/{r['id']}/parts", "GET")
        check(st == 200, "能读回部件树", f"HTTP {st}")
        by_id = {p["id"]: p for p in (pl.get("parts") or {}).get("tree", [])}
        check(bool(by_id.get("esc", {}).get("missing")), "相对路径越权的部件被挡住（没拷进来）",
              json.dumps(by_id.get("esc"), ensure_ascii=False))
        check(bool(by_id.get("abs", {}).get("missing")), "绝对路径指到目录外的部件被挡住",
              json.dumps(by_id.get("abs"), ensure_ascii=False))
        check(not by_id.get("ok", {}).get("missing"), "同目录下的正常部件照常收进来",
              json.dumps(by_id.get("ok"), ensure_ascii=False))
        st, body = req(api, f"/api/artifacts/{r['id']}/files/{by_id.get('esc', {}).get('stored_name') or 'secret.txt'}", "GET")
        check("TOP SECRET" not in json.dumps(body, ensure_ascii=False),
              "成果台里拿不到越权的文件内容")

        section("5b 成果归属到真项目/会话时的三条通道")
        # 用一个假 PilotDeck 家目录跑：项目 .cwd + chats/<sid>.jsonl，
        # 跟 pilotdeck_workspace.scan_projects 读的布局一致。
        # 必须落在服务真正读的那个家目录里，否则是在自己搭的假目录里自说自话
        fake_home = os.environ.get("PILOTDECK_HOME") or ""
        check(bool(fake_home), "PILOTDECK_HOME 有指向隔离家目录（不碰真数据）", fake_home)
        proj_dir = os.path.join(src, "artwork-project")
        os.makedirs(proj_dir, exist_ok=True)
        pid = "fake-proj"
        pstore = os.path.join(fake_home, "projects", pid)
        os.makedirs(os.path.join(pstore, "chats"), exist_ok=True)
        open(os.path.join(pstore, ".cwd"), "w").write(proj_dir)
        # 会话 id 就是去掉 .jsonl 后的文件名（含 `cli:` 前缀），和 PilotDeck 一致
        sid = "cli:fake-sess-1"
        chat = os.path.join(pstore, "chats", f"{sid}.jsonl")
        with open(chat, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "user", "text": "做一张图"}) + "\n")

        doc2 = os.path.join(proj_dir, "cover.md")
        open(doc2, "w", encoding="utf-8").write("# 封面\n\n初稿。\n")
        st, r = req(api, "/api/artifacts", "POST", {
            "kind": "doc", "title": "封面稿", "path": doc2,
            "agent": "verify-deliver", "project": pid, "run_id": sid})
        check(st == 200, "能发布带项目/会话归属的成果", f"HTTP {st} {r.get('error','')}")
        aid_p = r.get("id")
        req(api, f"/api/artifacts/{aid_p}/annotations", "POST", {
            "surface": "doc", "severity": "minor", "body": "首行字号调大",
            "anchor": {"rect": {"x": 0.1, "y": 0.1, "w": 0.4, "h": 0.05}, "part": ""}})
        st, r = req(api, f"/api/artifacts/{aid_p}/apply", "POST", {})
        check(st == 200, "apply 跑通（真项目）", f"HTTP {st} {r.get('error','')}")
        ch = r.get("channels") or {}
        check((ch.get("project_dir") or {}).get("ok") is True,
              "通道 project_dir 真的通了", json.dumps(ch.get("project_dir", {}), ensure_ascii=False)[:160])
        order_path = (ch.get("project_dir") or {}).get("path", "")
        check(os.path.isfile(order_path)
              and os.path.realpath(order_path).startswith(os.path.realpath(proj_dir)),
              "返工单落在原项目目录里面（不是成果台数据目录）", order_path)
        check((ch.get("project_dir") or {}).get("session_id") == sid,
              "返工单按会话分了文件夹", json.dumps(ch.get("project_dir", {}), ensure_ascii=False)[:160])
        check((ch.get("session_queue") or {}).get("ok") is True,
              "通道 session_queue 真的通了", json.dumps(ch.get("session_queue", {}), ensure_ascii=False)[:200])
        check(r.get("exact_session") is True, "是按成果所属的那次会话投递的，不是随便挑一个")
        qdir = os.path.join(fake_home, "projects", pid, "pending-inputs")
        check(os.path.isdir(qdir), "会话输入队列目录被建出来了", qdir)
        qf = os.path.join(qdir, f"{sid}.json")
        check(os.path.isfile(qf), "队列文件落在该会话名下", qf)
        if os.path.isfile(qf):
            q = json.load(open(qf, encoding="utf-8"))
            items = q.get("items") or []
            check(len(items) >= 1 and "首行字号调大" in json.dumps(items, ensure_ascii=False),
                  "返工意见真进了会话队列", json.dumps(items, ensure_ascii=False)[:160])
            check(all(i.get("status") != "running" for i in items),
                  "队列里没有把条目误标成 running（那会让 agent 以为已被认领）")
        check((ch.get("agent_wake") or {}).get("ok") is True,
              "通道 agent_wake 报了结论", json.dumps(ch.get("agent_wake", {}), ensure_ascii=False)[:160])
    finally:
        shutil.rmtree(src, ignore_errors=True)

    print("\n" + "=" * 60)
    print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败（共 {len(PASS) + len(FAIL)} 项）")
    if FAIL:
        print("失败项：\n  - " + "\n  - ".join(FAIL))
    print("=" * 60)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
