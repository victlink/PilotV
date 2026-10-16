"""PilotV 成果台 · aiohttp 路由层。

PilotV 是独立项目：本文件只负责「成果台」自己的路由与页面，
不依赖、也不假设任何其他项目的模块结构。运行方式见
.pilotdeck/skills/artifacts-console/RUNBOOK.md（scripts/serve_test.py 可单起一个
只含成果台的进程；生产上挂在一个已有的 aiohttp 宿主 app 上：
    from artifacts_console import mount; mount(app)
无论挂在谁身上，页面与数据都只属于 PilotV。其余逻辑（schema / 版本链 / 审计 /
事件总线 / 物化队列）都在 artifacts_store.py。

鉴权：宿主的 Cookie 登录态优先；agent / 侧车可用
    - Authorization: Bearer <ARTIFACTS_TOKEN>（环境变量设置后生效），或
    - 本机回环直连（curl、SKILL.md 兜底、localhost 侧的 MCP 侧车）。
本服务不再伺服独立成果台页面；PilotV 成果页直接调用下面的 API 取成果、预览与标注。
所有数据接口仍走 _guard() 三道鉴权。
"""
from __future__ import annotations

import asyncio
import hashlib
import functools
import json
import mimetypes
import os
import re
import shutil
import sys
import time
import traceback  # noqa: F401  (物化异常留现场用)
import urllib.parse
from urllib.parse import urlsplit

from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("ARTIFACTS_DATA_DIR") or os.path.join(HERE, ".artifacts-data")

# 物化并发上限：截图 / 转码是 CPU 密集，别把 console 主进程打满
MATER_WORKERS = int(os.environ.get("ARTIFACTS_MATERIALIZE_WORKERS", "2"))

_store = None
_mat = None
_watcher = None
_ingester = None


# --------------------------------------------------------------------- 基础工具


def _err(msg, status=400, **extra):
    payload = {"error": msg}
    payload.update(extra)
    return web.json_response(payload, status=status)


def _json(obj, status=200):
    return web.json_response(obj, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


def _remote_is_local(request) -> bool:
    peer = request.remote or ""
    return peer in ("127.0.0.1", "::1", "localhost") or peer.startswith("127.")


def _console_module():
    """拿 console_server 模块对象。

    console 以 `python3 console_server.py` 启动时，模块名在 sys.modules 里是
    __main__，不是 console_server —— 只查后者会让「浏览器 Cookie 登录态」这条
    鉴权路径静默失效（页面能开、API 全 401）。两个都认。
    """
    for name in ("console_server", "__main__"):
        mod = sys.modules.get(name)
        if mod is not None and hasattr(mod, "read_token") and hasattr(mod, "COOKIE"):
            return mod
    return None


def _authorized(request) -> bool:
    # 1) console 的 Cookie 登录态（浏览器）
    cs = _console_module()
    if cs is not None:
        try:
            token = request.cookies.get(cs.COOKIE, "")
            secret = request.app.get("secret")
            if token and secret and cs.read_token(token, secret):
                return True
        except Exception:
            pass
    # 2) 机器令牌：给 MCP 侧车 / 跨机 agent 用
    expected = os.environ.get("ARTIFACTS_TOKEN", "")
    if expected:
        auth = request.headers.get("Authorization", "")
        got = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not got:
            got = request.headers.get("X-Artifacts-Token", "").strip()
        if got and got == expected:
            return True
    # 3) 本机回环：SKILL.md 兜底与 localhost 侧车直接 curl
    return _remote_is_local(request)


def _guard(fn):
    @functools.wraps(fn)
    async def wrapper(request):
        if not _authorized(request):
            return _err("unauthorized", 401)
        return await fn(request)
    return wrapper


def _store_of(request):
    return request.app["artifacts_store"]


def _materializer_of(request):
    """物化器只在 mount() 时建一次，进程级单例。"""
    return request.app.get("artifacts_materializer")


def _actor_of(request) -> str:
    return request.get("user") or "reviewer"


def _review_url(request, artifact_id):
    # 成果页已经并进 PilotV 官方前端，且成果视图是应用内状态、还没有独立路由，
    # 所以评审链接只能回到应用根地址；等成果页支持深链接后再把 artifact_id 带回来。
    base = os.environ.get("CONSOLE_PUBLIC_URL")
    if not base:
        # 网关代理时 Host 会被改写成侧车自己的地址，不看转发头就会把 8799 发给人。
        host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host") or request.host
        scheme = request.headers.get("X-Forwarded-Proto") or request.scheme
        base = f"{scheme}://{host}"
    return base.rstrip("/") + "/"


def _resolve_source_path(raw: str, payload: dict):
    """把 agent 给的相对路径解析成绝对路径。

    优先级：payload.project_root > ARTIFACTS_PROJECT_ROOT > 进程 cwd。
    agent 通常在自己的项目目录里 publish 一个相对路径，必须按它的视角解析，
    否则会出现「文件明明在那儿，却报不存在」。
    """
    raw = (raw or "").strip().strip('"').strip("'")
    if not raw:
        return None
    if os.path.isabs(raw):
        return os.path.normpath(os.path.expanduser(raw))
    roots = [payload.get("project_root"), os.environ.get("ARTIFACTS_PROJECT_ROOT"), os.getcwd()]
    for root in roots:
        if not root:
            continue
        cand = os.path.normpath(os.path.join(os.path.expanduser(root), raw))
        if os.path.exists(cand):
            return cand
    return os.path.normpath(os.path.join(os.getcwd(), raw))


# --------------------------------------------------------------------- 物化队列


_PLACEHOLDER = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
<rect width="100%" height="100%" fill="#0b1020"/>
<text x="600" y="390" fill="#e9eef9" font-family="sans-serif" font-size="44" text-anchor="middle">{glyph} {title}</text>
<text x="600" y="440" fill="#98a5c3" font-family="monospace" font-size="22" text-anchor="middle">{sub}</text>
</svg>"""


def _stage_file(src_path: str, aid: str) -> dict:
    """把源文件拷进 files/，返回 create() 需要的落盘字段。

    拷一份而不是直接引用原路径：agent 可能临时目录里写个文件就删了，
    成果台必须自己握住一份，否则明天点开全是 404。
    """
    out = {"stored_path": "", "file_name": "", "mime": "", "size": 0}
    if not src_path or not os.path.isfile(src_path):
        return out
    file_name = os.path.basename(src_path)
    out["file_name"] = file_name
    out["mime"] = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    try:
        out["size"] = os.path.getsize(src_path)
    except OSError:
        out["size"] = 0
    safe = re.sub(r"[^\w.\-]+", "_", file_name)[:80]
    dst = os.path.join(DATA_DIR, "files", f"{aid}-{safe}")
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.abspath(src_path) != os.path.abspath(dst):
            shutil.copyfile(src_path, dst)
        out["stored_path"] = dst
        # 文本类留一份发布时的原件：评审在成果台里直接改之后，
        # 要能算出「人改了什么」并在返工单里交给 agent。
        import artifacts_deliver
        artifacts_deliver.keep_base_copy(src_path, dst)
    except OSError as exc:
        print(f"[artifacts] 落盘失败 {file_name}: {exc}", flush=True)
    return out


def self_store_stored_path(artifact_id: str) -> str:
    """给 Materializer 静态方法用的落盘路径查询（模块级 store）。"""
    return _store.stored_path_of(artifact_id) if _store else ""


def _png(path: str) -> str:
    """PNG 渲染器的输出后缀必须是 .png（占位图才用 .svg）。"""
    return path[:-4] + ".png" if path.endswith(".svg") else path


class Materializer:
    """后台物化队列：先发骨架卡（pending），快照好了再推 ready。

    绝不能让截图阻塞列表 —— 这是「实时」体感的第一决定因素。
    """

    def __init__(self, store):
        self.store = store
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        self._workers: list[asyncio.Task] = []
        self.failed = 0

    async def start(self):
        loop = asyncio.get_running_loop()
        for i in range(max(1, MATER_WORKERS)):
            self._workers.append(loop.create_task(self._worker(i)))

    async def stop(self):
        for t in self._workers:
            t.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers = []

    def submit(self, artifact_id):
        try:
            self.queue.put_nowait(artifact_id)
        except asyncio.QueueFull:
            # 队列满：骨架卡也别一直挂着，给占位图并放行
            self.failed += 1
            self._fail(artifact_id, RuntimeError("materialize queue full"))

    async def _worker(self, idx):
        while True:
            artifact_id = await self.queue.get()
            try:
                art = self.store.get(artifact_id, with_annotations=False)
                if not art or art["status"] == "rejected":
                    continue
                await self._render(art)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # 兜底：任何渲染异常都必须把卡片推出 pending
                self.failed += 1
                try:
                    self._fail(artifact_id, exc)
                except Exception:
                    pass
            finally:
                self.queue.task_done()

    def _fail(self, artifact_id, exc):
        """物化失败也要有图（占位图）+ ready：卡在 pending 的骨架最伤体感。"""
        thumb = os.path.join(DATA_DIR, "thumbs", f"{artifact_id}.svg")
        if not _thumb_file(artifact_id):
            try:
                self._placeholder(thumb, "!", "物化失败", str(exc)[:40])
            except Exception:
                return
        try:
            self.store.materialize_done(artifact_id, thumb_path=thumb,
                                        error=f"{type(exc).__name__}: {exc}", status="ready")
        except Exception:
            pass

    async def _render(self, art):
        art_id = art["id"]
        kind = art["kind"]
        loop = asyncio.get_running_loop()
        thumb = os.path.join(DATA_DIR, "thumbs", f"{art_id}.svg")
        meta = {}
        glyph, sub = {"page": ("▣", kind), "image": ("▤", kind), "video": ("▶", kind),
                      "drawing": ("⌗", "PDF / SVG 图纸"), "model3d": ("◈", "glb / gltf / obj / stl"),
                      "doc": ("▧", kind)}.get(kind, ("▧", kind))
        try:
            stored = self.store.stored_path_of(art_id)
        except Exception:
            stored = ""

        try:
            ext = os.path.splitext(stored or "")[1].lower()
            if kind == "drawing" and ext == ".pdf":
                # 图纸出图走 PDF：和 doc 同一条栅格化链路，别再退化成占位图
                if await loop.run_in_executor(None, self._thumb_pdf, stored, _png(thumb)):
                    thumb = _png(thumb)
                    meta = await loop.run_in_executor(None, self._probe_pdf, stored)
            elif kind in ("image", "drawing") and stored and os.path.isfile(stored):
                if await loop.run_in_executor(None, self._thumb_image, stored, _png(thumb)):
                    thumb = _png(thumb)
                    meta = await loop.run_in_executor(None, self._probe_image, thumb)
            elif kind == "video" and stored and os.path.isfile(stored):
                if await loop.run_in_executor(None, self._thumb_video, stored, _png(thumb)):
                    thumb = _png(thumb)
                    meta = await loop.run_in_executor(None, self._probe_video, stored)
            elif kind == "doc" and stored and os.path.isfile(stored):
                if await loop.run_in_executor(None, self._thumb_pdf, stored, _png(thumb)):
                    thumb = _png(thumb)
                    meta = await loop.run_in_executor(None, self._probe_pdf, stored)
            elif kind == "model3d" and stored:
                # 三维模型没有「首帧」这回事：真实渲染发生在页面里（model-viewer），
                # 缩略图只负责让左栏不至于全是灰块，所以连栅格化都不试。
                meta = {"render": "model-viewer", "ext": ext,
                        "bytes": os.path.getsize(stored)}
                if ext in (".dxf", ".dwg"):
                    meta["render_hint"] = "CAD 原生格式需要转换器；导出 PDF/SVG 再发布可直接显示"
                elif ext in (".step", ".stp", ".iges", ".igs", ".stl", ".obj", ".ply"):
                    # 这几个能转：页面打 /viewer，现转成 glb 给 model-viewer。
                    # 转换器装没装上不影响登记，所以这里只说事实，不承诺一定能显示。
                    try:
                        import artifacts_cad
                        meta["cad"] = artifacts_cad.converter_status()
                        meta["render_hint"] = "STEP/IGES/STL/OBJ/PLY 打开时转成 glb 预览"
                    except Exception as exc:
                        meta["render_hint"] = f"三维转换器不可用：{exc}"[:120]
                elif ext in (".3ds", ".dae", ".3mf"):
                    # 这几个本机没有转换器。与其让 model-viewer 静默画一块空白，
                    # 不如登记时就说明只能下载原文件。
                    meta["render_hint"] = "这个三维格式浏览器不能直接显示，先下载原文件"
            elif kind == "page":
                url = self._measure_url(art)
                if url:
                    # 真机截图：走 CDP（无 Chrome / 页面没起时降级为占位图，不阻塞 ready）
                    shot = await self._shot_page(url, art_id)
                    if shot:
                        thumb = _png(thumb)
                        shutil.copyfile(shot, thumb)
                        meta = await loop.run_in_executor(None, self._probe_image, thumb)
        except Exception as exc:
            meta["materialize_warn"] = f"{type(exc).__name__}: {exc}"[:200]

        if not _thumb_file(art_id):
            await loop.run_in_executor(None, self._placeholder, thumb, glyph,
                                       art["title"], sub)

        self.store.materialize_done(art_id, thumb_path=thumb,
                                    mime=art.get("mime") or None, meta=meta, status="ready")
        await self._reanchor(art)          # 返工新版本：旧标注要跟着元素走

    @staticmethod
    def _measure_url(art) -> str:
        """能被 CDP 打开的页面地址：优先真机 URL，其次本地 HTML 文件。"""
        live = (art.get("entry") or {}).get("html_url") or ""
        if live:
            return live
        aid = art["id"]
        stored = ""
        try:
            stored = self_store_stored_path(aid)
        except Exception:
            stored = ""
        if stored and os.path.isfile(stored) and stored.lower().endswith((".html", ".htm")):
            return "file://" + os.path.abspath(stored)
        return ""

    async def _reanchor(self, art):
        """继承来的标注按 selector 重新量坐标。

        这是成果台闭环能成立的关键：新版页面版式变了，
        标注还指着原来那个元素，而不是原来的像素位置。
        """
        aid = art["id"]
        try:
            full = self.store.get(aid, with_annotations=True)
        except Exception:
            return
        sels = [(n.get("anchor") or {}).get("selector") for n in (full or {}).get("annotations", [])]
        sels = [x for x in sels if x]
        if not sels:
            return
        url = self._measure_url(art)
        if not url:
            return
        try:
            import artifacts_cdp
            rects, page_ok = await asyncio.wait_for(
                artifacts_cdp.resolve_rects(url, sels), timeout=45)
        except Exception:
            return
        if not page_ok:
            return                     # 页面没打开 ≠ 元素没了，别误判
        self.store.reanchor(aid, rects)

    # ---- 具体渲染器（同步，跑在线程池） ----

    @staticmethod
    def _placeholder(path, glyph, title, sub):
        text = _PLACEHOLDER.format(glyph=glyph, title=title[:28], sub=sub)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)

    @staticmethod
    def _thumb_image(src, dst):
        try:
            from PIL import Image  # noqa
        except Exception:
            shutil.copyfile(src, dst)   # 无 PIL 就退化成用原图当缩略图
            return True
        from PIL import Image
        with Image.open(src) as im:
            im.thumbnail((1200, 1200))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            im.save(dst, "PNG")
        return True

    @staticmethod
    def _probe_image(path):
        try:
            from PIL import Image
            with Image.open(path) as im:
                return {"w": im.width, "h": im.height}
        except Exception:
            return {}

    @staticmethod
    def _thumb_video(src, dst):
        import subprocess
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", "1", "-i", src,
               "-frames:v", "1", "-vf", "scale='min(1200,iw)':-2", dst]
        try:
            subprocess.run(cmd, check=True, timeout=60)
            return os.path.isfile(dst)
        except Exception:
            return False

    @staticmethod
    @staticmethod
    def _probe_video(src):
        """时长/帧率/分辨率。标注要写「第几帧」，帧率只能从这里来。"""
        import artifacts_deliver
        return artifacts_deliver.probe_video(src)

    @staticmethod
    def _thumb_pdf(src, dst):
        import subprocess
        prefix = dst[:-4] + "-"
        try:
            subprocess.run(["pdftoppm", "-png", "-f", "1", "-l", "1", "-scale-to", "1200",
                            src, prefix], check=True, timeout=90)
            made = sorted(f for f in os.listdir(os.path.dirname(dst))
                          if f.startswith(os.path.basename(prefix)) and f.endswith(".png"))
            if made:
                shutil.move(os.path.join(os.path.dirname(dst), made[0]), dst)
                return True
            return False
        except Exception:
            return False

    @staticmethod
    def _probe_pdf(src):
        import subprocess
        try:
            out = subprocess.run(["pdfinfo", src], capture_output=True, text=True, timeout=30).stdout
            meta = {}
            for line in out.splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    k = k.strip().lower().replace(" ", "_")
                    if k in ("pages", "page_size"):
                        meta[k] = v.strip()
            return meta
        except Exception:
            return {}

    async def _shot_page(self, url, artifact_id):
        """真机截图（CDP）。拿不到就返回 None，由调用方落占位图。"""
        try:
            import artifacts_cdp
        except Exception:
            return None
        try:
            return await asyncio.wait_for(artifacts_cdp.screenshot(url, artifact_id), timeout=45)
        except Exception:
            return None


def _stored_path(artifact_id):
    """取落盘文件路径（files/<id>-<原名>），直接查库，不扫目录。"""
    return _store.stored_path_of(artifact_id) if _store else None


def _thumb_file(artifact_id: str) -> str:
    """缩略图真实路径（没有则空串）。

    不能按 <id>.png 拼：占位图是 SVG，用 .png 后缀骗浏览器会直接裂图
    （Content-Type 说 image/png，内容其实是 <svg ...>，img 拒收）。
    """
    if _store:
        try:
            recorded = _store.thumb_path_of(artifact_id) or ""
        except Exception:
            recorded = ""
        if recorded and os.path.isfile(recorded):
            return recorded
    for ext in (".svg", ".png"):
        cand = os.path.join(DATA_DIR, "thumbs", f"{artifact_id}{ext}")
        if os.path.isfile(cand):
            return cand
    return ""


def _sniff_image_type(path: str) -> str:
    """按文件头判断图片类型（后缀会骗人，实测 .png 里装 SVG 的老数据还在）。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(256).lstrip()
    except OSError:
        return "application/octet-stream"
    low = head[:512].lower()
    if low.startswith(b"<svg") or (low.startswith(b"<?xml") and b"<svg" in low):
        return "image/svg+xml"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"GIF8"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if b"<svg" in low:
        return "image/svg+xml"
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


# --------------------------------------------------------------------- 目录 watcher


KIND_BY_EXT = {
    ".html": "page", ".htm": "page",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".svg": "drawing", ".glb": "model3d", ".gltf": "model3d",
    ".mp4": "video", ".mov": "video", ".webm": "video",
    ".pdf": "doc", ".pptx": "doc", ".docx": "doc",
}
# 写文件过程中的临时名 / 编辑器备份：看到了也不该发
SKIP_SUFFIX = (".tmp", ".part", ".crdownload", ".swp", ".swx", "~", ".bak", ".lock")
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".DS_Store", ".cache", "dist", "build"}


