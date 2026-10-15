#!/usr/bin/env python3
"""闭环验证（交接文档 §10 步骤 3 的零成本版本：纯 REST + SSE，不依赖 MCP）。

    python3 scripts/verify_loop.py [--base http://127.0.0.1:8799] [--keep]

依次验证：
  1. 登记成果（page/image/video/doc/model3d 五类）→ 缩略图物化 → ready
  2. SSE 实时流确实收到事件
  3. 框选标注（rect）+ 页面 selector 锚点
  4. GET /feedback 拿到返工清单（agent 侧入口）
  5. 提交返工 dispatch → status=rework
  6. agent 改完发新版本（parent_id）→ 未解决标注自动继承、carried_from 记来源
  7. 解决其中一条 → 版本链 diff 正确
  8. 审计流水完整

退出码 0 = 全绿。失败会打印实际值与期望值，便于定位。
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

import aiohttp

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEMO = os.path.join(ROOT, "demo")

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
_fails = 0


def check(label, ok, detail=""):
    global _fails
    print(f"  [{PASS if ok else FAIL}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        _fails += 1
    return ok


class Api:
    def __init__(self, base, token=None):
        self.base = base.rstrip("/")
        self.token = token
        self.s = aiohttp.ClientSession()

    def _h(self):
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def post(self, path, payload):
        async with self.s.post(self.base + path, json=payload, headers=self._h()) as r:
            return r.status, await r.json()

    async def get(self, path):
        async with self.s.get(self.base + path, headers=self._h()) as r:
            return r.status, await r.json()

    async def patch(self, path, payload):
        async with self.s.patch(self.base + path, json=payload, headers=self._h()) as r:
            return r.status, await r.json()

    async def raw_head(self, path):
        async with self.s.get(self.base + path, headers=self._h()) as r:
            return r.status, r.headers.get("Content-Type", ""), len(await r.read())

    async def close(self):
        await self.s.close()


async def wait_ready(api, aid, timeout=25):
    """等物化完成（骨架卡 → ready）。这是「实时」体感的关键指标，量出来。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        _, art = await api.get(f"/api/artifacts/{aid}")
        if art.get("status") == "ready":
            return time.time() - t0, art
        await asyncio.sleep(0.4)
    return time.time() - t0, art


