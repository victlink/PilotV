"""PilotV 成果台 —— 左栏「项目目录 / 会话目录」的数据源。

为什么要单独一个模块：
    左栏要跟 PilotDeck 自己的项目、会话目录**长得一样**，那就不能自己另造一套
    目录 —— 事实源只有一个：`$PILOTDECK_HOME/projects/`。本模块按 PilotDeck
    自己的规则读同一批文件，产出同样的字段形状：

      · 项目名 = `~/.pilotdeck/projects/<slug>/.cwd` 里记的工作目录
      · 会话   = `<slug>/chats/<channel>:<sessionId>.jsonl`
      · 摘要   = 最后一条 `session_metadata` 的 title / aiTitle / lastPrompt /
                 firstPrompt（与 SessionList.ts 的 `summary` 同规则）
      · 排序   = 项目按 lastActivity 降序；会话按 lastModified 降序

    这么对齐的后果是：PilotDeck 里新开一个会话，成果台左栏不用改代码就会多一行。

「大文件不要整读」：会话 JSONL 能到几十 MB，整读会把 console 主进程拖死。
和 PilotDeck 一样只读头尾各 64KB（SessionLiteReader 的做法），并按
(路径, mtime, size) 缓存 —— 正在被写的会话每次内容都变，没有缓存会退化成
每请求扫几十 MB。

「正在实时修改」怎么判：会话 JSONL 的 mtime 在 LIVE_WINDOW 内，且
pending-inputs 里没有把它标成 paused。这就是用户看到的「实时」的同一个事实，
不是另造的状态机。
"""
from __future__ import annotations

import json
import os
import re
import time

# 与 PilotDeck 的 isInternalSession() 保持一致：always-on 的辅助会话不进左栏
INTERNAL_SESSION_RE = re.compile(r"^always-on-(discovery|workspace|report)[:\-]")

# 头尾各读这么多字节找 session_metadata。比 PilotDeck 的 64KB 更省：
# /vol3 是网络盘，整库读一遍要好几秒；session_metadata 每轮都会追加，
# 尾部 32KB 基本总能命中，头部只为兜底「刚开的会话还没有 metadata」。
HEAD_READ_BYTES = int(os.environ.get("ARTIFACTS_SESSION_HEAD_BYTES", 16 * 1024))
TAIL_READ_BYTES = int(os.environ.get("ARTIFACTS_SESSION_TAIL_BYTES", 32 * 1024))

# 会话 JSONL 在多久内被写过算「实时」
LIVE_WINDOW = float(os.environ.get("ARTIFACTS_LIVE_WINDOW", "180"))

# 目录扫描结果的缓存秒数。左栏不需要毫秒级新鲜度，而扫描要 stat 上千文件。
CACHE_TTL = float(os.environ.get("ARTIFACTS_WORKSPACE_TTL", "15"))

_META_KEYS = ("title", "aiTitle", "lastPrompt", "firstPrompt", "tag")

_meta_cache: dict = {}
_tree_cache = {"ts": 0.0, "value": None}


def pilot_home() -> str:
    """PilotDeck 的数据根目录。可用 PILOTDECK_HOME 覆盖（回归测试用临时目录）。"""
    return os.environ.get("PILOTDECK_HOME") or os.path.join(
        os.path.expanduser("~"), ".pilotdeck")


def _iso(ts: float):
    if not ts:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)) + time.strftime("%z", time.localtime(ts))