def html_title(path: str) -> str:
    """从 HTML 里抠 <title> 当成果名；抠不到就回落到文件名。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(4096)
    except OSError:
        return ""
    m = re.search(r"<title[^>]*>(.*?)</title>", head, re.S | re.I)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()
        if title:
            return title[:80]
    return ""


def _env_flag(name: str, default: bool = True) -> bool:
    """读布尔开关型环境变量。没设置就用默认值。

    刻意不认「空字符串为真」：部署脚本里 `FOO=` 拼出来很容易，
    结果用户以为关掉了其实还开着，这种坑比少个开关难查得多。
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def sha1_of(path: str) -> str:
    h = hashlib.sha1()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


class Watcher:
    """盯目录：产出物一落地就自动进成果台。

    为什么用轮询不用 inotify：
        inotify 在 NFS / 网络盘 / 容器挂载上经常不触发，
        而成果目录很可能就在共享盘上。轮询 15 秒一次，代价可忽略，
        换来的是「换个环境也能用」。

    关键约束：
        * 内容哈希去重 —— 重扫一遍不会重复发；
        * 内容变了才算新版本，挂 parent_id 让标注跟着版本链继承；
        * 文件要「稳定」两轮才发布，否则读到写了一半的内容。
    """

    def __init__(self, store, submit, *, interval=15.0, min_bytes=512):
        self.store = store
        self._submit = submit            # 提交物化队列的回调
        self.interval = interval
        self.min_bytes = min_bytes
        self.dirs: list[str] = []
        self.seen: dict[str, tuple] = {}  # path -> (mtime, size, 稳定计数)
        self._task = None
        self.published = 0
        self.skipped = 0

    def add_dir(self, path: str) -> str:
        p = os.path.abspath(os.path.expanduser(path.strip()))
        if not os.path.isdir(p):
            raise ValueError(f"不是目录: {p}")
        if p not in self.dirs:
            self.dirs.append(p)
            self._prime(p)
        return p

    def remove_dir(self, path: str) -> bool:
        p = os.path.abspath(os.path.expanduser(path.strip()))
        for f in list(self.seen):
            if f.startswith(p + os.sep):
                del self.seen[f]
        if p in self.dirs:
            self.dirs.remove(p)
            return True
        return False

    def _iter_files(self, root):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for fn in filenames:
                if fn.startswith(".") or fn.endswith(SKIP_SUFFIX):
                    continue
                if os.path.splitext(fn)[1].lower() not in KIND_BY_EXT:
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                if st.st_size < self.min_bytes:
                    continue
                yield full, st

    def _prime(self, root):
        """首次登记目录：存量文件标成「这份内容已经处理过」，不回灌历史。

        这里必须打第 4 个标记（settled=True），不能拿「稳定计数=2」代替：
        计数=2 的话，下一轮 scan_once 只会把计数再加一次（→3），照样 >= 2
        就把文件发出去。实测把项目目录自动挂上以后，这一行直接把
        VICTLINK-AI / CAD 两个老项目的 5600 多个历史产物一次性倒灌进成果台，
        顺带把启动卡到健康检查超时。settled 的语义是「这份内容已经处理过了
        （登记时就在，或刚发过），除非它再变，否则别再动它」。
        """
        for full, st in self._iter_files(root):
            self.seen[full] = [st.st_mtime, st.st_size, 0, True]

    async def start(self):
        if self._task is None and self.dirs:
            self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _loop(self):
        while True:
            try:
                await self.scan_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[artifacts] watcher 扫描出错: {type(exc).__name__}: {exc}", flush=True)
            await asyncio.sleep(self.interval)

    async def scan_once(self) -> list:
        """扫一轮，返回本次新发布的成果 id 列表（测试直接调它，不等 interval）。"""
        out = []
        for root in list(self.dirs):
            for full, st in self._iter_files(root):
                stamp = (st.st_mtime, st.st_size)
                prev = self.seen.get(full)
                if prev is None or (prev[0], prev[1]) != stamp:
                    # 第一次看见 / 内容变了：先记下，不急着发（可能正写到一半）
                    self.seen[full] = [stamp[0], stamp[1], 0, False]
                    continue
                if prev[3]:
                    continue            # 这份内容已经处理过了，不重复发
                prev[2] += 1
                if prev[2] < 2:
                    continue            # 连续两轮没变才发
                self.seen[full][2] = 2
                self.seen[full][3] = True
                aid = self.ingest(full)
                if aid:
                    out.append(aid)
        return out

    def ingest(self, path: str) -> str:
        """把一个文件发成成果（内容没变就跳过）。"""
        digest = sha1_of(path)
        if not digest:
            return ""
        prev = self.store.watch_lookup(path)
        if prev and prev["sha1"] == digest:
            return ""
        parent = prev["artifact_id"] if prev else None
        name = os.path.basename(path)
        ext = os.path.splitext(name)[1].lower()
        kind = _kind_for(path, ext)
        # watcher 原来直接 POST /api/artifacts，那条路有判定、这条路没有 ——
        # 结果一次目录导入就把项目里所有 png/svg/pdf 都发成成果（真实实例上
        # 735 条里绝大多数是这么灌进来的）。这里补上判定，让 watcher 和
        # REST/MCP 走同一把尺子。
        verdict, why = _classify(kind, path)
        if verdict == "aux":
            self.skipped += 1
            print(f"[artifacts] watcher 跳过附属产物 {name}（{why}）", flush=True)
            return ""
        payload = {
            "kind": kind,
            "title": html_title(path) if ext in (".html", ".htm") else os.path.splitext(name)[0],
            "path": path,
            "agent": "watcher",
            "watch": path,
            "watch_sha1": digest,
        }
        # 推断 run_id：按源文件路径找到项目，再找该项目下"正在实时修改"的会话
        try:
            import pilotdeck_workspace as ws
            project = ws.find_project_for_path(path)
            if project:
                tree = ws.scan_projects(session_limit=20)
                for p in tree.get("projects", []):
                    if p.get("name") == project.get("name"):
                        sessions = p.get("sessions", [])
                        live = [s for s in sessions if s.get("live")]
                        target = (live or sessions)[0] if sessions else None
                        if target:
                            payload["run_id"] = target["id"]
                        break
        except Exception:
            pass
        if parent:
            payload["parent_id"] = parent
        import artifacts_store
        aid = artifacts_store.new_artifact_id()
        staged = _stage_file(path, aid)
        payload["id"] = aid
        payload.update(staged)
        payload["status"] = "pending" if staged["stored_path"] else "ready"
        try:
            art = self.store.create(payload)
        except ValueError as exc:
            print(f"[artifacts] watcher 发布失败 {name}: {exc}", flush=True)
            return ""
        self.store.watch_remember(path, digest, art["id"])
        try:
            self._submit(art["id"])
        except Exception:
            pass
        self.published += 1
        print(f"[artifacts] watcher 发布 {name} → {art['id']}"
              + (f"（v{art.get('version')}，继承 {parent} 的标注）" if parent else ""),
              flush=True)
        return art["id"]


