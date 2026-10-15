#!/usr/bin/env python3
"""IM 推送：成果台事件 → 飞书/群机器人（任何接受 webhook 的 IM 都行）。

为什么不用 im_bot：交接文档 M4 写的是「复用 im_bot 飞书」，但这台机器上
找不到 im_bot（/vol3/1000/Work 全树扫过，0 命中），所以这里落成一个**通用 webhook
通知器**：飞书/Lark 自定义机器人原生吃 `{"msg_type":"text","content":{"text":...}}`，
配置一个 URL 就能收；将来 im_bot 回来了，只要把 `_post` 换成调它的 send() 即可。

三条硬规矩（都来自 M1「实时」那条教训）：
1. **推送永远不阻塞请求**：事件回调只入队，HTTP 发送在线程里做。
2. **推送失败不能影响成果台**：异常吞掉计数，发布照样成功。
3. **默认全关**：不配 `ARTIFACTS_NOTIFY_WEBHOOK` 就零行为，不打扰现有部署。

配置（都是环境变量）：
    ARTIFACTS_NOTIFY_WEBHOOK   飞书/Lark 自定义机器人 webhook（不配=关闭）
    ARTIFACTS_NOTIFY_SECRET    机器人「签名校验」密钥（可选）
    ARTIFACTS_NOTIFY_EVENTS    逗号分隔，默认 artifact.added,artifact.status,artifact.dispatched
    ARTIFACTS_NOTIFY_AGENTS    逗号分隔白名单，空=全推
    ARTIFACTS_NOTIFY_BASE_URL  消息里链接用的公网地址，默认 http://127.0.0.1:8799
                               （8899 是 scripts/serve_test.py 的联调端口，不是 console）
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_EVENTS = ("artifact.added", "artifact.status", "artifact.dispatched")

STATUS_TEXT = {
    "pending": "排队中", "ready": "就绪", "reviewing": "评审中",
    "approved": "已通过", "rework": "待返工", "rejected": "已否决",
}


class Notifier:
    """订阅成果台事件 → 排队 → 后台线程发 webhook。"""

    def __init__(self, events=None, agents=None, base_url="", name="im", store=None):
        self.name = name
        self.store = store          # 只用来按 id 补全标题/agent（后台线程里读，锁安全）
        self.webhook = (os.environ.get("ARTIFACTS_NOTIFY_WEBHOOK") or "").strip()
        self.secret = (os.environ.get("ARTIFACTS_NOTIFY_SECRET") or "").strip()
        raw_events = os.environ.get("ARTIFACTS_NOTIFY_EVENTS") or ",".join(events or DEFAULT_EVENTS)
        self.events = {e.strip() for e in raw_events.split(",") if e.strip()}
        raw_agents = os.environ.get("ARTIFACTS_NOTIFY_AGENTS") or ""
        self.agents = {a.strip() for a in raw_agents.split(",") if a.strip()} | \
                      {a.strip() for a in (agents or []) if a.strip()}
        self.base_url = (os.environ.get("ARTIFACTS_NOTIFY_BASE_URL") or base_url
                         or "http://127.0.0.1:8799").rstrip("/")
        self.sent = 0
        self.failed = 0
        self.dropped = 0
        self.last_error = ""
        self.last_sent_at = ""
        self.last_event = ""
        self._q: queue.Queue = queue.Queue(maxsize=200)
        self._worker = None
        self._stop = threading.Event()

    # ---------------------------------------------------------------- 开关
    @property
    def enabled(self) -> bool:
        return bool(self.webhook)

    def start(self):
        if not self.enabled or (self._worker and self._worker.is_alive()):
            return self
        self._stop.clear()
        self._worker = threading.Thread(target=self._run, name="artifacts-notify", daemon=True)
        self._worker.start()
        return self

    def stop(self):
        self._stop.set()
        if self._worker:
            self._worker.join(timeout=3)
            self._worker = None

    # ------------------------------------------------------------ 事件入口
    def on_event(self, event: str, payload: dict):
        """EventBus 监听器：只入队，绝不阻塞调用方。

        连格式化都放到后台线程：查库补标题是一次 sqlite 读，不能占着发布请求。
        """
        if not self.enabled or event not in self.events:
            return
        try:
            self._q.put_nowait({"event": event, "payload": payload})
        except queue.Full:
            self.dropped += 1                            # 队列满=推送慢，宁可丢通知

    # ---------------------------------------------------------------- 文案
    def _resolve(self, payload: dict) -> dict:
        """事件 payload 有的带 artifact（新增），有的只带 id（状态/派发），统一补全。"""
        art = payload.get("artifact")
        aid = (art or {}).get("id") or payload.get("artifact_id") or payload.get("id") or ""
        if not art and aid and self.store is not None:
            try:
                art = self.store.get(aid, with_annotations=False)
            except Exception:
                art = None
        return {"artifact": art or {}, "artifact_id": aid,
                "note": payload.get("note") or "", "to": payload.get("to") or ""}

    def _format(self, event: str, payload: dict) -> str:
        ctx = self._resolve(payload)
        art, aid = ctx["artifact"], ctx["artifact_id"]
        agent = art.get("agent") or "pilotdeck"
        if self.agents and agent not in self.agents:
            return ""
        title = (art.get("title") or "(无标题)").strip()
        kind = art.get("kind") or "成果"
        ver = art.get("version") or 1
        # 旧成果台页面已经没了，成果视图现在是 PilotV 应用内的状态、还没有深链接，
        # 这里只能给应用根地址，别再拼一个已经不存在的页面。
        url = self.base_url
        head = f"[成果台] {agent} · {kind} · v{ver}"
        if event == "artifact.added":
            body = f"新成果「{title}」"
            if art.get("parent_id"):
                body += f"（v{ver}，返工新版本）"
        elif event == "artifact.dispatched":
            body = f"「{title}」被打回返工" + (f"：{ctx['note']}" if ctx["note"] else "")
        elif event == "artifact.status":
            st = art.get("status") or ctx.get("to") or ""
            body = f"「{title}」→ {STATUS_TEXT.get(st, st)}"
            if ctx["note"]:
                body += f"（{ctx['note']}）"
        else:
            body = f"「{title}」{event}"
        return f"{head}\n{body}\n{url}"

    # ---------------------------------------------------------------- 发送
    def _run(self):
        while not self._stop.is_set():
            try:
                item = self._q.get(timeout=0.4)
            except queue.Empty:
                continue
            try:
                text = self._format(item["event"], item["payload"])
                if not text:                          # 被白名单过滤掉了
                    continue
                self._post(text)
                self.sent += 1
                self.last_sent_at = time.strftime("%Y-%m-%d %H:%M:%S")
                self.last_event = item["event"]
            except Exception as exc:
                self.failed += 1
                self._note_error(f"{type(exc).__name__}: {exc}")

    def _note_error(self, msg: str):
        self.last_error = msg[:200]

    def _sign(self, url: str, payload: dict) -> str:
        """飞书「签名校验」：把 timestamp 和 sign 挂到 query 上。"""
        if not self.secret:
            return url
        ts = str(int(time.time()))
        digest = hmac.new(self.secret.encode("utf-8"),
                          f"{ts}\n{self.secret}".encode("utf-8"),
                          hashlib.sha256).digest()
        sign = base64.b64encode(digest).decode("utf-8")
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}timestamp={ts}&sign={urllib.parse.quote(sign)}"

    def _post(self, text: str):
        payload = {"msg_type": "text", "content": {"text": text}}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self._sign(self.webhook, payload), data=body,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
        with urllib.request.urlopen(req, timeout=6) as resp:
            raw = resp.read().decode("utf-8", "replace")
        # 飞书即使 HTTP 200 也可能带业务错误码，不能只看状态码
        try:
            data = json.loads(raw or "{}")
        except ValueError:
            return
        if isinstance(data, dict):
            code = data.get("code", data.get("StatusCode", 0))
            if isinstance(code, int) and code != 0:
                raise RuntimeError(data.get("msg") or data.get("StatusMessage") or f"code={code}")

    def send_now(self, text: str) -> bool:
        """测试通道用：同步发一条，返回是否成功。"""
        try:
            self._post(text)
            self.sent += 1
            self.last_sent_at = time.strftime("%Y-%m-%d %H:%M:%S")
            return True
        except Exception as exc:
            self.failed += 1
            self._note_error(f"{type(exc).__name__}: {exc}")
            return False

    def status(self) -> dict:
        host = urllib.parse.urlsplit(self.webhook).netloc if self.webhook else ""
        return {"enabled": self.enabled, "target": host,
                "events": sorted(self.events), "agents": sorted(self.agents),
                "queued": self._q.qsize(), "sent": self.sent, "failed": self.failed,
                "dropped": self.dropped, "last_error": self.last_error,
                "last_sent_at": self.last_sent_at, "last_event": self.last_event,
                "worker_alive": bool(self._worker and self._worker.is_alive())}