def _read_lite(path: str):
    """只读头尾，避免把几十 MB 的会话文件整个拉进内存。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(HEAD_READ_BYTES)
            tail = b""
            if size > TAIL_READ_BYTES:
                fh.seek(max(0, size - TAIL_READ_BYTES))
                tail = fh.read()
    except OSError:
        return "", ""
    # 头尾都可能从半行开始，落不到完整 JSON 的行直接丢掉
    head_txt = head.decode("utf-8", "replace").split("\n", 1)[-1]
    tail_txt = tail.decode("utf-8", "replace").split("\n", 1)[-1] if tail else ""
    return head_txt, tail_txt


def _scan_meta(text: str, out: dict) -> None:
    for line in text.splitlines():
        if '"session_metadata"' not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") != "session_metadata":
            continue
        meta = rec.get("metadata") or {}
        for key in _META_KEYS:
            val = meta.get(key)
            if isinstance(val, str) and val.strip():
                out[key] = val.strip()


def _first_prompt(text: str) -> str | None:
    """没有 session_metadata 时（刚开始的会话），退回第一条用户输入。"""
    for line in text.split("\n"):
        if '"accepted_input"' not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        for msg in rec.get("messages") or []:
            if msg.get("role") != "user":
                continue
            for part in msg.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "text":
                    text_ = (part.get("text") or "").strip()
                    if text_:
                        return text_
    return None


def session_stat(path: str, session_id: str, project_id: str, cwd: str) -> dict | None:
    """只 stat，不读内容。

    全库有几百个会话文件、累计几十 MB；排序只需要 mtime，所以标题必须**懒解析**：
    先用 stat 排完序，再只给「左栏真要显示的那几条」读内容。全量读一遍要好几秒，
    而 stat 全部只要几十毫秒。
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    hit = _meta_cache.get(path)
    resolved = None
    if hit and hit["mtime"] == st.st_mtime and hit["size"] == st.st_size:
        resolved = hit.get("info")
    return {
        "id": session_id,
        "cwd": cwd,
        "created_at": _iso(st.st_ctime),
        "updated_at": _iso(st.st_mtime),
        "lastActivity": _iso(st.st_mtime),
        "last_modified": st.st_mtime,
        "size": st.st_size,
        "messageCount": 0,
        "__project_id": project_id,
        "_path": path,
        "_info": resolved,
    }


def _resolve(stub: dict) -> dict:
    """给 stat 骨架补上标题/摘要等需要读文件才有的字段，结果按 mtime 缓存。"""
    info = stub.get("_info")
    if info is None:
        info = _read_session(stub["_path"], stub["id"], stub["cwd"])
        _meta_cache[stub["_path"]] = {"mtime": stub["last_modified"],
                                      "size": stub["size"], "info": info}
    out = {k: v for k, v in stub.items() if not k.startswith("_")}
    out.update(info)
    out.setdefault("live", False)   # 没走过 _project_entry 的 stub 也别把字段丢了
    return out


def _read_session(path: str, session_id: str, cwd: str) -> dict:
    head, tail = _read_lite(path)
    meta: dict = {}
    _scan_meta(head, meta)
    _scan_meta(tail, meta)
    first_prompt = meta.get("firstPrompt") or _first_prompt(head)
    last_prompt = meta.get("lastPrompt")
    # lastPrompt 偶尔是工具结果原文（'{"error": ...}' 这种），直接当标题会显示一坨 JSON。
    # 宁可退回 firstPrompt，也不要把原始 JSON 甩到左栏。
    if last_prompt and last_prompt.lstrip()[:1] in "{[":
        last_prompt = None
    summary = (meta.get("title") or meta.get("aiTitle")
               or last_prompt or first_prompt or session_id)
    return {
        "title": summary,
        "summary": summary,
        "name": summary,
        "customTitle": meta.get("title"),
        "aiTitle": meta.get("aiTitle"),
        "firstPrompt": first_prompt,
        "tag": meta.get("tag"),
    }
    # 这里**不要**再塞 "live"：_resolve() 是 out.update(info)，会把这儿的值
    # 盖掉 _project_entry 按 mtime/paused 算出来的 live。原来这里有个
    # "live": False 占位，结果左栏的「实时」标记从上线起就没亮过 ——
    # 真实会话（mtime 5 秒前）也被显示成不实时。
    # live 的唯一事实源是 _project_entry。