class SessionIngester:
    """读会话 transcript，把 agent 做出来的文件自动登记成成果。

    为什么需要它（这是「成果没显示」的头号原因）：
        agent 经常把东西做完了却没登记 —— 要么它不知道有成果台，要么压根
        没调用 publish_artifact。但运行时本身**已经把这份记录写在会话里
        了**：`file_artifacts` 行逐条记着本轮动了哪些文件（名字、路径、
        操作、大小、sha256）。这份记录就躺在手边，不用重扫文件系统。

    与 Watcher 的分工（两者都留着，缺一不可）：
        Watcher      盯目录，靠「文件变了」发现问题。它能兜住远程工具
                     直接往磁盘写、运行时压根没跟踪到的文件（Blender 走
                     ssh 渲染就是这个典型），但前提是把项目目录挂上去，
                     且归属靠猜「哪个会话正在改」。
        SessionIngester 读会话自己的记录，归属**精确到 run_id**，不猜。
                     但它只认运行时跟踪过的文件。

    两边共用 store.watch_sources 去重，所以同一个文件不会被发两次。

    为什么不全交给「扫项目目录里新出现的文件」：
        一个会话顺手改个 README、建个截图、导个中间文件，都会命中目录扫描；
        而 file_artifacts 是运行时明确认定的「这轮产出」，信噪比高得多。
        宁可漏收，也不要把成果台灌成垃圾 —— 灌满了人就不看了。
    """

    # transcript 只读增量，所以这里记每个文件读到哪了
    _state: dict[str, list]

    def __init__(self, store, submit, *, interval=20.0, min_bytes=512,
                 max_files=400, max_age_days=14):
        self.store = store
        self._submit = submit
        self.interval = interval
        self.min_bytes = min_bytes
        self.max_files = max_files
        # 只有回灌历史时才生效（live 收录的东西刚生成，必然是新的）。
        # 见 start()：回灌默认关，开也要限龄，不然会把几个月前的构建产物
        # 一次性倒灌进来，把用户真正在做的成果淹掉。
        self.max_age_days = max_age_days
        self._age_limit = 0
        self._seen: dict[str, tuple] = {}   # abs_path -> (mtime, size, sha1)，避免每轮重算哈希
        self._state = {}                    # transcript 路径 -> [已读字节数]
        self._task = None
        self.published = 0
        self.skipped = 0
        self.projects_root = os.environ.get("PILOTDECK_HOME") or os.path.join(
            os.path.expanduser("~"), ".pilotdeck")

    # ---------- transcript 侧 ----------

    def _iter_transcripts(self):
        """产出 (transcript 路径, 会话 id, 会话 cwd)。"""
        root = os.path.join(self.projects_root, "projects")
        try:
            projects = sorted(os.listdir(root))
        except OSError:
            return
        for proj in projects:
            pdir = os.path.join(root, proj)
            try:
                with open(os.path.join(pdir, ".cwd"), "r", encoding="utf-8") as fh:
                    cwd = fh.read().strip()
            except OSError:
                continue          # 没有 .cwd 的不是 PilotDeck 认的项目，跳过
            if not cwd:
                continue
            chat_dir = os.path.join(pdir, "chats")
            try:
                names = sorted(os.listdir(chat_dir))
            except OSError:
                continue
            for name in names:
                if not name.endswith(".jsonl"):
                    continue
                sid = name[:-len(".jsonl")]
                if re.match(r"^always-on-(discovery|workspace|report)[:\-]", sid):
                    continue      # 内部会话，不是人看的对话
                yield os.path.join(chat_dir, name), sid, cwd

    def _read_new_rows(self, path: str):
        """增量读 transcript，返回新出现的 file_artifacts 行。

        增量是必须的：这些 jsonl 有几十 MB，每轮全读一遍光 IO 就把进程拖死了。
        只认读到 '\n' 的完整行 —— 文件尾巴那行可能正写到一半。
        """
        try:
            size = os.path.getsize(path)
        except OSError:
            return []
        off = self._state.get(path, [0])[0]
        if size < off:
            # 截断了（轮转/重建）→ 从头再来。
            # 注意是 < 不是 <=：size == off 是「这轮没有新内容」的最常见情况，
            # 用 <= 会把它误判成截断，于是每轮都从头重读几十 MB 的 transcript。
            off = 0
            self._state[path] = [0]
        if size == off:
            return []
        rows = []
        try:
            with open(path, "rb") as fh:
                fh.seek(off)
                buf = fh.read(size - off)
        except OSError:
            return []
        cut = buf.rfind(b"\n")
        if cut < 0:
            return []            # 只有半行，等下一轮
        self._state[path] = [off + cut + 1]
        for line in buf[:cut].split(b"\n"):
            line = line.strip()
            if not line or b'"file_artifacts"' not in line:
                continue          # 快筛：绝大多数行都不是它，省一次 json 解析
            try:
                row = json.loads(line.decode("utf-8", "replace"))
            except Exception:
                continue
            if row.get("type") == "file_artifacts" and row.get("artifacts"):
                rows.append(row)
        return rows

    # ---------- 产出侧 ----------

    async def scan_once(self) -> list:
        """扫一轮，返回本次新发布的成果 id 列表（测试直接调它，不等 interval）。"""
        out = []
        for path, sid, cwd in self._iter_transcripts():
            for row in self._read_new_rows(path):
                for entry in row.get("artifacts") or []:
                    aid = self.ingest(entry, sid, cwd)
                    if aid:
                        out.append(aid)
        return out

    def ingest(self, entry: dict, session_id: str, cwd: str) -> str:
        """把 transcript 里记的一条文件产出发成成果（已发过就跳过）。"""
        name = entry.get("name") or ""
        rel = entry.get("path") or name
        op = (entry.get("operation") or "").lower()
        if op == "deleted":
            return ""
        ext = os.path.splitext(name)[1].lower()
        if ext not in KIND_BY_EXT:
            return ""            # 源码/配置/临时文件，本来就不是成果
        # 扩展名级别的从属资源（.ico/.ttf/.map…）交给 _classify 统一判，
        # 别在这儿再抄一份规则 —— 抄一份就多一处会漂移的判据。

        src = rel if os.path.isabs(rel) else os.path.join(cwd, rel)
        src = os.path.abspath(src)
        try:
            st = os.stat(src)
        except OSError:
            return ""            # 运行时记了但文件已不在（临时文件），不追
        if st.st_size < self.min_bytes:
            return ""
        if self._age_limit and (time.time() - st.st_mtime) > self._age_limit:
            # 回灌时才可能触发：太老的历史产物不要倒灌进来。
            self.skipped += 1
            return ""

        kind = KIND_BY_EXT[ext]
        verdict, _why = _classify(kind, src)
        if verdict != "final":
            return ""            # 从属资源/中间产物，成果台不收

        # 内容没变就别重发。会话里同一个文件可能被反复记到。
        prev = self._seen.get(src)
        if prev and prev[0] == st.st_mtime and prev[1] == st.st_size:
            return ""
        digest = sha1_of(src)
        if not digest:
            return ""

        parent = None
        seen = self.store.watch_lookup(src)
        if seen and seen.get("sha1") == digest:
            self._seen[src] = (st.st_mtime, st.st_size, digest)
            return ""            # 已发过，且内容没变

        import artifacts_store
        aid = artifacts_store.new_artifact_id()
        payload = {
            "id": aid,
            "kind": kind,
            "title": html_title(src) or name,
            "tool": "session_ingester",
            "path": src,
            "run_id": session_id,
            "agent": "pilotdeck",
            "project": _project_of(src, {}),
        }
        if seen and seen.get("artifact_id"):
            payload["parent_id"] = seen["artifact_id"]
        staged = _stage_file(src, aid)
        payload.update(staged)
        payload["status"] = "pending" if staged["stored_path"] else "ready"
        try:
            art = self.store.create(payload)
        except ValueError as exc:
            print(f"[artifacts] 会话收录失败 {name}: {exc}", flush=True)
            return ""
        self.store.watch_remember(src, digest, art["id"])
        self._seen[src] = (st.st_mtime, st.st_size, digest)
        try:
            self._submit(art["id"])
        except Exception:
            pass
        self.published += 1
        pilotdeck_workspace_invalidate()
        print(f"[artifacts] 会话收录 {name} → {art['id']}（{session_id}）", flush=True)
        return art["id"]

    # ---------- 生命周期 ----------

    async def _loop(self):
        while True:
            try:
                await self.scan_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[artifacts] 会话收录出错: {type(exc).__name__}: {exc}", flush=True)
            await asyncio.sleep(self.interval)

    async def start(self, *, backfill: bool = True):
        if self._task is not None:
            return
        if not backfill:
            # 只看新增：把已有 transcript 标成「读到末尾」，不回灌历史。
            # 首屏就倒灌几百条历史成果，比不收还糟 —— 实测这台机器的历史
            # 里有 2452 个文件可收，但 p50 年龄 83 天、p90 618 天，多半是
            # VICTLINK-AI / CAD 两个老项目的构建产物。收进来就是噪声。
            for path, _sid, _cwd in self._iter_transcripts():
                try:
                    self._state[path] = [os.path.getsize(path)]
                except OSError:
                    pass
            self._age_limit = 0
        else:
            self._age_limit = self.max_age_days * 86400
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    def stats(self) -> dict:
        return {"published": self.published, "skipped": self.skipped,
                "tracked_transcripts": len(self._state)}


# --------------------------------------------------------------------- REST


@_guard
async def api_create(request):
    store = _store_of(request)
    try:
        payload = await request.json()
    except Exception:
        return _err("invalid json")
    if not isinstance(payload, dict):
        return _err("invalid json")
    kind = (payload.get("kind") or "").strip()
    title = (payload.get("title") or "").strip()
    if not kind or not title:
        return _err("kind 与 title 必填")

    src_path = _resolve_source_path(payload.get("path") or "", payload)

    # 需求 1：成果台只收「独立最终成果」。网页的元素截图、页面里引用的
    # 图片/图标、切片、预览图都不是成果，是成品的零件。默认直接拒掉并
    # 说明理由；发布方确实要收（比如就是要审这张中间图）就显式写
    # deliverable="aux"，那是留给它的逃生舱。
    if (payload.get("deliverable") or "").strip().lower() != "aux":
        verdict, why = _classify(kind, src_path, payload.get("deliverable"))
        if verdict == "aux":
            return _err("这不是一份独立最终成果", 409,
                        verdict="aux", reason=why, path=src_path or "",
                        hint='确实要收就加 deliverable="final" 声明它是一份独立成果；'
                             'deliverable="aux" 则是直接跳过判定')

    # 发布方通常照着扩展名把 .svg 报成 drawing（CAD 图纸那一类），而 logo 的
    # svg 到了成果页就会落进「图纸」，正是用户反馈「只看到手绘界面」的样子。
    # 只在这一种情况下纠正 —— 其余一律尊重发布方声明的 kind。
    if kind == "drawing" and os.path.splitext(src_path or "")[1].lower() == ".svg":
        remapped = _kind_for(src_path, ".svg")
        if remapped != kind:
            kind = remapped

    import artifacts_store
    # 先占 id，文件名带 id 前缀 —— 便于 _stored_path 直接定位，避免并发重名
    aid = payload.get("id") or artifacts_store.new_artifact_id()
    staged = _stage_file(src_path, aid)
    stored_path = staged["stored_path"]
    file_name, mime, size = staged["file_name"], staged["mime"], staged["size"]

    parts_meta, parts_warn = _stage_parts(aid, src_path, payload.get("parts"))

    body = dict(payload)
    body.update({
        "id": aid, "kind": kind, "title": title,
        "stored_path": stored_path, "file_name": file_name, "mime": mime, "size": size,
        "status": payload.get("status") or ("pending" if (stored_path or payload.get("url")) else "ready"),
    })
    if parts_meta:
        body["meta"] = {**(payload.get("meta") or {}), "parts": parts_meta}
    if parts_warn:
        body["meta"] = {**(body.get("meta") or {}), "parts_warn": parts_warn}
    # 多结果对比声明：写同一个 compare_group 的几份成果会整组保留在成果列表里
    # （默认每轮只留最后一份，对比组是刻意的例外 —— 收成一份等于把对比抹掉）。
    # MCP/CLI 传过来可能是数字或 list，统一 str()，别让 .strip() 抛 500。
    compare_group = str(payload.get("compare_group") or "").strip()
    if compare_group:
        body["meta"] = {**(body.get("meta") or {}), "compare_group": compare_group[:80]}
    if not (body.get("project") or "").strip():
        body["project"] = _project_of(src_path, payload)
    try:
        art = store.create(body)
    except ValueError as exc:
        return _err(str(exc))
    # 登记进 watch_sources：这张表是「哪个源文件已经发成哪个成果」的总账，
    # 自动收录（SessionIngester / Watcher）靠它去重。不记的话，同一个文件
    # 会先被人手动 publish 一次、又被自动收录再发一次，左栏出现两条一样的。
    if stored_path and os.path.isfile(src_path):
        digest = sha1_of(src_path)
        if digest:
            try:
                store.watch_remember(src_path, digest, art["id"])
            except Exception:
                pass
    # 目录树（GET /api/artifacts/workspace）带 15s 缓存。不在这里失效的话，
    # 刚发布的成果在列表接口里已经有了，左栏树里却要等十几秒才冒出来 ——
    # 需求 1 改的就是「树上该显示什么」，这条缓存直接决定用户第一眼看到什么。
    pilotdeck_workspace_invalidate()
    _mat.submit(art["id"])
    return _json({"id": art["id"], "version": art["version"],
                  "parent_id": art.get("parent_id"),
                  "status": art.get("status"),
                  "open_notes": len(store.feedback(art["id"], "open")),
                  "review_url": _review_url(request, art["id"]),
                  "artifact": art})


def _classify(kind: str, src_path: str, explicit=None):
    """需求 1 的判定入口。规则全在 artifacts_deliver.classify，这里只做转发。"""
    import artifacts_deliver
    return artifacts_deliver.classify(kind, src_path, explicit)


def _kind_for(path: str, ext: str) -> str:
    """扩展名决定类型，但品牌/标识类的 SVG 是设计稿，不是图纸。

    .svg 同时被当成图纸（CAD 导出）和设计稿（logo）两种东西，光看扩展名分不开。
    沿用 classify 的那套品牌判定：logo 落到成果页后应该出现在图片里，
    而不是被归进「图纸」—— 后者正是用户反馈「只看到手绘界面」的原因。
    """
    kind = KIND_BY_EXT.get(ext, "doc")
    if kind == "drawing" and ext == ".svg":
        import artifacts_deliver
        if artifacts_deliver.is_brand_deliverable(path):
            return "image"
    return kind