class Sse:
    """后台 SSE 监听，把收到的事件攒起来。"""

    def __init__(self, base, token=None):
        self.base = base
        self.token = token
        self.events = []
        self.task = None
        self.ready = asyncio.Event()

    async def _run(self):
        headers = {"Accept": "text/event-stream"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        async with aiohttp.ClientSession() as sess:
            async with sess.get(self.base + "/api/artifacts/events", headers=headers) as r:
                self.ready.set()
                ev, data = None, []
                async for raw in r.content:
                    line = raw.decode("utf-8").rstrip("\n")
                    if not line:
                        if ev:
                            try:
                                self.events.append((ev, json.loads("\n".join(data))))
                            except Exception:
                                pass
                            ev, data = None, []
                        continue
                    if line.startswith("event:"):
                        ev = line[6:].strip()
                    elif line.startswith("data:"):
                        data.append(line[5:].strip())
                    elif line.startswith(":"):
                        self.ready.set()

    def start(self):
        self.task = asyncio.create_task(self._run())
        return self

    async def stop(self):
        self.task.cancel()
        try:
            await self.task
        except (asyncio.CancelledError, Exception):
            pass


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("ARTIFACTS_BASE", "http://127.0.0.1:8799"))
    ap.add_argument("--token", default=os.environ.get("ARTIFACTS_TOKEN"))
    ap.add_argument("--keep", action="store_true", help="保留验证产生的成果（默认也保留，仅用于跳过清理）")
    ap.add_argument("--force", action="store_true",
                    help="确实要写进这个数据目录（默认拒绝写正式库）")
    args = ap.parse_args()
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。护栏放在 parse_args 之后。
    try:
        assert_test_server(getattr(args, "base", None), getattr(args, "token", None) or os.environ.get("ARTIFACTS_TOKEN"), force=getattr(args, "force", False))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    api = Api(args.base, args.token)
    sse = Sse(args.base, args.token).start()

    try:
        print(f"目标: {args.base}")
        print("\n[0] 健康检查")
        st, health = await api.get("/api/artifacts/health")
        check("GET /api/artifacts/health = 200", st == 200, f"status={st}")
        if st != 200:
            print("服务未就绪，退出"); return 1

        await asyncio.sleep(0.8)   # 给 SSE 建链一点时间

        print("\n[1] 登记成果（五类）")
        cases = [
            ("page",   "闭环演示落地页", "demo/landing.html", "#hero"),
            ("image",  "周活跃趋势图",   "demo/chart.png",   None),
            ("video",  "成果台宣传片",   "demo/clip.mp4",    None),
            ("doc",    "评审纪要",       "demo/spec.pdf",    None),
            ("model3d","齿轮模型",       "demo/widget.glb",  None),
        ]
        ids = {}
        for kind, title, rel, sel in cases:
            st, out = await api.post("/api/artifacts", {
                "kind": kind, "title": title, "path": rel,
                "project_root": ROOT, "agent": "pilotdeck", "sub": "M1 闭环验证",
                "html_url": "file://" + os.path.join(ROOT, rel) if kind == "page" else "",
                "tool": "verify_loop",
            })
            ok = st == 200 and out.get("id", "").startswith("art_")
            check(f"POST {kind} ({title})", ok, out.get("id") or out)
            if ok:
                ids[kind] = out["id"]
                check(f"  review_url 指向成果台", out.get("review_url", "").endswith(out["id"]),
                      out.get("review_url", ""))

        print("\n[2] 缩略图物化（pending → ready）")
        for kind, aid in ids.items():
            dt, art = await wait_ready(api, aid)
            check(f"{kind} 物化完成 {art.get('status')}（{dt:.1f}s）",
                  art.get("status") == "ready", f"thumb={art.get('entry', {}).get('thumb_url')}")
            st2, ctype, size = await api.raw_head(f"/api/artifacts/{aid}/thumb")
            check(f"{kind} 缩略图可取", st2 == 200 and size > 200, f"{st2} {size}B {ctype}")

        print("\n[3] SSE 实时流")
        await asyncio.sleep(0.5)
        names = [e for e, _ in sse.events]
        for want in ("artifact.added", "artifact.ready"):
            check(f"收到事件 {want}", want in names, f"共 {len(names)} 条")

        page_id, image_id = ids["page"], ids["image"]

        print("\n[4] 框选标注 + selector 锚点")
        st, out = await api.post(f"/api/artifacts/{page_id}/annotations", {
            "severity": "major", "body": "标题字号偏小，主视觉要更大胆",
            "surface": "page", "selector": "#title",
            "rect": {"x": 0.06, "y": 0.10, "w": 0.30, "h": 0.06},
            "author": "reviewer",
        })
        check("页面标注创建", st == 201 and out["annotation"]["seq"] == 1, out.get("error", ""))
        n1 = out.get("annotation", {})
        st, out = await api.post(f"/api/artifacts/{image_id}/annotations", {
            "severity": "blocker", "body": "第三根柱子颜色与前两根不一致",
            "surface": "image", "rect": {"x": 0.42, "y": 0.35, "w": 0.12, "h": 0.40},
        })
        check("图片标注创建", st == 201, out.get("error", ""))
        n2 = out.get("annotation", {})
        st, out = await api.post(f"/api/artifacts/{image_id}/annotations", {
            "severity": "minor", "body": "右下角说明文字太小",
            "surface": "image", "rect": {"x": 0.05, "y": 0.88, "w": 0.35, "h": 0.05},
        })
        check("第二条图片标注创建", st == 201, out.get("error", ""))
        n3 = out.get("annotation", {})
        check("rect 已归一化到 0-1", all(0 <= n2.get("rect", {}).get(k, 9) <= 1
                                   for k in ("x", "y", "w", "h")), json.dumps(n2.get("rect")))

        st, out = await api.post(f"/api/artifacts/{page_id}/annotations", {"body": ""})
        check("空标注被拒", st == 400, f"status={st}")

        print("\n[5] agent 侧入口：GET /feedback")
        st, fb = await api.get(f"/api/artifacts/{image_id}/feedback?status=open")
        check("feedback 返回 2 条未解决", st == 200 and fb["count"] == 2, f"count={fb.get('count')}")
        check("feedback 带 seq 便于 agent 对号入座",
              [n["seq"] for n in fb.get("annotations", [])] == [1, 2],
              str([n["seq"] for n in fb.get("annotations", [])]))

        print("\n[6] 提交返工 dispatch")
        st, out = await api.post(f"/api/artifacts/{image_id}/dispatch",
                                 {"actor": "reviewer", "note": "颜色与字号两处"})
        check("dispatch 成功", st == 200 and out["artifact"]["status"] == "rework",
              out.get("artifact", {}).get("status"))
        check("dispatch 返回返工清单", len(out.get("feedback", [])) == 2)

        print("\n[7] 新版本继承标注（闭环最关键的一步）")
        v2_path = os.path.join(DEMO, "chart.png")
        st, out = await api.post("/api/artifacts", {
            "kind": "image", "title": "周活跃趋势图", "path": v2_path,
            "project_root": ROOT, "parent_id": image_id, "agent": "pilotdeck",
            "sub": "已按意见改色与字号", "tool": "verify_loop",
        })
        v2 = out.get("id", "")
        check("新版本创建", st == 200 and out.get("version") == 2, out.get("error", ""))
        st, art2 = await api.get(f"/api/artifacts/{v2}")
        anns = art2.get("annotations", [])
        check("2 条标注自动继承", len(anns) == 2, f"实际 {len(anns)}")
        check("继承标注记 carried_from",
              all(a.get("carried_from") for a in anns),
              str([a.get("carried_from") for a in anns]))
        check("继承后仍是 open", all(a["status"] == "open" for a in anns))
        dt, _ = await wait_ready(api, v2)
        check(f"新版本缩略图就绪（{dt:.1f}s）", True)

        print("\n[8] 解决一条 + 版本链 diff")
        st, out = await api.patch(f"/api/artifacts/{v2}/annotations/{anns[0]['id']}",
                                 {"status": "resolved", "author": "reviewer"})
        check("标注置为已解决", st == 200 and out["annotation"]["status"] == "resolved",
              out.get("error", ""))
        st, chain = await api.get(f"/api/artifacts/{v2}/chain")
        check("版本链含 2 个版本", st == 200 and len(chain["chain"]) == 2,
              str([c["version"] for c in chain.get("chain", [])]))
        diff = (chain.get("diff") or [{}])[0]
        check("diff 记录 1 条已解决", len(diff.get("resolved", [])) == 1,
              json.dumps(diff.get("resolved", []), ensure_ascii=False))
        check("diff 记录仍有 1 条 open", diff.get("still_open") == 1, str(diff.get("still_open")))

        print("\n[9] 状态机 + 审计")
        st, out = await api.post(f"/api/artifacts/{v2}/status", {"status": "approved", "actor": "reviewer"})
        check("批准通过", st == 200 and out["status"] == "approved", out.get("error", ""))
        st, out = await api.post(f"/api/artifacts/{v2}/status", {"status": "weird"})
        check("非法 status 被拒", st in (400, 409), f"status={st}")
        st, aud = await api.get(f"/api/artifacts/{v2}/audit")
        evs = [e["event"] for e in aud.get("audit", [])]
        check("审计记录创建与状态流转",
              "artifact.created" in evs and "artifact.status" in evs, str(evs))

        print("\n[10] 列表与筛选")
        st, out = await api.get("/api/artifacts?kind=image&limit=50")
        check("按 kind 筛选生效", st == 200 and all(a["kind"] == "image" for a in out["artifacts"]))
        check("列表带 stats", "stats" in out and out["stats"]["total"] >= len(ids))

        await asyncio.sleep(0.4)
        print("\n[SSE] 事件序列")
        print("      " + " → ".join(n for n in names))

        print("\n" + "=" * 56)
        print(f"结果：{'全部通过 ✓' if _fails == 0 else f'{_fails} 项失败 ✗'}")
        print(f"成果页：{args.base}/")
        print("=" * 56)
        return 1 if _fails else 0
    finally:
        await sse.stop()
        await api.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