def _pending_paused(project_dir: str, session_id: str) -> bool:
    """pending-inputs/<sid>.json 里 paused=true 表示这个会话被人按了暂停。"""
    path = os.path.join(project_dir, "pending-inputs", f"{session_id}.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return bool(json.load(fh).get("paused"))
    except Exception:
        return False


def _project_entry(project_dir: str, project_id: str, session_limit: int) -> dict | None:
    try:
        with open(os.path.join(project_dir, ".cwd"), "r", encoding="utf-8") as fh:
            cwd = fh.read().strip()
    except OSError:
        cwd = ""
    if not cwd:
        # 没有 .cwd 的目录不是 PilotDeck 认的项目（可能是残留），不进左栏
        return None

    chat_dir = os.path.join(project_dir, "chats")
    try:
        names = sorted(os.listdir(chat_dir))
    except OSError:
        names = []

    sessions = []
    now = time.time()
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        session_id = name[: -len(".jsonl")]
        if INTERNAL_SESSION_RE.match(session_id):
            continue
        stub = session_stat(os.path.join(chat_dir, name), session_id, project_id, cwd)
        if not stub:
            continue
        stub["age"] = max(0.0, now - stub["last_modified"])
        stub["live"] = stub["age"] <= LIVE_WINDOW
        if _pending_paused(project_dir, session_id):
            stub["live"] = False
            stub["paused"] = True
        sessions.append(stub)

    # 与 PilotDeck 一致：会话按 lastModified 降序
    sessions.sort(key=lambda s: s["last_modified"], reverse=True)

    latest = max((s["last_modified"] for s in sessions), default=0.0)
    if not latest:
        try:
            latest = os.stat(project_dir).st_mtime
        except OSError:
            latest = 0.0

    total = len(sessions)
    if session_limit > 0:
        shown = sessions[:session_limit]
    else:
        shown = sessions
    # 懒解析：只有真要显示的会话才读文件拿标题
    shown = [_resolve(s) for s in shown]
    return {
        "name": project_id,
        "displayName": os.path.basename(cwd.rstrip("/")) or project_id,
        "fullPath": cwd,
        "path": cwd,
        "lastActivity": _iso(latest),
        "last_activity_ts": latest,
        "live": any(s.get("live") for s in sessions),
        "sessions": shown,
        "sessionMeta": {"total": total, "hasMore": total > len(shown)},
    }


def scan_projects(session_limit: int = 20) -> dict:
    """扫出 PilotDeck 的全部项目与会话。带短 TTL 缓存，别把每请求变成全盘 stat。"""
    now = time.monotonic()
    cached = _tree_cache.get("value")
    if cached and now - _tree_cache["ts"] < CACHE_TTL:
        return cached

    root = os.path.join(pilot_home(), "projects")
    projects = []
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        entries = []
    for project_id in entries:
        project_dir = os.path.join(root, project_id)
        if not os.path.isdir(project_dir):
            continue
        entry = _project_entry(project_dir, project_id, session_limit)
        if entry:
            projects.append(entry)

    # 与 PilotDeck 的 getProjects() 一致：项目按 lastActivity 降序
    projects.sort(key=lambda p: p["last_activity_ts"], reverse=True)
    for p in projects:
        p.pop("last_activity_ts", None)

    value = {"pilot_home": pilot_home(), "projects": projects}
    _tree_cache["ts"] = now
    _tree_cache["value"] = value
    return value


def find_project_for_path(path: str) -> dict | None:
    """按源文件路径反查所属项目（取 cwd 最长的那个，避免父目录抢走子目录的成果）。"""
    if not path:
        return None
    target = os.path.realpath(path)
    best = None
    best_len = -1
    for project in scan_projects(session_limit=0)["projects"]:
        cwd = project.get("fullPath") or ""
        if not cwd:
            continue
        cwd_real = os.path.realpath(cwd)
        if target == cwd_real or target.startswith(cwd_real.rstrip("/") + os.sep):
            if len(cwd_real) > best_len:
                best, best_len = project, len(cwd_real)
    return best


def invalidate() -> None:
    """发布成果 / SSE 推送后主动失效，避免左栏要等 TTL 过期才更新。"""
    _tree_cache["ts"] = 0.0
    _tree_cache["value"] = None


def warmup(session_limit: int = 20) -> None:
    """预热扫描。冷启动第一次要读几十个会话文件，放后台线程做，别卡住首页。"""
    try:
        scan_projects(session_limit=session_limit)
    except Exception as exc:                       # 预热失败不该拖垮启动
        print(f"[artifacts] 项目目录预热失败（忽略）: {exc}", flush=True)