def _stage_parts(aid: str, src_path: str, inline_parts=None):
    """需求 2：主文件旁的 `<名>.parts.json`（或发布方直接传的 parts）→ 拷进成果台。

    没有清单时只对「可拆的成果」有意义，所以只给 drawing / model3d 做隐式
    根部件；图片视频天然是单件，没必要套一层只有一个叶子的树。
    """
    import artifacts_deliver
    if not artifacts_deliver.is_splittable(src_path):
        return {}, ""
    manifest = inline_parts if isinstance(inline_parts, dict) else None
    warn = ""
    if manifest is None:
        manifest, warn = artifacts_deliver.load_parts_manifest(src_path)
    if manifest is None and not warn:
        # 没有清单也要给一个隐式根部件，前端分派逻辑才只有一套
        if not src_path or not os.path.isfile(src_path):
            return {}, ""
    return artifacts_deliver.stage_parts(
        aid, src_path, manifest, os.path.join(DATA_DIR, "files")), warn


def _project_of(src_path: str, payload: dict) -> str:
    """发布时就把所属项目记下来，左栏不用每次重新猜。

    优先用 agent 自己写的 project；没写就按源文件落在哪个项目工作目录下推。
    """
    explicit = (payload.get("project") or "").strip()
    if explicit:
        return explicit
    if not src_path:
        return ""
    try:
        import pilotdeck_workspace as ws
        project = ws.find_project_for_path(src_path)
    except Exception:
        return ""
    return (project or {}).get("name") or ""


def _iter_import_files(directory: str, recursive: bool = True):
    """扫目录挑出可导入的文件（扩展名决定类型，跳过临时文件与依赖目录）。"""
    out = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in sorted(files):
            if name.startswith(".") or name.endswith(SKIP_SUFFIX):
                continue
            ext = os.path.splitext(name)[1].lower()
            kind = KIND_BY_EXT.get(ext)
            if not kind:
                continue
            out.append((os.path.join(root, name), kind))
        if not recursive:
            break
    return out


def _same_title_index(store, agent: str) -> dict:
    """同 agent 下按标题归拢已有成果，用于去重与冲突判断。"""
    idx = {}
    for art in store.list(agent=agent or None, limit=2000):
        idx.setdefault((art.get("title") or "").strip(), []).append(art)
    return idx


def _sha1_of_art(art: dict) -> str:
    return ((art.get("entry") or {}).get("meta") or {}).get("sha1") or ""


@_guard
async def api_import(request):
    """一次导一批：目录扫盘或给定清单，支持 dry-run、去重、冲突策略。

    外部 agent（opencode 之类）接成果台的主入口：契约只有 REST 一个，
    这里的语义 = N 次 api_create，但一次性汇报差异，且不重复导入同样的文件。
    """
    store = _store_of(request)
    try:
        payload = await request.json()
    except Exception:
        return _err("invalid json")
    if not isinstance(payload, dict):
        return _err("invalid json")

    agent = (payload.get("agent") or "external").strip() or "external"
    dry_run = bool(payload.get("dry_run"))
    on_conflict = (payload.get("on_conflict") or "skip").strip()
    if on_conflict not in ("skip", "version", "new"):
        return _err("on_conflict 只能是 skip / version / new")
    limit = int(payload.get("limit") or 200)

    # 1) 收候选：给 dir 就扫盘，给 items 就照单收
    candidates = []
    if payload.get("dir"):
        directory = os.path.abspath(os.path.expanduser(str(payload["dir"])))
        if not os.path.isdir(directory):
            return _err("dir 不是目录", 400, dir=directory)
        for path, kind in _iter_import_files(directory, bool(payload.get("recursive", True))):
            candidates.append({"path": path, "kind": kind,
                               "title": html_title(path) or os.path.splitext(os.path.basename(path))[0],
                               "agent": agent, "run_id": payload.get("run_id"),
                               "project": payload.get("project")})
    for item in (payload.get("items") or []):
        if not isinstance(item, dict):
            continue
        kind = (item.get("kind") or "").strip()
        src = _resolve_source_path(item.get("path") or item.get("url") or "", item)
        if not kind or not src or not os.path.isfile(src):
            candidates.append({"path": src or item.get("path") or "", "kind": kind,
                               "title": item.get("title") or "", "agent": item.get("agent") or agent,
                               "error": "路径不存在或类型缺失"})
            continue
        candidates.append({"path": src, "kind": kind,
                           "title": (item.get("title") or "").strip()
                                     or html_title(src) or os.path.splitext(os.path.basename(src))[0],
                           "agent": item.get("agent") or agent,
                           "run_id": item.get("run_id", payload.get("run_id")),
                           "project": item.get("project", payload.get("project"))})
    candidates = candidates[:limit]

    # 2) 去重 + 冲突判定：sha1 相同 = 同一份东西；标题相同内容不同 = 冲突
    by_title = _same_title_index(store, agent)
    imported, skipped, conflicts, failed = [], [], [], []
    for cand in candidates:
        title = cand["title"]
        if cand.get("error"):
            failed.append({**cand, "reason": cand["error"]})
            continue
        digest = sha1_of(cand["path"])
        # 需求 1：批量导入最容易把整个站点目录灌进来（几百张页面资源）。
        # 判定为「不是独立最终成果」的走 skipped，不进库，但给出人话理由。
        if not (payload.get("include_aux") or (cand.get("deliverable") or "").lower() == "aux"):
            verdict, why = _classify(cand["kind"], cand["path"])
            if verdict == "aux":
                skipped.append({"title": title, "path": cand["path"],
                                "reason": f"不是独立最终成果：{why}",
                                "verdict": "aux"})
                continue
        same = [a for a in by_title.get(title, []) if _sha1_of_art(a) == digest]
        if same:
            skipped.append({"title": title, "path": cand["path"], "reason": "重复导入（内容一致）",
                            "id": same[0]["id"], "version": same[0].get("version")})
            continue
        twins = by_title.get(title, [])
        if twins:
            conflict = {"title": title, "path": cand["path"],
                        "existing_id": twins[-1]["id"], "existing_version": twins[-1].get("version"),
                        "reason": "同名但内容不同"}
            conflicts.append(conflict)
            if on_conflict == "skip":
                skipped.append({"title": title, "path": cand["path"],
                                "reason": "冲突：同名不同内容（策略 skip）",
                                "id": twins[-1]["id"]})
                continue
            if on_conflict == "new":
                title = f"{title} (导入 {digest[:6]})"
                conflict["action"] = "new"
            else:
                cand["parent_id"] = twins[-1]["id"]     # 接着原成果开新版本
                conflict["action"] = "version"
        if dry_run:
            imported.append({"title": title, "path": cand["path"], "kind": cand["kind"],
                             "action": "would-import", "parent_id": cand.get("parent_id", "")})
            continue

        import artifacts_store
        aid = artifacts_store.new_artifact_id()
        staged = _stage_file(cand["path"], aid)
        parts_meta, parts_warn = _stage_parts(aid, cand["path"])
        meta = {"sha1": digest, "imported_from": payload.get("dir") or "",
                "source_path": cand["path"]}
        if parts_meta:
            meta["parts"] = parts_meta
        if parts_warn:
            meta["parts_warn"] = parts_warn
        body = {"id": aid, "kind": cand["kind"], "title": title, "agent": cand["agent"],
                "stored_path": staged["stored_path"], "file_name": staged["file_name"],
                "mime": staged["mime"], "size": staged["size"],
                "status": "pending" if staged["stored_path"] else "ready",
                "path": cand["path"], "tool": "import", "meta": meta,
                "run_id": cand.get("run_id"), "project": cand.get("project")}
        if cand.get("parent_id"):
            body["parent_id"] = cand["parent_id"]
        try:
            art = store.create(body)
        except ValueError as exc:
            failed.append({**cand, "reason": str(exc)})
            continue
        _mat.submit(art["id"])
        by_title.setdefault(title, []).append(art)
        imported.append({"title": title, "id": art["id"], "version": art["version"],
                         "kind": art["kind"], "action": "versioned" if cand.get("parent_id") else "imported",
                         "review_url": _review_url(request, art["id"])})

    if imported:
        pilotdeck_workspace_invalidate()   # 同发布：批量进来的也要立刻出现在左栏树上
    return _json({
        "dry_run": dry_run, "agent": agent, "on_conflict": on_conflict,
        "imported": imported, "skipped": skipped, "conflicts": conflicts, "failed": failed,
        "counts": {"candidates": len(candidates), "imported": len(imported),
                   "skipped": len(skipped), "conflicts": len(conflicts), "failed": len(failed)},
    })


@_guard
async def api_list(request):
    store = _store_of(request)
    q = request.query
    items = store.list(kind=q.get("kind"), status=q.get("status"), agent=q.get("agent"),
                       limit=q.get("limit", 200), offset=q.get("offset", 0))
    return _json({"artifacts": items, "total": len(items), "stats": store.stats(),
                  "agents": store.agent_counts()})


async def _backfill_video_meta(store, art) -> None:
    """视频的帧率常常缺：老成果物化时还没探 fps，后来加了也没人重跑。

    标注要写「第几帧」就必须有 fps，所以打开视频成果时按需探一次并回填 ——
    只补缺的那几个字段（duration/fps），不覆盖已经有的。
    """
    if art.get("kind") != "video":
        return
    meta = (art.get("entry") or {}).get("meta") or {}
    if meta.get("fps") and meta.get("duration"):
        return
    aid = art.get("id")
    stored = store.stored_path_of(aid) or ""
    if not stored or not os.path.isfile(stored):
        return
    import artifacts_deliver
    try:
        got = artifacts_deliver.probe_video(stored)
    except Exception:
        return
    if got and store.merge_meta(aid, got):
        art["entry"]["meta"] = {**(art.get("entry") or {}), **(
            ((art.get("entry") or {}).get("meta") or {})), **got}


@_guard
async def api_get(request):
    store = _store_of(request)
    art = store.get(request.match_info["aid"])
    if not art:
        return _err("artifact not found", 404)
    try:
        await _backfill_video_meta(store, art)
    except Exception:
        pass          # 回填失败不影响查看
    return _json(art)


@_guard
async def api_feedback(request):
    store = _store_of(request)
    aid = request.match_info["aid"]
    art = store.get(aid, with_annotations=False)
    if not art:
        return _err("artifact not found", 404)
    status = request.query.get("status", "open")
    notes = store.feedback(aid, status)
    return _json({"artifact_id": aid, "version": art["version"], "status": art["status"],
                  "count": len(notes),
                  "annotations": [{"id": n["id"], "seq": n["seq"], "severity": n["severity"],
                                   "body": n["body"], "surface": n["surface"],
                                   "anchor": n["anchor"], "carried_from": n["carried_from"],
                                   "created_at": n["created_at"]} for n in notes]})


@_guard
async def api_add_annotation(request):
    store = _store_of(request)
    aid = request.match_info["aid"]
    try:
        payload = await request.json()
    except Exception:
        return _err("invalid json")
    if not isinstance(payload, dict):
        return _err("invalid json")
    payload.setdefault("author", request.get("user") or "reviewer")
    try:
        note = store.add_annotation(aid, payload)
    except KeyError:
        return _err("artifact not found", 404)
    except ValueError as exc:
        return _err(str(exc))
    return _json({"annotation": note,
                  "artifact": store.get(aid, with_annotations=False)}, status=201)


@_guard
async def api_patch_annotation(request):
    store = _store_of(request)
    try:
        payload = await request.json()
    except Exception:
        return _err("invalid json")
    try:
        note = store.update_annotation(request.match_info["aid"],
                                       request.match_info["nid"], payload)
    except KeyError:
        return _err("annotation not found", 404)
    except ValueError as exc:
        return _err(str(exc))
    return _json({"annotation": note})


@_guard
async def api_delete_annotation(request):
    store = _store_of(request)
    aid, nid = request.match_info["aid"], request.match_info["nid"]
    if not store.get(aid, with_annotations=False):
        return _err("artifact not found", 404)
    try:
        out = store.delete_annotation(aid, nid, actor=request.get("user") or "reviewer")
    except KeyError:
        return _err("annotation not found", 404)
    out["artifact"] = store.get(aid, with_annotations=False)
    return _json(out)


