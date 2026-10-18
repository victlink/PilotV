"""成果台 · 存储层。

交接文档 §5 / §5.1 的落地：schema、版本链、标注、审计、事件总线。
纯 SQLite + asyncio，不依赖 aiohttp —— 路由层（artifacts_console.py）只做翻译。

核心不变量
  1. parent_id + version 组成版本链：新版本自动继承父版本 status=open 的标注，
     并在 carried_from 记来源。标注因此「跨版本存活」，闭环不会在改版时断掉。
  2. 标注锚点双存：anchor.selector（页面 DOM，可重新定位）+ anchor.rect（归一化 0-1 兜底）。
  3. 每次写操作都落 audit 表，评审动作可追溯（M3）。
  4. 事件总线：内存 ring buffer + 每订阅者 asyncio.Queue，支持 Last-Event-ID 重放。
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------- 常量

CST = timezone(timedelta(hours=8))

KINDS = ("page", "image", "video", "drawing", "model3d", "doc")
STATUSES = ("pending", "ready", "reviewing", "approved", "rework", "rejected")
SEVERITIES = ("blocker", "major", "minor")
SURFACES = ("image", "page", "model")

# M3 状态机：允许的流转。首版刻意宽松（评审中仍可直接驳回），
# 但非法流转会返回 409 而不是静默改状态 —— 状态被谁改的必须说得清。
ALLOWED_TRANSITIONS = {
    "pending": {"ready", "rejected"},
    "ready": {"reviewing", "approved", "rework", "rejected", "pending"},
    "reviewing": {"approved", "rework", "rejected", "ready"},
    "rework": {"ready", "reviewing", "rejected"},
    "approved": {"rework", "reviewing", "ready"},
    "rejected": {"ready", "reviewing", "rework"},
}

RING_SIZE = 500


def now_iso() -> str:
    return datetime.now(CST).isoformat(timespec="seconds")


def _jload(text, default=None):
    if not text:
        return default
    try:
        return json.loads(text)
    except Exception:
        return default


def _jdump(obj) -> str:
    return json.dumps(obj or {}, ensure_ascii=False)


def new_artifact_id() -> str:
    return "art_" + "".join(random.choice("0123456789abcdef") for _ in range(6))


# --------------------------------------------------------------------- 事件总线


class EventBus:
    """极简 fan-in 事件总线：环形缓冲 + 每订阅者队列。

    为什么不用 aiohttp 的广播中间件：SSE 只在 console 进程内扇出，
    一个 asyncio.Queue per client 就够，且要支持 Last-Event-ID 重放。
    """

    def __init__(self, ring_size: int = RING_SIZE):
        self._ring: list[tuple[int, str, dict]] = []
        self._subs: set[asyncio.Queue] = set()
        self._seq = 0
        self._ring_size = ring_size
        self._lock = threading.Lock()
        self._listeners: list = []          # 同步回调（IM 推送这类），只允许不阻塞

    def add_listener(self, fn) -> None:
        """注册同步监听器。约定：fn 必须快速返回，异常会被吞掉。

        为什么不用 SSE 队列扇出：监听器是别的线程（IM 推送），不是 SSE 客户端。
        """
        if fn not in self._listeners:
            self._listeners.append(fn)

    def publish(self, event: str, data: dict) -> int:
        with self._lock:
            self._seq += 1
            eid = self._seq
            payload = dict(data or {})
            payload.setdefault("ts", now_iso())
            self._ring.append((eid, event, payload))
            if len(self._ring) > self._ring_size:
                del self._ring[: len(self._ring) - self._ring_size]
            queues = list(self._subs)
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(event, payload)
            except Exception:                     # 监听器炸了不能连累成果台
                pass
        for q in queues:
            try:
                q.put_nowait((eid, event, payload))
            except asyncio.QueueFull:
                # 慢客户端丢事件而不是拖垮总线；它重连时会带 Last-Event-ID 补齐
                pass
        return eid

    def subscribe(self, last_id: int = 0):
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        with self._lock:
            replay = [item for item in self._ring if item[0] > last_id]
            self._subs.add(q)
        for item in replay:  # 断线重连补发
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                break
        return q

    def unsubscribe(self, q: asyncio.Queue):
        with self._lock:
            self._subs.discard(q)

    @property
    def last_id(self) -> int:
        with self._lock:
            return self._seq

    def stats(self) -> dict:
        with self._lock:
            return {"subscribers": len(self._subs), "seq": self._seq,
                    "ring": len(self._ring)}


# --------------------------------------------------------------------- 存储


class ArtifactStore:
    def __init__(self, data_dir: str):
        self.data_dir = os.path.abspath(data_dir)
        self.files_dir = os.path.join(self.data_dir, "files")
        self.thumbs_dir = os.path.join(self.data_dir, "thumbs")
        os.makedirs(self.files_dir, exist_ok=True)
        os.makedirs(self.thumbs_dir, exist_ok=True)
        self.db_path = os.path.join(self.data_dir, "artifacts.db")
        self._db = sqlite3.connect(self.db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        # 必须是 RLock，不能是 Lock：
        # get() / annotations() / _audit() 都自己加锁，而写方法在 with self._lock 里
        # 直接调它们（delete_annotation 一进来就读 annotations()）。
        # 换成普通 Lock 就是自己等自己 —— 删标注会永久卡死，HTTP 请求永远不返回。
        self._lock = threading.RLock()
        self.bus = EventBus()
        self._init_schema()

    # -------------------------------------------------------------- schema

    def _init_schema(self):
        with self._lock:
            self._db.executescript(
                """
                CREATE TABLE IF NOT EXISTS artifacts (
                    id          TEXT PRIMARY KEY,
                    run_id      TEXT,
                    agent       TEXT,
                    kind        TEXT NOT NULL,
                    title       TEXT NOT NULL,
                    sub         TEXT,
                    version     INTEGER NOT NULL DEFAULT 1,
                    parent_id   TEXT,
                    status      TEXT NOT NULL DEFAULT 'ready',
                    project     TEXT,
                    stored_path TEXT,
                    file_name   TEXT,
                    mime        TEXT,
                    size        INTEGER DEFAULT 0,
                    thumb_path  TEXT,
                    html_url    TEXT,
                    meta_json   TEXT,
                    source_json TEXT,
                    ts          TEXT,
                    updated_at  TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_art_ts ON artifacts(ts DESC);
                CREATE INDEX IF NOT EXISTS idx_art_kind ON artifacts(kind);
                CREATE INDEX IF NOT EXISTS idx_art_parent ON artifacts(parent_id);

            -- 目录 watcher 的记忆：源文件 → 上一次发布的成果 + 内容哈希。
            -- 有了它才能判断「文件变了」而不是「文件又扫到了」。
            CREATE TABLE IF NOT EXISTS watch_sources (
                path        TEXT PRIMARY KEY,
                sha1        TEXT NOT NULL,
                artifact_id TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

                CREATE TABLE IF NOT EXISTS annotations (
                    id           TEXT PRIMARY KEY,
                    artifact_id  TEXT NOT NULL,
                    seq          INTEGER NOT NULL,
                    surface      TEXT DEFAULT 'image',
                    severity     TEXT DEFAULT 'minor',
                    body         TEXT,
                    anchor_json  TEXT,
                    status       TEXT DEFAULT 'open',
                    carried_from TEXT,
                    created_at   TEXT,
                    updated_at   TEXT,
                    author       TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_anno_art ON annotations(artifact_id, seq);

                CREATE TABLE IF NOT EXISTS audit (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts          TEXT,
                    event       TEXT,
                    artifact_id TEXT,
                    actor       TEXT,
                    payload_json TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_audit_art ON audit(artifact_id, id);
                """
            )
            self._db.commit()

    def close(self):
        with self._lock:
            self._db.close()

    # -------------------------------------------------------------- 工具

    def _audit(self, event: str, artifact_id=None, actor=None, payload=None):
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO audit(ts, event, artifact_id, actor, payload_json) VALUES(?,?,?,?,?)",
                (now_iso(), event, artifact_id, actor or "system", _jdump(payload)),
            )
            self._db.commit()
            return cur.lastrowid

    def audit_entries(self, artifact_id=None, limit=200) -> list:
        sql = "SELECT * FROM audit"
        args: list = []
        if artifact_id:
            sql += " WHERE artifact_id=?"
            args.append(artifact_id)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(int(limit))
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [{"id": r["id"], "ts": r["ts"], "event": r["event"],
                 "artifact_id": r["artifact_id"], "actor": r["actor"],
                 "payload": _jload(r["payload_json"], {})} for r in rows]

    # -------------------------------------------------------------- 序列化

    def _row_to_artifact(self, row, with_annotations=False) -> dict:
        aid = row["id"]
        out = {
            "id": aid,
            "run_id": row["run_id"],
            "agent": row["agent"] or "pilotdeck",
            "kind": row["kind"],
            "title": row["title"],
            "sub": row["sub"] or "",
            "version": row["version"],
            "parent_id": row["parent_id"],
            "status": row["status"],
            "project": row["project"],
            "entry": {
                "thumb_url": f"/api/artifacts/{aid}/thumb" if row["thumb_path"] else None,
                "url": f"/api/artifacts/{aid}/raw" if row["stored_path"] else None,
                "html_url": row["html_url"],
                "meta": _jload(row["meta_json"], {}) or {},
            },
            "source": _jload(row["source_json"], {}) or {},
            "file_name": row["file_name"],
            "mime": row["mime"],
            "size": row["size"] or 0,
            "ts": row["ts"],
            "updated_at": row["updated_at"],
        }
        # 「能不能给人看」要在服务端就说清楚，前端别自己猜：
        #   deliverable  —— 是不是一份独立最终成果（元素截图/图标/缩略图 = false）
        #   displayable  —— 有没有真文件可显示（空文件名/0 字节/文件已不在 = false）
        # 两个都是**标记**，不是删除：历史数据一条不动，只是默认不露出来。
        src_path = (out["source"] or {}).get("path") or ""
        try:
            import artifacts_deliver
            out["deliverable"], out["deliverable_reason"] = artifacts_deliver.classify(
                row["kind"], src_path, (out["source"] or {}).get("deliverable"))
        except Exception:
            out["deliverable"], out["deliverable_reason"] = "final", ""
        has_name = bool((row["file_name"] or "").strip())
        has_file = bool(row["stored_path"]) and (row["size"] or 0) > 0
        out["displayable"] = bool(has_name and has_file)
        if not has_name:
            out["displayable_reason"] = "没有文件名，显示不出内容"
        elif not has_file:
            out["displayable_reason"] = "库里没有文件内容（0 字节或已清理）"
        out["dup_key"] = artifacts_deliver.dup_key(
            row["project"], row["file_name"], row["size"], row["mime"])

        out["open_notes"] = self._open_count(aid)
        if with_annotations:
            out["annotations"] = self.annotations(aid)
        return out

    def _open_count(self, artifact_id: str) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*) c FROM annotations WHERE artifact_id=? AND status='open'",
                (artifact_id,)).fetchone()
        return int(row["c"] or 0)

    def annotations(self, artifact_id: str) -> list:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM annotations WHERE artifact_id=? ORDER BY seq", (artifact_id,)
            ).fetchall()
        out = []
        for r in rows:
            anchor = _jload(r["anchor_json"], {}) or {}
            out.append({
                "id": r["id"],
                "seq": r["seq"],
                "surface": r["surface"],
                "severity": r["severity"],
                "body": r["body"],
                "anchor": anchor,
                # rect 同时提到顶层：v0 前端与多数消费方按 n.rect 读，保留兼容
                "rect": anchor.get("rect"),
                "selector": anchor.get("selector"),
                "status": r["status"],
                "resolved": r["status"] == "resolved",
                "carried_from": r["carried_from"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "author": r["author"],
            })
        return out

    # -------------------------------------------------------------- 读

    def get(self, artifact_id: str, with_annotations=True):
        with self._lock:
            row = self._db.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if not row:
            return None
        return self._row_to_artifact(row, with_annotations=with_annotations)

    def list(self, kind=None, status=None, agent=None, run_id=None, unowned=False,
             limit=200, offset=0) -> list:
        """列成果。run_id 是会话归属（成果台里唯一的归属字段）。

        传 run_id 就是「只看这一个会话的成果」——归属过滤必须能在 SQL 里做，
        靠上层拿到全量再筛，既把别人的成果发到了浏览器，又分页/limit 一卡就漏。

        unowned=True 取「一条会话都挂不上」的成果。它必须是一段独立查询，而不是
        run_id=''：空归属的成果普遍很旧，混在按时间倒序取的那批里会被 limit
        整个截掉（实测 129 条空归属全在最近 400 条之外），未归属区就会永远是空的。
        """
        sql = "SELECT * FROM artifacts WHERE 1=1"
        args: list = []
        if kind and kind != "all":
            sql += " AND kind=?"
            args.append(kind)
        if status:
            sql += " AND status=?"
            args.append(status)
        if agent:
            sql += " AND agent=?"
            args.append(agent)
        if run_id:
            sql += " AND run_id=?"
            args.append(run_id)
        if unowned:
            sql += " AND (run_id IS NULL OR run_id='')"
        sql += " ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?"
        args += [max(1, min(int(limit), 1000)), max(0, int(offset))]
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [self._row_to_artifact(r) for r in rows]

    def rework_queue(self) -> list:
        """所有处于返工状态的成果（agent 唤醒时没有指定 id 就拉整队列）。"""
        return self.list(status="rework", limit=200)

    def count(self, kind=None, status=None) -> int:
        sql = "SELECT COUNT(*) c FROM artifacts WHERE 1=1"
        args: list = []
        if kind and kind != "all":
            sql += " AND kind=?"
            args.append(kind)
        if status:
            sql += " AND status=?"
            args.append(status)
        with self._lock:
            row = self._db.execute(sql, args).fetchone()
        return int(row["c"] or 0)

    def agent_counts(self) -> list:
        """按 agent 归拢的成果数（M4 多 agent 同流，前端筛选条用）。"""
        with self._lock:
            rows = self._db.execute(
                "SELECT agent, COUNT(*) c FROM artifacts GROUP BY agent ORDER BY c DESC"
            ).fetchall()
        return [{"agent": r["agent"] or "pilotdeck", "count": int(r["c"] or 0)} for r in rows]

    def chain(self, artifact_id: str) -> list:
        """版本链：向上找到根，再向下展开到叶（M3 版本对比用）。"""
        cur = artifact_id
        seen = set()
        up = []
        while cur and cur not in seen:
            seen.add(cur)
            with self._lock:
                row = self._db.execute("SELECT * FROM artifacts WHERE id=?", (cur,)).fetchone()
            if not row:
                break
            up.append(self._row_to_artifact(row, with_annotations=True))
            cur = row["parent_id"]
        chain = list(reversed(up))
        root = chain[0]["id"] if chain else artifact_id
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM artifacts WHERE id=? OR parent_id=? ORDER BY version, ts",
                (root, root)).fetchall()
        kids = [self._row_to_artifact(r, with_annotations=True) for r in rows]
        kids.sort(key=lambda a: (a["version"], a["ts"]))
        return kids

    # -------------------------------------------------------------- 写

    def create(self, payload: dict) -> dict:
        """登记成果。payload 见交接文档 §5 / §6.1。

        带 parent_id 时即为「新版本」：自动继承父版本未解决的标注（carried_from 记来源）。
        """
        p = dict(payload or {})
        kind = (p.get("kind") or "image").strip()
        if kind not in KINDS:
            raise ValueError(f"未知 kind: {kind}")
        title = (p.get("title") or "未命名成果").strip()
        parent_id = p.get("parent_id") or None
        now = now_iso()

        aid = p.get("id") or new_artifact_id()
        if self.get(aid, with_annotations=False):
            raise ValueError(f"成果已存在: {aid}")

        version = 1
        inherited: list = []
        if parent_id:
            parent = self.get(parent_id, with_annotations=True)
            if not parent:
                raise ValueError(f"父版本不存在: {parent_id}")
            with self._lock:
                row = self._db.execute(
                    "SELECT MAX(version) m FROM artifacts WHERE id=? OR parent_id=?",
                    (parent_id, parent_id)).fetchone()
            version = int((row["m"] or parent["version"]) or 1) + 1
            inherited = [n for n in parent["annotations"] if n["status"] == "open"]

        status = p.get("status") or ("pending" if p.get("needs_materialize", True) else "ready")
        if status not in STATUSES:
            raise ValueError(f"未知 status: {status}")

        source = {
            "tool": p.get("tool") or "publish_artifact",
            "path": p.get("path") or p.get("file_path") or "",
            "notes": p.get("notes") or "",
        }
        meta = dict(p.get("meta") or {})
        if p.get("project"):
            meta["project"] = p["project"]

        with self._lock:
            self._db.execute(
                """INSERT INTO artifacts
                   (id, run_id, agent, kind, title, sub, version, parent_id, status, project,
                    stored_path, file_name, mime, size, thumb_path, html_url,
                    meta_json, source_json, ts, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (aid, p.get("run_id"), p.get("agent") or "pilotdeck", kind, title,
                 p.get("sub") or "", version, parent_id, status, p.get("project") or "",
                 p.get("stored_path") or "", p.get("file_name") or "", p.get("mime") or "",
                 int(p.get("size") or 0), p.get("thumb_path") or "", p.get("html_url") or "",
                 _jdump(meta), _jdump(source), now, now),
            )
            # 标注继承：新版本自带父版本未解决的意见，seq 重新编号
            seq = 0
            for n in inherited:
                seq += 1
                self._db.execute(
                    """INSERT INTO annotations
                       (id, artifact_id, seq, surface, severity, body, anchor_json,
                        status, carried_from, created_at, updated_at, author)
                       VALUES (?,?,?,?,?,?,?,'open',?,?,?,?)""",
                    (self._new_note_id(aid, seq), aid, seq, n.get("surface") or "image",
                     n.get("severity") or "minor", n.get("body") or "", _jdump(n.get("anchor")),
                     n.get("id"), now, now, n.get("author") or "inherit"),
                )
            self._db.commit()

        self._audit("artifact.created", aid, p.get("agent"),
                    {"kind": kind, "title": title, "version": version,
                     "parent_id": parent_id, "inherited": len(inherited)})
        art = self.get(aid, with_annotations=True)
        self.bus.publish("artifact.added", {"artifact": art})
        if inherited:
            self.bus.publish("annotation.inherited",
                             {"artifact_id": aid, "count": len(inherited),
                              "from": parent_id})
        return art

    def _new_note_id(self, artifact_id: str, seq: int) -> str:
        return f"{artifact_id}-n{seq}"

    def add_annotation(self, artifact_id: str, payload: dict) -> dict:
        art = self.get(artifact_id, with_annotations=False)
        if not art:
            raise KeyError(artifact_id)
        p = dict(payload or {})
        severity = p.get("severity") or "minor"
        if severity not in SEVERITIES:
            raise ValueError(f"未知 severity: {severity}")
        surface = p.get("surface") or art["kind"] if art["kind"] in SURFACES else "image"
        anchor = p.get("anchor")
        if not isinstance(anchor, dict):
            anchor = {}
        rect = p.get("rect") or anchor.get("rect")
        if rect:
            anchor["rect"] = _norm_rect(rect)          # 归一化，容错越界值
        if p.get("selector"):
            anchor["selector"] = p["selector"]
        # 视频标注要能记「第几个画面时间点」：t 是秒，frame 是帧号。
        # 帧号只在调用方真的知道帧率时才给 —— 服务端不从秒数硬凑一个。
        if p.get("t") is not None or anchor.get("t") is not None:
            import artifacts_deliver
            t = p.get("t") if p.get("t") is not None else anchor.get("t")
            fps = p.get("fps") or anchor.get("fps")
            got = artifacts_deliver.anchor_time(t, fps)
            anchor.pop("t", None)
            anchor.pop("fps", None)
            if got:
                anchor["t"] = got["t"]
                if "frame" in got:
                    anchor["frame"] = got["frame"]
        elif p.get("frame") is not None and p.get("fps"):
            # 只给了帧号+帧率：换算回秒，两边对得上
            try:
                fps = float(p["fps"])
                if fps > 0:
                    anchor["t"] = round(float(p["frame"]) / fps, 3)
                    anchor["frame"] = int(p["frame"])
            except (TypeError, ValueError, ZeroDivisionError):
                pass
        if p.get("part") is not None:
            anchor["part"] = p["part"]
        body = (p.get("body") or "").strip()
        if not body:
            raise ValueError("标注内容不能为空")

        now = now_iso()
        with self._lock:
            row = self._db.execute(
                "SELECT COALESCE(MAX(seq),0) s FROM annotations WHERE artifact_id=?",
                (artifact_id,)).fetchone()
            seq = int(row["s"] or 0) + 1
            nid = self._new_note_id(artifact_id, seq)
            self._db.execute(
                """INSERT INTO annotations
                   (id, artifact_id, seq, surface, severity, body, anchor_json, status,
                    carried_from, created_at, updated_at, author)
                   VALUES (?,?,?,?,?,?,?,'open',?,?,?,?)""",
                (nid, artifact_id, seq, surface, severity, body, _jdump(anchor),
                 p.get("carried_from"), now, now, p.get("author") or "reviewer"),
            )
            self._db.commit()

        self._audit("annotation.added", artifact_id, p.get("author"),
                    {"note_id": nid, "seq": seq, "severity": severity, "body": body})
        note = next(n for n in self.annotations(artifact_id) if n["id"] == nid)
        self.bus.publish("annotation.added",
                         {"artifact_id": artifact_id, "annotation": note})
        return note

    def update_annotation(self, artifact_id: str, note_id: str, patch: dict) -> dict:
        rows = {n["id"]: n for n in self.annotations(artifact_id)}
        if note_id not in rows:
            raise KeyError(note_id)
        old = rows[note_id]
        p = dict(patch or {})
        body = p.get("body", old["body"])
        severity = p.get("severity", old["severity"])
        if severity not in SEVERITIES:
            raise ValueError(f"未知 severity: {severity}")
        status = p.get("status", old["status"])
        if status not in ("open", "resolved"):
            raise ValueError(f"未知标注状态: {status}")
        anchor = p.get("anchor", old["anchor"]) or {}
        if p.get("rect"):
            anchor = dict(anchor)
            anchor["rect"] = _norm_rect(p["rect"])
        now = now_iso()
        with self._lock:
            self._db.execute(
                """UPDATE annotations SET body=?, severity=?, status=?, anchor_json=?, updated_at=?
                   WHERE id=? AND artifact_id=?""",
                (body, severity, status, _jdump(anchor), now, note_id, artifact_id),
            )
            self._db.commit()
        self._audit("annotation.updated", artifact_id, p.get("author") or "reviewer",
                    {"note_id": note_id, "from": old["status"], "to": status,
                     "severity": severity, "body": body})
        note = next(n for n in self.annotations(artifact_id) if n["id"] == note_id)
        self.bus.publish("annotation.updated",
                         {"artifact_id": artifact_id, "annotation": note})
        return note

    def delete_annotation(self, artifact_id: str, note_id: str, *, actor="reviewer") -> dict:
        """删掉一条标注。

        为什么要真删而不是「标记已忽略」：人框错了位置是常事，只留一条 resolved 的
        意见会让新版本一直继承它（继承只取 open 的，但如果只改 status 不行），
        而且返工单里会一直挂着一条没人要的条目。
        删完会把剩下的标注重新编号 seq=1..N —— seq 是给人看的序号，
        留空洞（1,2,4）会让画面上的气泡和列表对不上。
        """
        with self._lock:
            rows = {n["id"]: n for n in self.annotations(artifact_id)}
            if note_id not in rows:
                raise KeyError(note_id)
            old = rows[note_id]
            self._db.execute("DELETE FROM annotations WHERE id=? AND artifact_id=?",
                             (note_id, artifact_id))
            rest = sorted((n for n in rows.values() if n["id"] != note_id),
                          key=lambda n: n["seq"])
            now = now_iso()
            # 先挪到临时负数 id，再落到最终 id：id 是主键，直接改会和未改的行撞车
            renames: dict = {}
            for idx, n in enumerate(rest, start=1):
                if n["id"] == self._new_note_id(artifact_id, idx):
                    continue
                tmp = self._new_note_id(artifact_id, -idx)
                self._db.execute("UPDATE annotations SET id=?, seq=?, updated_at=? WHERE id=?",
                                 (tmp, idx, now, n["id"]))
                renames[n["id"]] = self._new_note_id(artifact_id, idx)
            for old_id, new_id in renames.items():
                self._db.execute("UPDATE annotations SET id=? WHERE id=?", (new_id, old_id))
                # 下一版继承时记的是父版本的 id；父版本重编号后要把引用一起改，
                # 否则那条「由哪条意见继承来的」会指向一个不存在的 id
                self._db.execute(
                    "UPDATE annotations SET carried_from=? WHERE carried_from=?", (new_id, old_id))
            self._db.commit()
        self._audit("annotation.deleted", artifact_id, actor,
                    {"note_id": note_id, "seq": old["seq"], "body": old["body"]})
        notes = self.annotations(artifact_id)
        self.bus.publish("annotation.deleted",
                         {"artifact_id": artifact_id, "annotation_id": note_id,
                          "annotations": notes})
        return {"artifact_id": artifact_id, "deleted": note_id, "annotations": notes}

    def watch_lookup(self, path: str) -> dict:
        """上次这个源文件发布成了哪个成果（没有则 None）。"""
        with self._lock:
            row = self._db.execute(
                "SELECT path, sha1, artifact_id, updated_at FROM watch_sources WHERE path=?",
                (path,)).fetchone()
        return dict(row) if row else None

    def watch_remember(self, path: str, sha1: str, artifact_id: str) -> None:
        with self._lock:
            self._db.execute(
                """INSERT INTO watch_sources(path, sha1, artifact_id, updated_at)
                   VALUES(?,?,?,?)
                   ON CONFLICT(path) DO UPDATE SET
                     sha1=excluded.sha1, artifact_id=excluded.artifact_id,
                     updated_at=excluded.updated_at""",
                (path, sha1, artifact_id, now_iso()))
            self._db.commit()

    def reanchor(self, artifact_id: str, rects: dict, *, actor="system") -> dict:
        """按重新量到的 rect 更新标注锚点（页面返工改版后调用）。

        rects 的键是 selector（缺图即"元素没了"）。找不到的会标 reanchor=missing
        而不是静默留着旧坐标 —— 让人看见"这条意见对应的元素被删了"。
        """
        rects = rects or {}
        notes = self.annotations(artifact_id)
        moved, missing, kept = [], [], []
        now = now_iso()
        with self._lock:
            for n in notes:
                sel = (n.get("anchor") or {}).get("selector")
                if not sel:
                    kept.append(n["id"])
                    continue
                anchor = dict(n["anchor"] or {})
                old_rect = anchor.get("rect") or {}
                if sel in rects:
                    new_rect = _norm_rect(rects[sel])
                    anchor["rect"] = new_rect
                    anchor["reanchor"] = "moved"
                    anchor["reanchored_at"] = now
                    moved.append(n["id"])
                else:
                    anchor["reanchor"] = "missing"
                    anchor["reanchored_at"] = now
                    missing.append(n["id"])
                if anchor.get("rect") == old_rect and anchor.get("reanchor") == "kept":
                    continue
                self._db.execute(
                    "UPDATE annotations SET anchor_json=?, updated_at=? WHERE id=? AND artifact_id=?",
                    (_jdump(anchor), now, n["id"], artifact_id))
            self._db.commit()
        if moved or missing:
            self._audit("annotation.reanchor", artifact_id, actor,
                        {"moved": moved, "missing": missing, "kept": kept})
            for n in self.annotations(artifact_id):
                if n["id"] in moved or n["id"] in missing:
                    self.bus.publish("annotation.updated",
                                     {"artifact_id": artifact_id, "annotation": n})
        return {"moved": moved, "missing": missing, "kept": kept}

    def set_status(self, artifact_id: str, status: str, actor=None, note="", force=False) -> dict:
        if status not in STATUSES:
            raise ValueError(f"未知 status: {status}")
        art = self.get(artifact_id, with_annotations=False)
        if not art:
            raise KeyError(artifact_id)
        old = art["status"]
        if old == status:
            return art
        allowed = ALLOWED_TRANSITIONS.get(old, set())
        if status not in allowed and not force:
            raise ValueError(f"非法状态流转 {old} → {status}（允许: {sorted(allowed)}）")
        now = now_iso()
        with self._lock:
            self._db.execute("UPDATE artifacts SET status=?, updated_at=? WHERE id=?",
                             (status, now, artifact_id))
            self._db.commit()
        self._audit("artifact.status", artifact_id, actor,
                    {"from": old, "to": status, "note": note})
        art = self.get(artifact_id, with_annotations=False)
        self.bus.publish("artifact.status",
                         {"artifact_id": artifact_id, "from": old, "to": status, "note": note})
        return art

    def dispatch(self, artifact_id: str, actor=None, note="") -> dict:
        """提交返工：状态置 rework，并把未解决标注整理成返工清单返回。"""
        art = self.set_status(artifact_id, "rework", actor=actor, note=note, force=True)
        payload = self.feedback(artifact_id, "open")
        self._audit("artifact.dispatch", artifact_id, actor,
                    {"notes": len(payload), "note": note})
        self.bus.publish("artifact.dispatched",
                         {"artifact_id": artifact_id, "notes": len(payload)})
        return {"artifact": art, "feedback": payload}

    def feedback(self, artifact_id: str, status: str = "open") -> list:
        want = "resolved" if status in ("resolved", "done") else "open"
        return [n for n in self.annotations(artifact_id) if n["status"] == want]

    def materialize_done(self, artifact_id: str, *, thumb_path=None, mime=None,
                         meta=None, error=None, status=None) -> dict:
        """物化队列回调：写缩略图/元信息并把骨架卡推进到 ready。"""
        now = now_iso()
        with self._lock:
            row = self._db.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
            if not row:
                raise KeyError(artifact_id)
            old_meta = _jload(row["meta_json"], {}) or {}
            if meta:
                old_meta.update(meta)
            old_meta["materialized"] = not error
            if error:
                old_meta["materialize_error"] = str(error)[:300]
            self._db.execute(
                """UPDATE artifacts SET thumb_path=COALESCE(?, thumb_path), mime=COALESCE(?, mime),
                   meta_json=?, updated_at=? WHERE id=?""",
                (thumb_path, mime, _jdump(old_meta), now, artifact_id),
            )
            self._db.commit()
        self._audit("artifact.materialized", artifact_id, "system",
                    {"thumb": bool(thumb_path), "error": error})
        art = self.get(artifact_id, with_annotations=False)
        if error is None and status:
            try:
                art = self.set_status(artifact_id, status, actor="system", note="materialized")
            except ValueError:
                pass
        self.bus.publish("artifact.ready", {"artifact": art, "error": error})
        return art

    def attach_file(self, artifact_id: str, stored_path: str, file_name: str,
                    mime: str = "", size: int = 0, html_url: str = ""):
        with self._lock:
            self._db.execute(
                """UPDATE artifacts SET stored_path=?, file_name=?, mime=?, size=?,
                   html_url=COALESCE(NULLIF(?,''), html_url), updated_at=? WHERE id=?""",
                (stored_path, file_name, mime, int(size), html_url, now_iso(), artifact_id),
            )
            self._db.commit()

    # ---------------------------------------------- 成果台内就地编辑 / 部件 / 应用返工

    def patch_meta(self, artifact_id: str, patch: dict, *, event="artifact.updated",
                   actor: str = "reviewer", size: int | None = None,
                   bump: bool = True) -> dict:
        """只改 meta_json（可带 size），不碰版本链。

        用于三件事：评审在成果台里手工改了文本、发布时带进来的部件树、
        「应用返工」的落点记录。它们都不该把成果顶成新版本 —— 新版本只由
        agent 重新 publish 产生，否则版本链会被人肉编辑冲垮。
        """
        now = now_iso()
        with self._lock:
            row = self._db.execute("SELECT * FROM artifacts WHERE id=?",
                                   (artifact_id,)).fetchone()
            if not row:
                raise KeyError(artifact_id)
            meta = _jload(row["meta_json"], {}) or {}
            meta.update(patch or {})
            if size is not None:
                self._db.execute(
                    "UPDATE artifacts SET meta_json=?, size=?, updated_at=? WHERE id=?",
                    (_jdump(meta), int(size), now, artifact_id))
            else:
                self._db.execute("UPDATE artifacts SET meta_json=?, updated_at=? WHERE id=?",
                                 (_jdump(meta), now, artifact_id))
            self._db.commit()
        self._audit(event, artifact_id, actor, {"meta_keys": sorted((patch or {}).keys())})
        art = self.get(artifact_id, with_annotations=False)
        self.bus.publish(event, {"artifact": art})
        return art

    def record_apply(self, artifact_id: str, payload: dict, actor: str = "reviewer") -> dict:
        """记一笔「应用 AI 修改」的落点：项目目录 + 会话 + 通道成败。

        写进 meta.apply_history 而不是新建表 —— 审查看的是成果本身，
        返工历史挂成果上才有意义。
        """
        with self._lock:
            row = self._db.execute("SELECT meta_json FROM artifacts WHERE id=?",
                                   (artifact_id,)).fetchone()
            if not row:
                raise KeyError(artifact_id)
            meta = _jload(row["meta_json"], {}) or {}
            hist = meta.get("apply_history")
            if not isinstance(hist, list):
                hist = []
            hist.insert(0, dict(payload or {}, at=now_iso(), by=actor))
            meta["apply_history"] = hist[:50]
            self._db.execute("UPDATE artifacts SET meta_json=?, updated_at=? WHERE id=?",
                             (_jdump(meta), now_iso(), artifact_id))
            self._db.commit()
        self._audit("artifact.applied", artifact_id, actor, payload or {})
        art = self.get(artifact_id, with_annotations=False)
        self.bus.publish("artifact.applied", {"artifact": art, "apply": payload or {}})
        return art
    def merge_meta(self, artifact_id: str, extra: dict) -> bool:
        """往成果的 entry.meta 里补字段（只补不覆盖已有键）。返回是否真的改了。

        用来事后补探测结果：老成果物化时没有 fps，现在探到了就补进去，
        不必把整条成果重新物化一遍。
        """
        extra = {k: v for k, v in (extra or {}).items() if v not in (None, "")}
        if not extra:
            return False
        with self._lock:
            row = self._db.execute(
                "SELECT meta_json FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
            if not row:
                return False
            meta = _jload(row["meta_json"], {}) or {}
            if all(meta.get(k) == v for k, v in extra.items()):
                return False
            meta.update(extra)
            self._db.execute("UPDATE artifacts SET meta_json=? WHERE id=?",
                             (json.dumps(meta, ensure_ascii=False), artifact_id))
        return True

    def stored_path_of(self, artifact_id: str) -> str:
        """落盘文件绝对路径（没有文件则空串）。"""
        with self._lock:
            row = self._db.execute(
                "SELECT stored_path FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        return (row["stored_path"] or "") if row else ""

    def thumb_path_of(self, artifact_id: str) -> str:
        """缩略图路径。占位图是 SVG 而非 PNG，别按扩展名猜类型。"""
        with self._lock:
            row = self._db.execute(
                "SELECT thumb_path FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        return (row["thumb_path"] or "") if row else ""

    # -------------------------------------------------------------- 统计

    def stats(self) -> dict:
        with self._lock:
            rows = self._db.execute(
                "SELECT kind, status, COUNT(*) c FROM artifacts GROUP BY kind, status").fetchall()
        by_kind: dict = {}
        by_status: dict = {}
        for r in rows:
            by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + int(r["c"])
            by_status[r["status"]] = by_status.get(r["status"], 0) + int(r["c"])
        with self._lock:
            open_notes = int(self._db.execute(
                "SELECT COUNT(*) c FROM annotations WHERE status='open'").fetchone()["c"] or 0)
        return {"total": sum(by_kind.values()), "by_kind": by_kind,
                "by_status": by_status, "open_notes": open_notes,
                "events": self.bus.stats(), "data_dir": self.data_dir}


def _norm_rect(rect: dict) -> dict:
    """归一化矩形到 0-1，越界夹紧；w/h 至少 0.005（否则点太小点不中）。"""
    def _f(v, default=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default
    x = min(max(_f(rect.get("x")), 0.0), 1.0)
    y = min(max(_f(rect.get("y")), 0.0), 1.0)
    w = min(max(_f(rect.get("w"), 0.05), 0.005), 1.0 - x)
    h = min(max(_f(rect.get("h"), 0.05), 0.005), 1.0 - y)
    return {"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}