@_guard
async def api_workspace(request):
    """GET /api/artifacts/workspace —— 左栏「项目目录 / 会话目录」+ 挂在下面的成果。

    左栏要和 PilotDeck 自己的项目、会话目录一致，所以这里的项目与会话不是成果台
    自己编的，而是照着 ~/.pilotdeck/projects/ 原样搬过来（见 pilotdeck_workspace.py）。
    成果台只负责把「成果」挂到对应会话底下。

    归属规则，从准到糊：
      1. agent 发布时带 run_id（就是 PilotDeck 的会话 id）→ 精确落到那个会话
      2. 没带 run_id，但成果的源文件在某个项目的工作目录下 → 落到该项目；
         项目内优先落到「正在实时修改」的会话，没有就落到最近改动的会话
      3. 两条都不满足 → 进「未归属」，保证成果不会因为归不了属就从左栏消失

    排序：live（正在实时写）的会话提到最前，其余按时间倒序 —— 打开页面第一眼
    看到的就是 agent 正在改的东西。
    """
    import artifacts_store
    import pilotdeck_workspace as ws

    store = _store_of(request)
    q = request.query
    session_limit = _int_arg(q.get("sessions"), 0, 0, 200)
    artifact_limit = _int_arg(q.get("limit"), 400, 1, 2000)

    tree = ws.scan_projects(session_limit=session_limit)
    artifacts = store.list(limit=artifact_limit)

    owner: dict = {}
    aliases: dict = {}
    project_sessions: dict = {}
    by_project: dict = {}
    for project in tree["projects"]:
        project["artifacts"] = []
        by_project[project["name"]] = project
        bucket = []
        for session in project["sessions"]:
            session["artifacts"] = []
            owner[session["id"]] = session
            aliases.setdefault(session["id"].rsplit(":", 1)[-1], []).append(session)
            bucket.append(session)
        project_sessions[project["name"]] = bucket

    unassigned = {"id": "__unassigned__", "title": "未归属", "live": False,
                  "updated_at": "", "artifacts": []}
    unassigned_project = {"name": "__unassigned__", "displayName": "未归属",
                          "fullPath": "", "pinned": False, "lastActivity": None,
                          "sessions": [unassigned],
                          "sessionMeta": {"total": 1, "hasMore": False}}

    # 成果按时间倒序分配：同一项目里最新的成果会落到最活跃的那个会话上。
    #
    # 一条成果只能进一个桶。原来这里对「按路径匹配到项目」的成果，
    # 既 append 进 project["artifacts"]（项目直属）又 append 进会话（:1180），
    # 左栏就会把同一条成果列两遍。真实数据上项目 vol3-1000-Work-00-PilotV
    # 直属 258 / 会话内也是 258 —— 整整一倍，全是重复渲染。
    # 「项目直属」现在的含义收窄为：属于本项目、但项目下一个会话都挂不上。
    for art in sorted(artifacts, key=lambda a: _ts_key(a.get("updated_at") or a.get("ts")),
                      reverse=True):
        target = None
        run_id = art.get("run_id") or ""
        if run_id and run_id in owner:
            target = owner[run_id]
        if target is None and run_id and ":" not in run_id:
            matches = aliases.get(run_id, [])
            if len(matches) == 1:
                target = matches[0]
        # An explicit owner must never drift to whichever conversation is live.
        if target is None and not run_id:
            src = (art.get("source") or {}).get("path") or art.get("stored_path") or ""
            project = ws.find_project_for_path(src) if src else None
            if project:
                sessions = project_sessions.get(project["name"]) or []
                if sessions:
                    live = [s for s in sessions if s.get("live")]
                    target = (live or sessions)[0]
                else:
                    # 项目下没有任何会话可挂，才落到「项目直属」，且到此为止
                    project["artifacts"].append(art)
                    continue
        if target is None:
            target = unassigned
            unassigned["updated_at"] = max(unassigned["updated_at"],
                                           art.get("updated_at") or art.get("ts") or "")
        target["artifacts"].append(art)

    projects = list(tree["projects"])
    if unassigned["artifacts"]:
        projects.append(unassigned_project)

    for project in projects:
        sessions = project.get("sessions") or []
        for session in sessions:
            session["artifacts"].sort(
                key=lambda a: _ts_key(a.get("updated_at") or a.get("ts")), reverse=True)
        sessions.sort(key=lambda s: (0 if s.get("live") else 1,
                                     -_ts_key(s.get("updated_at"))))
        project["live"] = any(s.get("live") for s in sessions)
    # 有正在实时会话的项目置顶；其余保持 PilotDeck 的 lastActivity 倒序（稳定排序）
    projects.sort(key=lambda p: 0 if p.get("live") else 1)

    return _json({"pilot_home": tree["pilot_home"],
                  "generated_at": artifacts_store.now_iso(),
                  "projects": projects,
                  "default_artifact_id": _default_artifact(projects),
                  "live_artifact_id": _live_artifact(projects)})


def _int_arg(raw, default, low, high):
    try:
        return max(low, min(int(raw), high))
    except (TypeError, ValueError):
        return default


_TS_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*"
    r"(Z|[+-]\d{2}:?\d{2})?$")


def _ts_key(iso) -> float:
    """ISO 串 → epoch 秒，用来排序。

    不能直接按字符串比：PilotDeck 写的是 +0800、成果库写的是 +08:00，
    同一个时刻的字典序会不同。这里统一换算成绝对时间。
    """
    import calendar
    import time as _time
    if not iso:
        return 0.0
    m = _TS_RE.match(str(iso).strip())
    if not m:
        return 0.0
    date, clock, tz = m.group(1), m.group(2), m.group(3)
    try:
        stamp = calendar.timegm(_time.strptime(f"{date} {clock}", "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return 0.0
    if tz and tz not in ("Z", "+00:00", "+0000"):
        sign = 1 if tz[0] == "+" else -1
        body = tz[1:].replace(":", "")
        stamp -= sign * (int(body[:2]) * 3600 + int(body[2:4]) * 60)
    return float(stamp)


def _first_artifact(sessions) -> str | None:
    for session in sessions or []:
        arts = session.get("artifacts") or []
        if arts:
            return arts[0]["id"]
    return None


def _live_artifact(projects) -> str | None:
    """正在实时修改的会话里，最新的那条成果。"""
    best, best_ts = None, 0.0
    for project in projects:
        for session in project.get("sessions") or []:
            if not session.get("live"):
                continue
            for art in session.get("artifacts") or []:
                ts = _ts_key(art.get("updated_at") or art.get("ts"))
                if ts > best_ts:
                    best, best_ts = art["id"], ts
    return best


def _default_artifact(projects) -> str | None:
    """默认选中：优先「正在实时修改」的最新成果，没有就回落到全局最新。"""
    return _live_artifact(projects) or _first_artifact(
        [s for p in projects for s in (p.get("sessions") or [])])


@_guard
async def api_set_status(request):
    store = _store_of(request)
    try:
        payload = await request.json()
    except Exception:
        return _err("invalid json")
    status = (payload or {}).get("status")
    try:
        art = store.set_status(request.match_info["aid"], status,
                               actor=(payload or {}).get("actor") or request.get("user") or "reviewer",
                               note=(payload or {}).get("note", ""),
                               force=bool((payload or {}).get("force")))
    except KeyError:
        return _err("artifact not found", 404)
    except ValueError as exc:
        return _err(str(exc), 409)
    return _json(art)


@_guard
async def api_dispatch(request):
    store = _store_of(request)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    try:
        out = store.dispatch(request.match_info["aid"],
                             actor=(payload or {}).get("actor") or request.get("user") or "reviewer",
                             note=(payload or {}).get("note", ""))
    except KeyError:
        return _err("artifact not found", 404)
    except ValueError as exc:
        return _err(str(exc), 409)
    return _json(out)


# ------------------------------------------------------------------ 部件树（需求 2）

@_guard
async def api_parts(request):
    """GET /api/artifacts/<id>/parts —— 这份成果能拆成哪些独立部件。

    返回的每个叶子都带 url，前端选中哪个就单独渲染、单独标注。
    标注锚点里带 part，切部件回来标注还在原位。
    """
    store = _store_of(request)
    aid = request.match_info["aid"]
    art = store.get(aid)
    if not art:
        return _err("artifact not found", 404)
    parts = ((art.get("entry") or {}).get("meta") or {}).get("parts") or {}
    if not parts:
        return _json({"artifact_id": aid, "parts": None, "note": "这份成果没有部件树"})
    return _json({"artifact_id": aid, "parts": _parts_with_urls(aid, parts)})


def _parts_with_urls(aid: str, parts: dict) -> dict:
    out = dict(parts)
    files = parts.get("files") or {}

    def walk(nodes):
        for n in nodes or []:
            if n.get("children"):
                walk(n["children"])
                continue
            stored = files.get(n.get("id"))
            n["url"] = (f"/api/artifacts/{aid}/files/{stored}"
                        if stored else f"/api/artifacts/{aid}/raw")
            n["own"] = bool(stored)
        return nodes

    out["tree"] = walk(parts.get("tree") or [])
    return out


@_guard
async def api_pdf_page(request):
    """GET /api/artifacts/<id>/pages/<n> —— PDF 第 n 页栅格化后的 PNG。

    为什么要有这个：<object>/<embed> 里放 PDF，浏览器没有内置 PDF 插件时
    就是一个黑框（用户报「图纸选中了是黑矩形」）。服务端栅格化成图片后，
    前端用 <img> 显示，和普通图片走同一套标注坐标。
    """
    import artifacts_deliver
    store = _store_of(request)
    aid = request.match_info["aid"]
    try:
        page = max(1, int(request.match_info.get("page") or 1))
    except (TypeError, ValueError):
        return _err("页码不是整数", 400)
    art = store.get(aid, with_annotations=False)
    if not art:
        return _err("artifact not found", 404)
    # stored_path 是刻意不外泄的服务端绝对路径，公开 JSON 里没有；
    # 内部统一走 stored_path_of，别去公开字典里捞（捞不到就永远 400）。
    stored = store.stored_path_of(aid) or ""
    if not stored or os.path.splitext(stored)[1].lower() != ".pdf":
        return _err("这份成果不是 PDF，没有可栅格化的页", 400)
    if not os.path.isfile(stored):
        return _err("成果文件不在库里（可能已被清理）", 404)
    dst = os.path.join(DATA_DIR, artifacts_deliver.PDF_PAGE_DIR, f"{aid}-{page}.png")
    loop = asyncio.get_running_loop()
    try:
        ok = await loop.run_in_executor(
            None, artifacts_deliver.rasterize_pdf_page, stored, page, dst)
    except RuntimeError as exc:
        return _err(str(exc), 503, reason="raster_unavailable")
    except ValueError as exc:
        return _err(str(exc), 422, reason="raster_failed")
    if not ok:
        return _err("PDF 栅格化没产出图片", 500)
    return web.FileResponse(dst, headers={
        "Content-Type": "image/png",
        "Content-Length": str(os.path.getsize(dst)),
        "Cache-Control": "private, max-age=300",
        "X-Pdf-Page": str(page),
    })


@_guard
async def api_part_pdf_page(request):
    """GET /api/artifacts/<id>/part-pages/<name>/<n> —— 部件 PDF 第 n 页的 PNG。

    多部件图纸集里每张图都是 PDF，走的是部件而不是主文件，所以上面那条
    主文件路由够不着，必须单独给部件开一条，否则「选了部件还是黑框」。
    """
    import artifacts_deliver
    aid = request.match_info["aid"]
    name = request.match_info.get("name") or ""
    path = artifacts_deliver.part_file(aid, name, os.path.join(DATA_DIR, "files"))
    if not path:
        return _err("部件文件不存在", 404)
    if os.path.splitext(path)[1].lower() != ".pdf":
        return _err("这个部件不是 PDF", 400)
    try:
        page = max(1, int(request.match_info.get("page") or 1))
    except (TypeError, ValueError):
        return _err("页码不是整数", 400)
    dst = os.path.join(DATA_DIR, artifacts_deliver.PDF_PAGE_DIR, f"{aid}-{name}-{page}.png")
    loop = asyncio.get_running_loop()
    try:
        ok = await loop.run_in_executor(
            None, artifacts_deliver.rasterize_pdf_page, path, page, dst)
    except RuntimeError as exc:
        return _err(str(exc), 503, reason="raster_unavailable")
    except ValueError as exc:
        return _err(str(exc), 422, reason="raster_failed")
    if not ok:
        return _err("PDF 栅格化没产出图片", 500)
    return web.FileResponse(dst, headers={
        "Content-Type": "image/png",
        "Content-Length": str(os.path.getsize(dst)),
        "Cache-Control": "private, max-age=300",
    })


@_guard
async def api_part_file(request):
    """GET /api/artifacts/<id>/files/<name> —— 单个部件文件。"""
    import artifacts_deliver
    aid = request.match_info["aid"]
    name = request.match_info.get("name") or ""
    path = artifacts_deliver.part_file(aid, name, os.path.join(DATA_DIR, "files"))
    if not path:
        return _err("部件文件不存在", 404)
    size = os.path.getsize(path)
    rng = request.headers.get("Range", "")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip()) if rng else None
    if not m:
        return web.FileResponse(path, headers={
            "Content-Type": mimetypes.guess_type(path)[0] or "application/octet-stream",
            "Content-Length": str(size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=60",
        })
    start = int(m.group(1) or 0)
    end = int(m.group(2)) if m.group(2) else size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return web.Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    chunk = size - start if end - start + 1 == size else end - start + 1
    with open(path, "rb") as fh:
        fh.seek(start)
        data = fh.read(chunk)
    return web.Response(body=data, status=206, headers={
        "Content-Type": mimetypes.guess_type(path)[0] or "application/octet-stream",
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
    })


# ------------------------------------------------------------------ 文本就地编辑（需求 4）

@_guard
async def api_get_text(request):
    """GET /api/artifacts/<id>/text —— 取成果台副本的文本，供就地编辑。"""
    import artifacts_deliver
    aid = request.match_info["aid"]
    path = _stored_path(aid)
    if not path or not os.path.isfile(path):
        return _err("这份成果没有可编辑的文件", 404)
    why = artifacts_deliver.editable_reason(path)
    if why:
        return _err(why, 415)
    try:
        text = artifacts_deliver._read_text(path)
    except OSError as exc:
        return _err(f"读不出来：{exc}", 500)
    return _json({"artifact_id": aid, "text": text, "bytes": len(text.encode("utf-8")),
                  "changed": artifacts_deliver.text_diff(path)})


@_guard
async def api_put_text(request):
    """PUT /api/artifacts/<id>/text —— 保存改好的文本，只动成果台副本。

    刻意不回写原项目文件：评审改的是「审这一版」，不是替 agent 改代码。
    改动会被 diff 记账，点「应用 AI 修改」时连同标注一起交回 agent。
    """
    import artifacts_deliver
    store = _store_of(request)
    aid = request.match_info["aid"]
    art = store.get(aid)
    if not art:
        return _err("artifact not found", 404)
    path = _stored_path(aid)
    if not path or not os.path.isfile(path):
        return _err("这份成果没有可编辑的文件", 404)
    why = artifacts_deliver.editable_reason(path)
    if why:
        return _err(why, 415)
    try:
        payload = await request.json()
    except Exception:
        return _err("invalid json")
    text = (payload or {}).get("text")
    if not isinstance(text, str):
        return _err("text 必填，且必须是字符串")
    try:
        info = artifacts_deliver.write_text(path, text)
    except FileNotFoundError:
        return _err("副本文件不见了", 404)
    except artifacts_deliver.EmptyText as exc:
        return _err(str(exc), 400)
    except ValueError as exc:
        return _err(str(exc), 413)
    changed = artifacts_deliver.text_diff(path)
    store.patch_meta(aid, {"edited": True, "edited_at": info["edited_at"],
                           "edited_sha1": info["sha1"],
                           "edited_delta": {"added": changed.get("added", 0),
                                            "removed": changed.get("removed", 0)}},
                     event="artifact.updated", actor=(payload or {}).get("actor") or "reviewer",
                     size=info["bytes"])
    pilotdeck_workspace_invalidate()
    return _json({"ok": True, "artifact_id": aid, "bytes": info["bytes"],
                  "changed": changed,
                  "note": "已保存到成果台副本；原项目文件未改动，应用时会连同标注交给 agent"})


def pilotdeck_workspace_invalidate():
    try:
        import pilotdeck_workspace as ws
        ws.invalidate()
    except Exception:
        pass


# ------------------------------------------------------------------ 应用返工（需求 5）

@_guard
async def api_apply(request):
    """POST /api/artifacts/<id>/apply —— 把标注/编辑成果送到「原项目 + 对应会话 + agent」。

    三条通道各自独立成败，明确汇报哪条通了：
      · 原项目目录：按会话分文件夹写返工单（人可直接翻）
      · 对应会话：排进 PilotDeck 的会话输入队列（对话里能看见）
      · agent：走既有 dispatch，唤醒挂着 wait_artifact_rework 的 agent
    """
    import artifacts_deliver
    import pilotdeck_workspace as ws
    store = _store_of(request)
    aid = request.match_info["aid"]
    actor = request.get("user") or "reviewer"
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    art = store.get(aid, with_annotations=True)
    if not art:
        return _err("artifact not found", 404)
    notes = store.feedback(aid, "open")
    if not notes and not (payload or {}).get("force"):
        return _err("没有待处理的标注，没什么可交给 agent", 409,
                    hint="确认要空跑一次就带 force=true")

    stored = _stored_path(aid) or ""
    text_change = artifacts_deliver.text_diff(stored) if stored else {"edited": False}
    order = artifacts_deliver.build_rework_order(
        art, notes, actor=actor, text_change=text_change, stored_path=stored)
    order["artifact"] = dict(art, _stored_path=stored)

    tree = ws.scan_projects(session_limit=50)
    res = artifacts_deliver.resolve_session(tree["projects"], art.get("run_id"),
                                            art.get("project"))
    channels = {}
    if not res.get("ok"):
        channels["project_dir"] = {"ok": False, "reason": res.get("reason") or "没归到项目"}
        channels["session_queue"] = {"ok": False, "reason": res.get("reason") or "没归到会话"}
    else:
        pdir = res.get("project_dir") or ""
        channels["project_dir"] = artifacts_deliver.write_rework_order(
            pdir, res.get("session_id") or "unassigned", aid, order)
        sid = res.get("session_id") or ""
        if not sid:
            channels["session_queue"] = {"ok": False, "reason": "项目里还没有会话"}
        elif channels["project_dir"].get("ok"):
            preview = _order_preview(order)
            channels["session_queue"] = artifacts_deliver.enqueue_session_input(
                res.get("slug") or "", sid,
                {"id": f"art-{aid}-{time.strftime('%Y%m%d%H%M%S')}",
                 "command": preview,
                 "displayText": f"成果返工：{art.get('title')}（{len(notes)} 条意见）",
                 "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S+0800"),
                 "status": "queued",
                 "options": {"projectPath": pdir, "providerHint": "artifacts-console",
                             "artifactsArtifactId": aid, "artifactsProject": art.get("project") or ""}},
                os.environ.get("PILOTDECK_HOME") or os.path.expanduser("~/.pilotdeck"))
        else:
            channels["session_queue"] = {"ok": False,
                                         "reason": channels["project_dir"].get("reason", "返工单没落成")}

    try:
        dispatched = store.dispatch(aid, actor=actor,
                                    note=(payload or {}).get("note") or
                                    f"成果台应用：{len(notes)} 条意见")
        channels["agent_wake"] = {"ok": True, "notes": len(dispatched["feedback"])}
    except (KeyError, ValueError) as exc:
        channels["agent_wake"] = {"ok": False, "reason": str(exc)}

    # PilotDeck 的 pending-inputs 是「一次性载入」的旁挂文件：运行中的会话
    # 不会重读它（sessionState.queueLoaded 一旦置位就不再读），所以这条通道
    # 是交接而不是即时送达。这里如实说明，别让界面把「写进去了」说成
    # 「agent 已经在处理」。真正即时的唤醒是第三条 wait_artifact_rework。
    if channels["session_queue"].get("ok"):
        channels["session_queue"]["note"] = "已交接；运行中的会话不会即时重读，重启或新开会话后可见"

    landed = [k for k, v in channels.items() if v.get("ok")]
    store.record_apply(aid, {"channels": channels, "project": art.get("project"),
                             "session_id": res.get("session_id", "")}, actor=actor)
    return _json({"ok": bool(landed), "artifact_id": aid, "notes": len(notes),
                  "text_changed": bool(text_change.get("edited")),
                  "channels": channels, "session_id": res.get("session_id", ""),
                  "exact_session": bool(res.get("exact"))})


def _order_preview(order: dict) -> str:
    """排进会话队列的正文：短、完整、可执行，返工单全文留在原项目目录。"""
    md = order.get("markdown") or ""
    head = md.split("## 逐条意见")[0].strip()
    body = ("## 逐条意见" + md.split("## 逐条意见")[1]).strip() if "## 逐条意见" in md else ""
    return (head + "\n\n" + body).strip()


@_guard
async def api_watch(request):
    """GET/POST/DELETE /api/artifacts/watch —— 目录 watcher 的开关。

    监控目录也可以用环境变量 ARTIFACTS_WATCH_DIRS 一次性配好（分号分隔）。
    """
    watcher = request.app.get("artifacts_watcher")
    if watcher is None:
        return _err("watcher 没启动", 409)
    if request.method == "GET":
        return _json({"dirs": list(watcher.dirs), "published": watcher.published})
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    path = ((payload or {}).get("path") or request.query.get("path") or "").strip()
    if not path:
        return _err("path 必填")
    if request.method == "DELETE":
        ok = watcher.remove_dir(path)
        return _json({"ok": ok, "dirs": list(watcher.dirs)})
    try:
        added = watcher.add_dir(path)
    except ValueError as exc:
        return _err(str(exc))
    await watcher.start()
    return _json({"ok": True, "dir": added, "dirs": list(watcher.dirs)})


@_guard
async def api_reanchor(request):
    """POST /api/artifacts/{id}/reanchor —— 手动触发重新锚定。

    自动锚定在新版本物化时就跑过了；这个入口是给「页面后来又改了」
    或「截图当时没打开」时人工兜底用的。
    """
    aid = request.match_info["aid"]
    store = _store_of(request)
    art = store.get(aid, with_annotations=True)
    if not art:
        return _err("artifact not found", 404)
    mat = _materializer_of(request)
    if mat is None:
        return _err("物化器没启动", 409)
    url = mat._measure_url(art)
    if not url:
        return _err("这份成果没有可测量的页面地址", 409,
                    hint="page 类成果需要 html_url，或上传 .html 文件")
    sels = [(n.get("anchor") or {}).get("selector") for n in art.get("annotations", [])]
    sels = [x for x in sels if x]
    if not sels:
        return _json({"ok": True, "moved": [], "missing": [], "kept": [],
                      "note": "没有带 selector 的标注，无需重新锚定"})
    try:
        import artifacts_cdp
        rects, page_ok = await asyncio.wait_for(
            artifacts_cdp.resolve_rects(url, sels), timeout=60)
    except Exception as exc:
        return _err(f"锚定失败: {type(exc).__name__}: {exc}", 502)
    if not page_ok:
        return _err("页面没打开，没法重新锚定（坐标保持原样）", 502, url=url)
    result = store.reanchor(aid, rects, actor=_actor_of(request))
    result.update({"ok": True, "url": url, "checked": len(sels)})
    return _json(result)


@_guard
async def api_chain(request):
    store = _store_of(request)
    aid = request.match_info["aid"]
    chain = store.chain(aid)
    if not chain:
        return _err("artifact not found", 404)
    return _json({"artifact_id": aid, "chain": chain,
                  "diff": _chain_diff(chain)})


def _text_of(art):
    """取出成果的源码文本（只认小体积的文本类文件）。

    大文件 / 二进制不进 diff —— 对比视频的字节没有意义，
    只比标注和状态，那才是评审真正在意的东西。
    """
    path = _stored_path(art["id"])
    if not path or not os.path.isfile(path):
        return ""
    mime = (art.get("mime") or "").lower()
    name = os.path.basename(path).lower()
    textual = mime.startswith("text/") or mime in (
        "application/json", "application/javascript", "application/xml") or \
        name.endswith((".html", ".htm", ".json", ".md", ".txt", ".js", ".css", ".svg"))
    if not textual:
        return ""
    try:
        if os.path.getsize(path) > 400_000:
            return ""
        return open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


def _source_diff(a_text, b_text):
    if not a_text or not b_text:
        return {"available": False, "reason": "没有可比对的文本源码"}
    import difflib
    lines = list(difflib.unified_diff(a_text.splitlines(), b_text.splitlines(),
                                      lineterm="", n=2))
    added = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
    return {"available": True, "added": added, "removed": removed,
            "hunks": lines[:400], "truncated": len(lines) > 400}


def _pair_diff(from_art, to_art):
    """两版之间的完整差异：状态 + 标注 + 源码。"""
    p_all = {n["id"]: n for n in (from_art.get("annotations") or [])}
    c_all = {n["id"]: n for n in (to_art.get("annotations") or [])}
    carried = set()
    resolved, kept, dropped, fresh = [], [], [], []
    for nid, cur in c_all.items():
        origin = cur.get("carried_from") or ""
        carried.add(origin)
        prev = p_all.get(origin or nid)
        if origin and origin in p_all:
            if cur["status"] == "resolved":
                resolved.append({"seq": cur["seq"], "body": cur["body"],
                                 "severity": cur.get("severity", "minor")})
            else:
                kept.append({"seq": cur["seq"], "body": cur["body"]})
        else:
            fresh.append({"seq": cur["seq"], "body": cur["body"],
                          "severity": cur.get("severity", "minor")})
    for nid, prev in p_all.items():
        if prev["status"] == "open" and nid not in carried:
            dropped.append({"seq": prev["seq"], "body": prev["body"]})

    return {
        "from": {"id": from_art["id"], "version": from_art["version"],
                 "status": from_art["status"], "title": from_art["title"],
                 "created_at": from_art.get("created_at")},
        "to": {"id": to_art["id"], "version": to_art["version"],
               "status": to_art["status"], "title": to_art["title"],
               "created_at": to_art.get("created_at")},
        "status_changed": from_art["status"] != to_art["status"],
        "resolved": resolved,
        "kept_open": kept,
        "new_notes": fresh,
        "dropped_open": dropped,
        "counts": {"from": len(p_all), "to": len(c_all),
                   "resolved": len(resolved), "fresh": len(fresh),
                   "dropped": len(dropped)},
        "source": _source_diff(_text_of(from_art), _text_of(to_art)),
    }


@_guard
async def api_diff(request):
    store = _store_of(request)
    aid = request.match_info["aid"]
    to_id = request.query.get("to") or aid
    from_id = request.query.get("from")
    if not from_id:
        # 默认跟同链上一版比；只有一版就跟自己比（前端照样显示「无差异」）
        chain = store.chain(aid)
        if not chain:
            return _err("artifact not found", 404)
        idx = next((i for i, a in enumerate(chain) if a["id"] == aid), 0)
        from_id = chain[idx - 1]["id"] if idx > 0 else chain[idx]["id"]
    a_from = store.get(from_id)
    a_to = store.get(to_id)
    if not a_from or not a_to:
        return _err("对比的版本不存在", 404)
    same_chain = a_from["id"] in {x["id"] for x in store.chain(a_to["id"])}
    return _json({"same_chain": same_chain, "diff": _pair_diff(a_from, a_to),
                  "audit": store.audit_entries(to_id, limit=40)})


@_guard
async def api_wait_rework(request):
    """长轮询等返工：agent 交付完调用一次，评审一提交就立刻拿到清单。

    没有运行时 hook 能从外部把消息塞进会话，「自动唤醒」就只能让 agent
    主动挂着等 —— 服务端长轮询 + 事件唤醒，比 agent 自己 sleep 轮询省事得多。
    """
    store = _store_of(request)
    aid = request.query.get("aid", "")
    try:
        timeout = max(1, min(int(request.query.get("timeout", 25)), 120))
    except ValueError:
        timeout = 25
    bus = store.bus
    start_seq = bus.last_id
    since = request.query.get("since", "")
    # 进来先看一眼：返工可能在你排队之前就发生了。
    # 但只有点名了 id（或给了 since）才回看存量 —— 不点名时的语义是「等下一件」，
    # 否则半年前的返工积压会把你刚交付完就立刻叫醒，等于白等。
    hits = _rework_hits(store, aid, since, request) if (aid or since) else []
    if hits:
        return _json({"woke": True, "rework": hits})

    q = bus.subscribe(start_seq)
    deadline = asyncio.get_running_loop().time() + timeout
    try:
        while True:
            left = deadline - asyncio.get_running_loop().time()
            if left <= 0:
                return _json({"woke": False, "timeout": timeout,
                              "hint": "没有新返工，可以先去干别的"})
            try:
                eid, event, payload = await asyncio.wait_for(q.get(), timeout=left)
            except asyncio.TimeoutError:
                return _json({"woke": False, "timeout": timeout})
            if event != "artifact.dispatched":
                continue
            if aid and payload.get("artifact_id") != aid:
                continue
            art_id = payload.get("artifact_id")
            return _json({"woke": True, "rework": _rework_hits(store, art_id, "", request)})
    finally:
        bus.unsubscribe(q)


def _rework_hits(store, aid, since, request=None):
    """捞出返工中的成果 + 未解决标注清单。"""
    out = []
    rows = [store.get(aid)] if aid else store.rework_queue()
    for art in rows:
        if not art or art["status"] != "rework":
            continue
        if since and (art.get("updated_at") or "") < since:
            continue
        out.append({"artifact_id": art["id"], "title": art["title"],
                    "version": art["version"], "status": art["status"],
                    "review_url": _review_url(request, art["id"]),
                    "feedback": store.feedback(art["id"], "open")})
    return out


def _chain_diff(chain):
    """相邻版本的标注差异（M3：改了什么、哪些意见还在）。"""
    diffs = []
    for prev, cur in zip(chain, chain[1:]):
        p_open = {n["id"]: n for n in prev["annotations"] if n["status"] == "open"}
        c_open = {n["id"]: n for n in cur["annotations"] if n["status"] == "open"}
        resolved = [n for n in cur["annotations"]
                    if n["status"] == "resolved" and n.get("carried_from") in p_open]
        added = [n for n in c_open.values() if not n.get("carried_from")]
        diffs.append({
            "from": prev["id"], "to": cur["id"],
            "from_version": prev["version"], "to_version": cur["version"],
            "resolved": [{"seq": n["seq"], "body": n["body"]} for n in resolved],
            "added": [{"seq": n["seq"], "body": n["body"]} for n in added],
            "still_open": len(c_open),
        })
    return diffs


@_guard
async def api_audit(request):
    store = _store_of(request)
    aid = request.match_info.get("aid") or request.query.get("aid")
    return _json({"artifact_id": aid,
                  "audit": store.audit_entries(aid, request.query.get("limit", 100))})


@_guard
async def api_thumb(request):
    aid = request.match_info["aid"]
    path = _thumb_file(aid)
    if not path:
        return _err("thumb not ready", 404)
    headers = {"Content-Type": _sniff_image_type(path)}
    if not request.query.get("raw"):
        headers["Cache-Control"] = "public, max-age=60"
    return web.FileResponse(path, headers=headers)


@_guard
async def api_raw(request):
    aid = request.match_info["aid"]
    path = _stored_path(aid)
    if not path or not os.path.isfile(path):
        return _err("file not found", 404)
    size = os.path.getsize(path)
    rng = request.headers.get("Range", "")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip()) if rng else None
    if not m:
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if mime in ("text/html", "application/xhtml+xml"):
            return _html_with_base(aid, path)
        return web.FileResponse(path, headers={
            "Content-Type": mime,
            "Accept-Ranges": "bytes",
            "Content-Disposition": f'inline; filename="{os.path.basename(path)}"',
        })
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "":
        length = int(end_s or 0)
        start = max(0, size - length)
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return web.Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    length = end - start + 1
    with open(path, "rb") as fh:
        fh.seek(start)
        chunk = fh.read(length)
    return web.Response(status=206, body=chunk, headers={
        "Content-Type": mimetypes.guess_type(path)[0] or "application/octet-stream",
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    })


@_guard
async def api_viewer(request):
    """GET /api/artifacts/<id>/viewer —— 给 model-viewer 用的 glTF。

    STEP/IGES/STL/OBJ/PLY 这类格式 model-viewer 根本认不出来，喂进去是一块空白。
    这里现转成 GLB 再回给页面，转好的按源文件摘要缓存：同一份成果反复打开只转
    一次，返工发了新版本（内容变了、摘要也变）自动吃新的，不会拿到旧网格。

    其他成果原样回传，这样调用方可以把 /viewer 当成「一定能显示的那一份」
    直接喂给三维渲染器，不必自己在前端按扩展名分叉。
    """
    import artifacts_cad
    aid = request.match_info["aid"]
    path = _stored_path(aid)
    if not path or not os.path.isfile(path):
        return _err("file not found", 404)
    if not artifacts_cad.needs_conversion(path):
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        return web.FileResponse(path, headers={"Content-Type": mime, "Accept-Ranges": "bytes"})

    loop = asyncio.get_running_loop()
    try:
        out = await loop.run_in_executor(None, artifacts_cad.convert, path)
    except artifacts_cad.CadUnavailable as exc:
        # 这台机器没装转换器：如实说，别返回空白 GLB 让人以为模型是空的。
        return _err(str(exc), 503,
                    hint="在这台机器上装一次即可："
                         "python3 -m venv .artifacts-data/venvs/cad && "
                         ".artifacts-data/venvs/cad/bin/pip install cadquery-ocp vtk")
    except artifacts_cad.CadError as exc:
        return _err(str(exc), 422, hint="可以先用 CAD 软件导出 glb/stl 再发布，或下载原文件")
    return web.FileResponse(out["path"], headers={
        "Content-Type": "model/gltf-binary",
        # 缓存文件名带源文件内容摘要，内容不变就是同一个文件，可以放心长缓存。
        "Cache-Control": "public, max-age=86400, immutable",
    })


_BASE_TAG_RE = re.compile(r"<base\b", re.I)

def _html_with_base(aid: str, path: str):
    """给 HTML 成果的正文注入 base，好让 iframe 里的相对素材能取到。

    为什么要注入：iframe 打开的是 /api/artifacts/{id}/raw，浏览器会把页面里的
    "concepts/a.svg" 解析成 /api/artifacts/{id}/concepts/a.svg，而素材其实在
    成果的来源目录里。指到 file 路由后，相对路径才落在正确的地方。

    页面自己写了 <base> 就不动它 —— 作者的意图优先。
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            html = handle.read()
    except OSError:
        return _err("file not found", 404)
    if _BASE_TAG_RE.search(html):
        html, changed = html, False
    else:
        tag = f'<base href="/api/artifacts/{aid}/file/">'
        match = re.search(r"<head\b[^>]*>", html, re.I)
        if match:
            html, changed = html[:match.end()] + tag + html[match.end():], True
        else:
            html, changed = tag + html, True
    return web.Response(text=html, content_type="text/html", charset="utf-8", headers={
        "Accept-Ranges": "none",
        "Content-Disposition": f'inline; filename="{os.path.basename(path)}"',
        "Cache-Control": "no-cache",
        # 成果 HTML 是用户上传 / 智能体生成的，正文完全不受控。这份响应会被
        # 成果台用 iframe 直接打开，而 iframe 的 URL 是同源的
        # /api/artifacts/{id}/raw —— 不隔离的话，成果里的 <script> 就能以
        # PilotV 的身份跑，直接调成果 API、读会话数据。
        #
        # CSP 的 sandbox 指令把这份文档放进「不透明源」，即使前端哪天漏了
        # iframe sandbox 属性也照样拦住；nosniff 挡住 MIME 嗅探绕过。
        # 两者都是响应头，不依赖前端是否正确渲染。
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
            "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    })


@_guard
async def api_sibling_file(request):
    """HTML 成果用 iframe 打开时，页面里的相对路径要能取到同目录的素材。

    `<img src="lockups/a.svg">` 在 /api/artifacts/{aid}/raw 下会解析成
    /api/artifacts/{aid}/lockups/a.svg。没有这条路由，成果页打开就是白页加一串 404。

    边界：只读、只给成果自己所在的那一层目录、点文件不提供。目录穿越一律 404 ——
    这条路由挂在对外的服务上，不能变成任意文件下载器。
    """
    aid = request.match_info["aid"]
    rel = urllib.parse.unquote(request.match_info.get("relpath", "") or "")
    if not rel or rel.startswith("/") or "\x00" in rel:
        return _err("file not found", 404)
    record = _store.get(aid) if _store else None
    if not record:
        return _err("file not found", 404)
    # 素材要回到成果的来源目录找，不是成果库里的副本目录 ——
    # 发布时 HTML 被复制进了 files/，同目录的 SVG 还留在项目里。
    source = record.get("source") or {}
    origin = _resolve_source_path(source.get("path") or "", {})
    if not origin or not os.path.isfile(origin):
        return _err("file not found", 404)
    root = os.path.dirname(os.path.realpath(origin))
    target = os.path.realpath(os.path.join(root, rel))
    if target != root and not target.startswith(root + os.sep):
        return _err("file not found", 404)
    parts = rel.replace("\\", "/").split("/")
    if any(part.startswith(".") for part in parts if part):
        return _err("file not found", 404)
    if not os.path.isfile(target):
        return _err("file not found", 404)
    return web.FileResponse(target, headers={
        "Content-Type": mimetypes.guess_type(target)[0] or "application/octet-stream",
        "Cache-Control": "public, max-age=60",
    })


@_guard
async def api_events(request):
    store = _store_of(request)
    try:
        last_id = int(request.headers.get("Last-Event-ID")
                      or request.query.get("last_event_id") or 0)
    except ValueError:
        last_id = 0
    q = store.bus.subscribe(last_id)
    resp = web.StreamResponse(status=200, headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
    await resp.prepare(request)
    try:
        await resp.write(b": artifacts stream connected\n\n")
        while True:
            try:
                eid, event, data = await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                await resp.write(b": ping\n\n")
                continue
            payload = json.dumps(data, ensure_ascii=False)
            await resp.write(f"id: {eid}\nevent: {event}\ndata: {payload}\n\n".encode("utf-8"))
    except (asyncio.CancelledError, ConnectionResetError, ConnectionError):
        pass
    finally:
        store.bus.unsubscribe(q)
    return resp


@_guard
async def api_health(request):
    store = _store_of(request)
    return _json({"ok": True, "data_dir": DATA_DIR, "stats": store.stats(),
                  "materialize_queue": _mat.queue.qsize() if _mat else 0})


@_guard
async def api_notify_status(request):
    """IM 推送通道状态：配没配、送到第几条、最近一次结果。

    同样要鉴权：status() 会把 webhook 的主机名（哪个 IM 服务、最近报了什么错）
    一并吐出来，那是内部设施信息，不该给没登录的人看。
    """
    notifier = request.app.get("artifacts_notifier")
    if notifier is None:
        return _json({"ok": False, "error": "notifier not mounted"}, status=503)
    return _json({"ok": True, **notifier.status()})


@_guard
async def api_notify_test(request):
    """手动发一条测试消息，用来验 webhook 配没配对。

    必须鉴权：这条路由会把调用方给的文本经 webhook 原样发出去。漏了 @_guard
    就等于开了一个匿名消息发送器 —— 任何能连上服务的人都能借这个 webhook
    往群里刷任意内容。
    """
    notifier = request.app.get("artifacts_notifier")
    if notifier is None:
        return _json({"ok": False, "error": "notifier not mounted"}, status=503)
    if not notifier.enabled:
        return _json({"ok": False, "error": "未配置 ARTIFACTS_NOTIFY_WEBHOOK"}, status=400)
    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    text = (body.get("text") or "[成果台] 通道测试：这条是手动发的，配置是通的 ✓").strip()
    if len(text) > 500:
        return _err("测试文本过长", 400)
    ok = notifier.send_now(text)
    return _json({"ok": ok, "text": text, **notifier.status()},
                 status=200 if ok else 502)


# --------------------------------------------------------------------- 设置（口令）

PASSWORD_MIN = 10          # 与 console 登录口令同一档；太短在 scrypt 面前只是心理安慰


def _console_user_of(request):
    """当前网页登录用户（只认 Cookie）。

    刻意不走 _authorized()：那条路也放行 Bearer 令牌和回环豁免，而改登录口令是
    高危动作 —— 任何持有 token 的 agent、任何能直连 127.0.0.1 的进程都能进来改。
    这里只用 console 签的 Cookie 认人，改谁的口令由 Cookie 决定，不接受 body 传用户名。
    """
    cs = _console_module()
    if cs is None:
        return None
    token = request.cookies.get(getattr(cs, "COOKIE", "pdc_console"), "")
    secret = request.app.get("secret")
    if not token or not secret:
        return None
    try:
        return cs.read_token(token, secret)
    except Exception:      # 老的会话密钥解不开就算了，当未登录
        return None


@_guard
async def api_me(request):
    """设置面板要显示的东西：当前账号、这口会话是怎么进来的、有没有配 API token。

    只返回「有没有」，绝不回显 token / 会话密钥本身 —— 页面是公开空壳（见
    _open_page_assets），回显等于把钥匙挂在门上。
    """
    user = _console_user_of(request)
    if not user:
        return _err("需要先用网页登录", 401)
    store = _store_of(request)
    return _json({
        "ok": True,
        "username": user,
        "via": "cookie",
        "api_token_configured": bool(os.environ.get("ARTIFACTS_TOKEN")),
        "notify_configured": bool(os.environ.get("ARTIFACTS_NOTIFY_WEBHOOK")),
        "watch_interval": float(os.environ.get("ARTIFACTS_WATCH_INTERVAL", "15")),
        "artifacts": store.stats().get("total", 0),
        "password_min": PASSWORD_MIN,
    })


def _cross_site(request):
    """这次请求是不是从别的站发出来的（只认「带了 Origin 且对不上」）。

    Cookie 本身是 SameSite=Lax，跨站 POST 根本不会带上它 —— 那是第一道闸。
    这里是第二道：万一以后 Cookie 属性被放宽，或者同一台机器上别的端口/域名
    起了个恶意页面，这道还能拦住改口令这种高危动作。

    没有 Origin 的请求照样放行：curl、回归脚本、agent 都不是浏览器，
    它们本来就不带这个头，把它们一起挡了只会让自检没法跑。
    """
    origin = request.headers.get("Origin")
    if not origin:
        return False
    host = request.headers.get("Host", "")
    try:
        netloc = urlsplit(origin).netloc
    except ValueError:
        return True
    return netloc != host


@_guard
async def api_change_password(request):
    """改当前账号的登录口令（console 用户库里那一条）。

    三个刻意的设计：
      1. 改谁的账号由 Cookie 决定，不看 body 传什么用户名 —— 否则任何登录用户
         都能改别人的口令。
      2. 必须再验一次旧口令。Cookie 可能是别人机器上留着的（笔记本合盖、
         浏览器没关），改口令是账号失守的最后一道闸。
      3. 复用 console 的 hash_password / save_users，口令怎么存、文件权限 0600
         怎么保持，全跟 console 自己写的一模一样，不另起一套。
    """
    user = _console_user_of(request)
    if not user:
        return _err("需要先用网页登录才能改口令", 401)
    if _cross_site(request):
        return _err("跨站请求不接受改口令，请在成果台页面里操作", 403)

    cs = _console_module()
    if cs is None or not hasattr(cs, "verify_user"):
        return _err("口令服务不可用（拿不到 console 的用户库）", 503)

    try:
        payload = await request.json()
    except Exception:
        return _err("invalid json", 400)
    if not isinstance(payload, dict):
        return _err("invalid json", 400)

    old_pw = str(payload.get("old_password", ""))
    new_pw = str(payload.get("new_password", ""))
    confirm = str(payload.get("new_password_confirm", ""))

    if not cs.verify_user(user, old_pw):
        return _err("旧口令不对", 403)
    if new_pw != confirm:
        return _err("两次输入的新口令不一致", 400)
    if len(new_pw) < PASSWORD_MIN:
        return _err(f"新口令至少 {PASSWORD_MIN} 位", 400)
    if new_pw == old_pw:
        return _err("新口令不能和旧口令一样", 400)
    if new_pw.lower() == user.lower():
        return _err("新口令不能和用户名一样", 400)

    users = cs.load_users()
    if user not in users:
        return _err("用户库里没有这个账号", 404)
    # 保留这个账号上的其他字段（将来加角色/创建时间时不会被这里抹掉）
    users[user] = {**users[user], **cs.hash_password(new_pw)}
    cs.save_users(users)

    store = _store_of(request)
    # 审计只留「谁改的」，绝不留口令本身（含新旧都不行）
    store._audit("settings.password_changed", actor=user,
                 payload={"via": "web", "min_length": PASSWORD_MIN})
    return _json({"ok": True, "username": user,
                  "note": "已改。其它设备上已登录的会话仍然有效"
                          "（Cookie 由会话密钥签名，不随口令变化）；要彻底收回，"
                          "轮换 CONSOLE_SESSION_SECRET 或删掉该账号再重建。"})


# --------------------------------------------------------------------- 静态资源

# 独立成果台页面已经并进 PilotV 官方前端，这里不再伺服 artifacts.html/css/js。
# /artifacts-static 仍然保留：成果页要从里面取三维渲染器（vendor/model-viewer.min.js）
# 和图标。成果数据一律走 /api/artifacts 自己的 Cookie / Bearer / 回环三道鉴权。

# 成果台自带的静态资源（主题 CSS / 图标 / manifest）。
# 挂在 /artifacts-static 而不是 /static：宿主 app 可能已经有 /static/{path} 这类
# 通配路由，aiohttp 按注册顺序匹配，谁先注册谁生效 —— 用专属前缀才能保证
# 页面拿到的是 PilotV 仓库里这一份，不被宿主的同名资源悄悄顶掉。
STATIC_TYPES = {
    ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
    ".webmanifest": "application/manifest+json", ".json": "application/json",
    ".woff2": "font/woff2", ".svgz": "image/svg+xml",
}


async def _serve_static(request):
    # 允许子目录（vendor/…），但必须归一化后仍在 static/ 里 —— 不做这一步
    # 就能用 ../ 把任意文件读出来。
    # rel 必须来自 match_info，不能用 request.path —— request.path 是整条
    # /artifacts-static/xxx，拿它拼进 static/ 会变成 static/artifacts-static/xxx，
    # 结果图标、manifest、vendor 里的渲染器统统 404：页面能开，样式和三维却是坏的。
    rel = request.match_info.get("name") or ""
    if not rel:
        return web.Response(status=404, text="not found")
    rel = os.path.normpath(rel)
    if os.path.isabs(rel) or rel.split(os.sep)[0] in ("..", ""):
        return web.Response(status=404, text="not found")
    root = os.path.join(HERE, "static")
    path = os.path.normpath(os.path.join(root, rel))
    if os.path.commonpath([os.path.abspath(path), root]) != root:
        return web.Response(status=404, text="not found")
    ext = os.path.splitext(path)[1].lower()
    if ext not in STATIC_TYPES:
        return web.Response(status=404, text="not found")
    if not os.path.isfile(path):
        return web.Response(status=404, text=f"{rel} not found")
    return web.FileResponse(
        path, headers={"Content-Type": STATIC_TYPES[ext],
                       "Cache-Control": "public, max-age=300"})


# --------------------------------------------------------------------- 挂载


def mount(app, console_root=None):
    global _store, _mat, _watcher, _ingester
    if console_root:
        os.environ.setdefault("CONSOLE_ROOT", console_root)
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    if _store is None:
        import artifacts_store
        _store = artifacts_store.ArtifactStore(DATA_DIR)
        _mat = Materializer(_store)
        _watch = Watcher(_store, _mat.submit,
                         interval=float(os.environ.get("ARTIFACTS_WATCH_INTERVAL", "15")))
        _watcher = _watch
        _ing = SessionIngester(
            _store, _mat.submit,
            interval=float(os.environ.get("ARTIFACTS_SESSION_INTERVAL", "20")),
            max_age_days=float(os.environ.get("ARTIFACTS_SESSION_MAX_AGE_DAYS", "14")))
        _ingester = _ing
    else:
        _watch = _watcher
        _ing = _ingester
    app["artifacts_store"] = _store
    app["artifacts_materializer"] = _mat
    app["artifacts_watcher"] = _watch
    app["artifacts_session_ingester"] = _ing
    import artifacts_notify
    _notifier = artifacts_notify.Notifier(store=_store, base_url=os.environ.get(
        "ARTIFACTS_NOTIFY_BASE_URL", "http://127.0.0.1:8799")).start()
    _store.bus.add_listener(_notifier.on_event)
    app["artifacts_notifier"] = _notifier

    async def _startup(a):
        if _mat is not None:
            await _mat.start()
        # 冷启动扫项目/会话目录要读几十个会话文件，放线程里预热，别让人等首屏
        try:
            import pilotdeck_workspace as _ws
            loop = asyncio.get_running_loop()
            loop.run_in_executor(None, _ws.warmup)
        except Exception as exc:
            print(f"[artifacts] 项目目录预热未启动（忽略）: {exc}", flush=True)
        _watch = a.get("artifacts_watcher")
        if _watch is not None:
            for d in os.environ.get("ARTIFACTS_WATCH_DIRS", "").replace(":", ";").split(";"):
                d = d.strip()
                if not d:
                    continue
                try:
                    _watch.add_dir(d)
                except ValueError:
                    print(f"[artifacts] 跳过无效监控目录: {d}", flush=True)
            # 自动挂上每个项目的工作目录。
            # 为什么必须自动：远程工具（Blender 走 ssh、MCP server 跑在别的
            # 机器）会把产物直接写进磁盘，运行时压根没跟踪到，transcript 里
            # 也没有 file_artifacts —— SessionIngester 抓不到这种文件。
            # 目录 watcher 正好补这个洞。add_dir 首次登记只把存量文件标成
            # 「见过」不回灌，所以挂上去不会把历史文件倒灌进成果台，只收
            # 挂载之后新写/新改的。
            if _env_flag("ARTIFACTS_AUTOWATCH_PROJECTS", True):
                try:
                    # 直接读 projects/*/.cwd，不走 scan_projects()：
                    # 只需要目录路径，而 scan_projects() 会往它自己的
                    # _tree_cache 里塞一份 session_limit=1 的树 —— 线上那份
                    # pilotdeck_workspace.py 的缓存键没带 session_limit，
                    # 之后成果页要 session_limit=20/50 的全树时会拿到这份
                    # 被我们改窄的缓存，页面上的会话列表会莫名少一大截。
                    # 归属是发布时用 scan_projects(20) 重新算的，这里不参与。
                    root = os.environ.get("PILOTDECK_HOME") or os.path.join(
                        os.path.expanduser("~"), ".pilotdeck")
                    pdir = os.path.join(root, "projects")
                    added = 0
                    for name in sorted(os.listdir(pdir)):
                        try:
                            with open(os.path.join(pdir, name, ".cwd"), encoding="utf-8") as fh:
                                cwd = fh.read().strip()
                        except OSError:
                            continue          # 没有 .cwd / 读不了
                        if not cwd or not os.path.isdir(cwd):
                            continue
                        try:
                            _watch.add_dir(cwd)
                            added += 1
                        except ValueError:
                            pass               # 目录没了/不可读，跳过
                    print(f"[artifacts] 自动挂载 {added} 个项目目录为监控目录", flush=True)
                except Exception as exc:
                    print(f"[artifacts] 项目目录自动挂载未完成（忽略）: {exc}", flush=True)
            await _watch.start()
            if _watch.dirs:
                print(f"[artifacts] 目录 watcher 已启动：{len(_watch.dirs)} 个目录", flush=True)
        _ingest = a.get("artifacts_session_ingester")
        if _ingest is not None:
            # 回灌历史默认关。理由见 SessionIngester.start()：这台机器上
            # 可回灌的历史有 2452 条，中位年龄 83 天，绝大多数是无关老项目的
            # 构建产物。要回灌就显式 ARTIFACTS_SESSION_BACKFILL=1，
            # 并用 ARTIFACTS_SESSION_MAX_AGE_DAYS 限定只收近期的。
            backfill = _env_flag("ARTIFACTS_SESSION_BACKFILL", False)
            await _ingest.start(backfill=backfill)
            print(f"[artifacts] 会话自动收录已启动"
                  f"（回灌历史={backfill}"
                  + (f"，限龄={_ingest.max_age_days}天）" if backfill else "）"), flush=True)
        print(f"[artifacts] 成果台就绪：数据目录 {DATA_DIR}", flush=True)

    async def _cleanup(a):
        _ingest = a.get("artifacts_session_ingester")
        if _ingest is not None:
            await _ingest.stop()
        _watch = a.get("artifacts_watcher")
        if _watch is not None:
            await _watch.stop()
        if _mat is not None:
            await _mat.stop()

    app.on_startup.append(_startup)
    app.on_cleanup.append(_cleanup)

    r = app.router
    # 独立成果台页面已删除，这里只剩前端要用的静态资源与 API。
    r.add_get("/artifacts-static/{name:.*}", _serve_static)
    r.add_get("/api/artifacts", api_list)
    r.add_post("/api/artifacts", api_create)
    r.add_post("/api/artifacts/import", api_import)
    r.add_get("/api/artifacts/events", api_events)
    r.add_get("/api/artifacts/health", api_health)
    r.add_get("/api/artifacts/workspace", api_workspace)
    r.add_get("/api/artifacts/notify", api_notify_status)
    r.add_post("/api/artifacts/notify/test", api_notify_test)
    r.add_get("/api/artifacts/me", api_me)
    r.add_post("/api/artifacts/password", api_change_password)
    r.add_get("/api/artifacts/{aid}", api_get)
    r.add_get("/api/artifacts/{aid}/feedback", api_feedback)
    r.add_post("/api/artifacts/{aid}/annotations", api_add_annotation)
    r.add_patch("/api/artifacts/{aid}/annotations/{nid}", api_patch_annotation)
    r.add_delete("/api/artifacts/{aid}/annotations/{nid}", api_delete_annotation)
    r.add_post("/api/artifacts/{aid}/status", api_set_status)
    r.add_post("/api/artifacts/{aid}/dispatch", api_dispatch)
    r.add_post("/api/artifacts/{aid}/apply", api_apply)
    r.add_get("/api/artifacts/{aid}/parts", api_parts)
    r.add_get("/api/artifacts/{aid}/pages/{page}", api_pdf_page)
    r.add_get("/api/artifacts/{aid}/part-pages/{name}/{page}", api_part_pdf_page)
    r.add_get("/api/artifacts/{aid}/files/{name}", api_part_file)
    r.add_get("/api/artifacts/{aid}/text", api_get_text)
    r.add_put("/api/artifacts/{aid}/text", api_put_text)
    r.add_post("/api/artifacts/{aid}/reanchor", api_reanchor)
    r.add_route("GET", "/api/artifacts/watch", api_watch)
    r.add_route("POST", "/api/artifacts/watch", api_watch)
    r.add_route("DELETE", "/api/artifacts/watch", api_watch)
    r.add_get("/api/artifacts/{aid}/chain", api_chain)
    r.add_get("/api/artifacts/{aid}/diff", api_diff)
    r.add_get("/api/artifacts/wait-rework", api_wait_rework)
    r.add_get("/api/artifacts/{aid}/audit", api_audit)
    r.add_get("/api/artifacts/{aid}/thumb", api_thumb)
    r.add_get("/api/artifacts/{aid}/raw", api_raw)
    r.add_get("/api/artifacts/{aid}/viewer", api_viewer)
    r.add_get("/api/artifacts/{aid}/file/{relpath:.*}", api_sibling_file)
    return app
