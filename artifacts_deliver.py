"""PilotV 成果台 · 交付物判定 / 部件树 / 返工单落地 / 文本就地编辑。

这个模块回答三个问题，都是「成果台到底是干什么的」的定义问题：

1. **什么东西配进成果台**（需求 1：只显示最终成果）
   网页的最终成果是那个网页本身；页面里引用的图片、图标、缩略图、切片、
   截图中间产物，都不是成果，只是网页的零件。把它们收进来，左栏立刻
   变成垃圾场 —— 一次落地页制作能塞进来几百个 png。
   `classify()` 给出 final / aux 判定 + 人话理由；调用方据此拦截，
   发布方确实要收就显式写 `deliverable: "aux"` 放行。

2. **图纸/三维怎么显示，部件怎么切**（需求 2）
   主文件旁边放一个 `<主文件名>.parts.json`，描述部件树；每个叶子部件
   是一份独立的可显示文件。发布时把部件一起拷进成果台，页面上给一棵
   树，选中哪个部件就单独渲染、单独标注（标注带 part 锚点，切回来还在）。
   没有清单的模型 = 只有一个隐式根部件，接口形状不变。

3. **点了「应用」之后意见去哪**（需求 5）
   返工单要落两处：原项目目录（按会话分文件夹，人能直接翻到），
   以及对应 PilotDeck 会话的输入队列（对话里能看见、agent 能接着改）；
   同时走既有 dispatch 通道唤醒挂着 wait_artifact_rework 的 agent。
   三个通道各自成败独立汇报，不做「看起来成功了」的静默降级。

与 artifacts_console.py 的关系：本模块不 import 它（避免循环），
它反过来 import 本模块。落盘目录由调用方以参数传入。
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import time
import unicodedata

# --------------------------------------------------------------------- 交付物判定

# 页面/站点项目里「装零件的目录」。落在这里面的图/视频/模型，几乎必然是
# 某个页面的从属资源，而不是一次独立产出。
#
# 只收**判定力强**的目录名。像 tmp/temp/out/lib 这种泛用词不放进来：
# /tmp/m3mcp-xxxx/v1.html 这种真实成果会被误伤，而误杀是「成果丢了」，
# 代价远大于「左栏多收一张零件」。所以宁可漏判，不可错杀。
ASSET_DIR_SEGMENTS = {
    "assets", "asset", "img", "imgs", "image", "images", "pic", "pics",
    "photo", "photos", "icons", "css", "scss", "less", "js", "scripts",
    "style", "styles", "static", "public", "fonts", "media",
    "components", "component", "partials", "templates", "sprites",
    "thumbs", "thumbnails", "__pycache__", "node_modules",
    ".next", ".output", ".cache", ".venv", "venv",
}

# 文件名里带这些词的，几乎都是中间产物：缩略图、切片、截图、预览、贴图。
# 注意用了 (^|[-_.]) 分隔，避免把 legit 的 "crop-circle.png" 之外的词误伤；
# 也刻意不收 "part-01" —— 部件文件应该由 .parts.json 显式声明。
# 「中间产物」词表分两级，因为同一个词在不同类型里含义完全不同：
# `cover.md` 是一份正经文档，`cover.png` 常常只是网页配图；
# `preview.md` 是给人看的预览稿，`preview.png` 是渲染过程中的中间帧。
# 混成一张表就会把正经文档拒之门外 —— 那是比放进一张废图严重得多的错。
AUX_STEM_ALL = (
    "tmp", "temp", "draft", "debug", "wip", "scratch", "partial", "fragment",
)
# 刻意**不**收 "spec" 和 "test"：
#   spec.pdf  是规格说明书，test-report.pdf 是测试报告 —— 都是正经交付物，
#   而且是「评审纪要」这类成果最常用的名字。收了就等于把用户的正式成果
#   挡在门外，代价（成果丢了）远大于左栏多收一张图。宁可漏判，不可错杀。
AUX_STEM_DROP_NOTE = ("spec", "test")
AUX_STEM_MEDIA = (
    "thumb", "thumbs", "thumbnail", "sprite", "element", "slice", "slices",
    "crop", "crops", "snapshot", "screenshot", "screenshots", "preview",
    "cover", "poster", "og-image", "ogimage", "favicon", "watermark",
    "placeholder", "loading", "spinner", "avatar", "icon",
)
MEDIA_KINDS = {"image", "video", "drawing", "model3d"}


def aux_basename_re(kind: str) -> re.Pattern:
    words = AUX_STEM_ALL + (AUX_STEM_MEDIA if kind in MEDIA_KINDS else ())
    alt = "|".join(re.escape(w) for w in words)
    # 首尾连字符（_detail、draft-）是编辑器/构建留下的中间态记号，所有类型通用。
    return re.compile(rf"^[-_.~]|[_~]$|(^|[-_.])(?:{alt})([-_.]|$)", re.I)

# 这些后缀天然是「零件」，永远不该独立出现在成果列表里。
AUX_EXT = {
    ".map", ".ico", ".cur", ".webmanifest", ".eot", ".ttf", ".otf", ".woff",
    ".woff2", ".mp3", ".wav", ".ogg", ".m4a", ".avi", ".mkv", ".swf", ".psd",
    ".ai", ".eps", ".sketch", ".fig", ".xcf", ".afdesign", ".afphoto",
}

# 入口页面：即使在 dist/build 里也是最终成果（那正是构建产物入口）。
PAGE_ENTRY_NAMES = {"index.html", "index.htm", "app.html"}


def classify(kind: str, path: str | None, explicit: str | None = None) -> tuple[str, str]:
    """判定一份产物是不是「独立最终成果」。

    返回 (verdict, reason)：
      verdict = "final" → 独立最终成果，收进成果台
      verdict = "aux"   → 页面/成品的从属零件或中间产物，默认不收

    `explicit` 是发布方显式声明（payload["deliverable"]），显式永远优先，
    并且它是逃生舱：判错了发布方自己能改回来。
    """
    if explicit:
        val = str(explicit).strip().lower()
        if val in ("final", "aux", "asset", "embedded", "intermediate"):
            return ("final" if val == "final" else "aux"), "发布方显式声明"
        # 认不出来就当没写，别因此把正常成果毙掉

    if not path:
        return "final", "没有源路径，按最终成果收"

    p = os.path.normpath(path)
    base = os.path.basename(p)
    stem, ext = os.path.splitext(base)
    ext = ext.lower()
    segs = [s for s in p.replace("\\", "/").split("/") if s]
    dirs = {s.lower() for s in segs[:-1]}

    if ext in AUX_EXT:
        return "aux", f"{ext} 属于网页从属资源，不是独立成果"

    stem_rx = aux_basename_re(kind)
    if stem_rx.search(base):
        return "aux", f"文件名带中间产物标记（{base}）"

    if kind == "page":
        if base.lower() in PAGE_ENTRY_NAMES:
            return "final", "站点入口页面"
        if dirs & ASSET_DIR_SEGMENTS:
            return "aux", "页面落在站点资源目录里，不是入口页"
        return "final", "独立页面文件"

    if dirs & ASSET_DIR_SEGMENTS:
        hit = sorted(dirs & ASSET_DIR_SEGMENTS)[0]
        return "aux", f"位于 {hit}/ 目录下，属于某个成品的从属资源"

    # 根目录 / 构建产物目录之外的散落文件：成片图、成片视频、单个模型、整份文档
    return "final", "独立产出文件"


# --------------------------------------------------------------------- 部件树

PARTS_SUFFIX = ".parts.json"


def manifest_path_for(path: str) -> str:
    """`<主文件>.parts.json` —— widget.glb → widget.parts.json"""
    stem = os.path.splitext(path)[0]
    return stem + PARTS_SUFFIX


def _safe_name(name: str) -> str:
    base = os.path.basename((name or "").strip().replace("\\", "/"))
    base = unicodedata.normalize("NFKC", base)
    base = re.sub(r"[^\w.\-]+", "_", base, flags=re.UNICODE)[:80]
    return base or "part"


# 「能拆成部件树」的扩展名。只有一份：以前 console 侧自己抄了一份，漏了 .pdf，
# 结果图纸集（CAD 导出的 PDF）永远没有部件树，而三维模型有 —— 同一个功能，
# 两套清单，两种表现。
SPLITTABLE_EXT = {
    # 三维
    ".glb", ".gltf", ".obj", ".stl", ".ply", ".3ds", ".dae", ".3mf",
    ".step", ".stp", ".iges", ".igs",
    # 图纸
    ".pdf", ".svg", ".dxf", ".dwg",
}


def is_splittable(path: str) -> bool:
    return os.path.splitext(path or "")[1].lower() in SPLITTABLE_EXT


def _kind_by_ext(ext: str) -> str:
    return {".glb": "model3d", ".gltf": "model3d", ".obj": "model3d",
            ".stl": "model3d", ".ply": "model3d", ".3ds": "model3d",
            ".dae": "model3d", ".step": "model3d", ".stp": "model3d", ".iges": "model3d",
            ".igs": "model3d", ".3mf": "model3d",
            ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
            ".svg": "drawing", ".pdf": "drawing", ".dxf": "drawing", ".dwg": "drawing",
            ".html": "page", ".htm": "page",
            ".md": "doc", ".txt": "doc", ".docx": "doc", ".pptx": "doc",
            ".mp4": "video", ".mov": "video", ".webm": "video"}.get(ext.lower(), "model3d")


def load_parts_manifest(src_path: str) -> tuple[dict | None, str]:
    """读主文件旁的部件清单。返回 (manifest, 错误说明)。"""
    mp = manifest_path_for(src_path or "")
    if not src_path or not os.path.isfile(mp):
        return None, ""
    try:
        with open(mp, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        return None, f"部件清单读不出来（{os.path.basename(mp)}）：{exc}"
    if not isinstance(data, dict) or not isinstance(data.get("parts"), list):
        return None, f"部件清单格式不对（{os.path.basename(mp)}）：需要 {{\"parts\":[...]}}"
    return data, ""


def stage_parts(aid: str, src_path: str, manifest: dict | None, files_dir: str) -> dict:
    """把部件树规范化 + 把每个叶子部件拷进成果台。

    返回可直接塞进 meta 的结构：
        {"root": 部件id, "label": "...", "tree": [节点...], "count": n,
         "files": {部件id: "部件文件名"}, "source": "manifest|inline|single|none"}

    没有清单时不报错，退化成「只有一个根部件」的隐式树 —— 前端分派逻辑
    因此只需要一套。
    """
    base_dir = os.path.dirname(os.path.abspath(src_path)) if src_path else os.getcwd()
    out_dir = os.path.join(files_dir, "parts", aid)

    if not manifest:
        if not src_path or not os.path.isfile(src_path):
            return {"root": "", "label": "", "tree": [], "count": 0, "files": {},
                    "source": "none"}
        return {"root": "__root__", "label": os.path.basename(src_path),
                "tree": [_leaf("__root__", os.path.basename(src_path), src_path,
                               base_dir, out_dir, files_dir, aid, depth=0)],
                "count": 1, "files": {}, "source": "single"}

    files: dict = {}
    seen: set = set()
    counter = [0]

    def build(nodes, depth):
        out = []
        for raw in nodes or []:
            if not isinstance(raw, dict):
                continue
            label = str(raw.get("label") or raw.get("name") or "").strip()
            pid = str(raw.get("id") or "").strip()
            if not pid:
                counter[0] += 1
                pid = f"p{counter[0]}"
            if pid in seen:                     # id 撞了就不许覆盖，先来的赢
                pid = f"{pid}-{counter[0]}"
            seen.add(pid)
            children = raw.get("children") or raw.get("parts") or []
            if children:
                out.append({"id": pid, "label": label or pid, "depth": depth,
                            "hasChildren": True, "children": build(children, depth + 1)})
                continue
            rel = str(raw.get("path") or raw.get("file") or raw.get("src") or "").strip()
            node = _leaf(pid, label or os.path.basename(rel) or pid, rel,
                         base_dir, out_dir, files_dir, aid, depth)
            files[pid] = node["stored_name"]
            out.append(node)
        return out

    tree = build(manifest.get("parts"), 0)
    root = tree[0]["id"] if tree else ""
    return {"root": root,
            "label": str(manifest.get("label") or "").strip() or os.path.basename(src_path),
            "tree": tree, "count": sum(1 for n in _leaves(tree)),
            "files": files, "source": "manifest"}


def _leaves(tree):
    for n in tree or []:
        if n.get("children"):
            yield from _leaves(n["children"])
        else:
            yield n


def _resolve_part(rel: str, base_dir: str) -> tuple[str, str]:
    """部件文件只能取主文件所在目录（含子目录）里的东西。

    部件清单是发布方写的内容，而发布路径可能来自任何项目目录；不加这道闸，
    一份 `"path": "../../../../etc/passwd"` 的清单就能把系统文件复制进成果台
    并通过 `/files/` 路由发出去。判断按 realpath 做，`..` 和软链接都挡得住。
    """
    if not rel:
        return "", "部件没写文件路径"
    base = os.path.realpath(base_dir or ".")
    src = os.path.realpath(rel if os.path.isabs(rel) else os.path.join(base, rel))
    if os.path.commonpath([base, src]) != base:
        return "", f"部件路径越出主文件目录（{rel}）"
    return src, ""


def _leaf(pid: str, label: str, rel: str, base_dir: str, out_dir: str,
          files_dir: str, aid: str, depth: int) -> dict:
    rel = rel or ""
    src, unsafe = _resolve_part(rel, base_dir)
    ext = os.path.splitext(src)[1].lower()
    stored_name = _safe_name(rel or (pid + ext))
    node = {"id": pid, "label": label, "depth": depth, "hasChildren": False,
            "path": rel, "stored_name": "", "kind": _kind_by_ext(ext),
            "missing": True, "bytes": 0}
    if unsafe:
        node["warning"] = unsafe
        return node
    if not src or not os.path.isfile(src):
        return node
    node["missing"] = False
    try:
        os.makedirs(out_dir, exist_ok=True)
        dst = os.path.join(out_dir, stored_name)
        if os.path.abspath(src) != os.path.abspath(dst):
            shutil.copyfile(src, dst)
        node["stored_name"] = stored_name
        node["bytes"] = os.path.getsize(dst)
    except OSError:
        node["missing"] = True
    return node


def parts_dir(aid: str, files_dir: str) -> str:
    return os.path.join(files_dir, "parts", aid)


def part_file(aid: str, stored_name: str, files_dir: str) -> str | None:
    """按成果 id + 部件文件名取部件。拒绝任何路径穿越。"""
    if not aid or not stored_name:
        return None
    safe = os.path.basename(stored_name)
    if safe != stored_name or safe.startswith("."):
        return None
    p = os.path.join(files_dir, "parts", aid, safe)
    return p if os.path.isfile(p) else None


# --------------------------------------------------------------------- 文本就地编辑

EDITABLE_EXT = {".html", ".htm", ".md", ".markdown", ".txt", ".svg",
                ".json", ".css", ".js", ".jsx", ".ts", ".vue", ".yaml", ".yml"}
MAX_EDIT_BYTES = 2 * 1024 * 1024


class EmptyText(ValueError):
    """保存的内容是空的。单独一个类型：这是「误操作」不是「文件太大」，
    路由层要回 400 并说人话，不能混进 413 让人以为是文件太大。"""


def editable_reason(path: str) -> str:
    """返回空串 = 可编辑；否则返回不可编辑的人话理由。"""
    if not path:
        return "这份成果没有可编辑的源文件"
    ext = os.path.splitext(path)[1].lower()
    if ext not in EDITABLE_EXT:
        return f"{ext or '无后缀'} 不在可直接编辑的文本类型里"
    try:
        if os.path.getsize(path) > MAX_EDIT_BYTES:
            return f"文件超过 {MAX_EDIT_BYTES // 1024 // 1024}MB，成果台不代劳"
    except OSError:
        return "源文件读不出来"
    return ""


def write_text(path: str, text: str) -> dict:
    """把改好的文本写回成果台持有的副本（原子写）。原项目文件不动。"""
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    # 空内容一律不收：成果台手里这份副本是评审手上唯一的版本，
    # 误按一次保存就把它清空的代价，远大于「想清空」这个需求的收益。
    if not (text or "").strip():
        raise EmptyText("内容是空的，没有保存")
    data = (text or "").encode("utf-8")
    if len(data) > MAX_EDIT_BYTES:
        raise ValueError(f"内容超过 {MAX_EDIT_BYTES // 1024 // 1024}MB")
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    return {"bytes": len(data), "sha1": hashlib.sha1(data).hexdigest()[:16],
            "edited_at": _iso()}


def _iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + "+0800"


def base_copy_path(stored_path: str) -> str:
    """发布时留一份原始文本，用于算「你手工改了哪些」。"""
    return (stored_path or "") + ".orig"


def keep_base_copy(src_path: str, stored_path: str) -> str:
    if not src_path or not stored_path or not os.path.isfile(src_path):
        return ""
    if editable_reason(stored_path):
        return ""
    try:
        if not os.path.isfile(src_path):
            return ""
        shutil.copyfile(src_path, base_copy_path(stored_path))
        return base_copy_path(stored_path)
    except OSError:
        return ""


def text_diff(stored_path: str, context: int = 2, limit: int = 400) -> dict:
    """成果台副本 vs 发布时的原件 —— 人在成果台上手工改了哪几行。"""
    orig = base_copy_path(stored_path)
    out = {"edited": False, "added": 0, "removed": 0, "diff": "", "truncated": False}
    if not stored_path or not os.path.isfile(stored_path) or not os.path.isfile(orig):
        return out
    try:
        a = _read_text(orig)
        b = _read_text(stored_path)
    except OSError:
        return out
    if a == b:
        return out
    lines = list(difflib.unified_diff(a.splitlines(), b.splitlines(),
                                      fromfile="发布时", tofile="成果台内编辑", n=context,
                                      lineterm=""))
    out["added"] = sum(1 for x in lines if x.startswith("+") and not x.startswith("+++"))
    out["removed"] = sum(1 for x in lines if x.startswith("-") and not x.startswith("---"))
    out["edited"] = True
    if len(lines) > limit:
        out["diff"] = "\n".join(lines[:limit])
        out["truncated"] = True
    else:
        out["diff"] = "\n".join(lines)
    return out


def _read_text(path: str) -> str:
    with open(path, "rb") as fh:
        return fh.read().decode("utf-8", "replace")


# --------------------------------------------------------------------- 返工单落地

REWORK_DIRNAME = os.path.join(".pilotdeck", "artifacts-rework")


def rework_dir(project_dir: str, session_id: str) -> str:
    # 用会话 id 本身做目录名（POSIX 下 `web:s_xxx` 合法，人翻目录时一眼认得出）
    return os.path.join(project_dir, REWORK_DIRNAME,
                        sanitize_session_id(session_id or ""))


def build_rework_order(art: dict, notes: list[dict], *, actor: str = "reviewer",
                       text_change: dict | None = None,
                       stored_path: str | None = None) -> dict:
    """把「哪张图、哪几处、改成什么样」拼成一份人能读、agent 能执行的单子。"""
    # 副本路径从参数拿，不从 art 里摸：调用方先拼好返工单再补 _stored_path 的话，
    # 单子里这行就会是空的，而 agent 恰恰要靠它回读评审改过的那一版。
    art = dict(art)
    if stored_path:
        art["_stored_path"] = stored_path
    src = (art.get("source") or {})
    meta = (art.get("entry") or {}).get("meta") or {}
    items = []
    for n in notes or []:
        anchor = n.get("anchor") or {}
        rect = n.get("rect") or anchor.get("rect") or {}
        pos = ""
        if isinstance(rect, dict) and rect:
            pos = f"位置 x={rect.get('x')} y={rect.get('y')} w={rect.get('w')} h={rect.get('h')}"
        bits = [f"### [{n.get('seq')}] {n.get('severity') or 'minor'}"]
        if anchor.get("part"):
            bits.append(f"部件：{anchor.get('part_label') or anchor.get('part')}")
        if anchor.get("text"):
            bits.append(f"选中文字：{anchor['text']!r}")
        if pos:
            bits.append(pos)
        bits.append("")
        bits.append((n.get("body") or "").strip() or "（没写说明）")
        items.append("\n".join(bits))

    head = [
        f"# 成果返工单 · {art.get('title')}",
        "",
        f"- 成果 id：`{art.get('id')}`（v{art.get('version')} · {art.get('kind')}）",
        f"- 成果台副本：`{art.get('_stored_path') or ''}`",
        f"- 原项目文件：`{src.get('path') or ''}`",
        f"- 所属项目：{art.get('project') or '(未归属)'}",
        f"- 会话：{meta.get('session_id') or art.get('run_id') or '(未绑定)'}",
        f"- 提出人：{actor}　时间：{_iso()}",
        "",
        f"共 {len(notes or [])} 条待处理意见。请逐条改原项目文件，"
        "改完重新 publish 成新版本（parent_id 指向本成果 id）。",
    ]
    if text_change and text_change.get("edited"):
        head += ["", "## 评审在成果台上手工改的部分",
                 "", "```diff", text_change.get("diff") or "(空)", "```"]
    body = "\n".join(head + ["", "## 逐条意见", ""] + items) + "\n"
    return {"markdown": body, "notes": len(notes or []),
            "text_changed": bool(text_change and text_change.get("edited"))}


def write_rework_order(project_dir: str, session_id: str, aid: str, order: dict) -> dict:
    """返工单落原项目目录，按会话分文件夹。返回落盘详情。"""
    if not project_dir or not os.path.isdir(project_dir):
        return {"ok": False, "reason": f"原项目目录不存在：{project_dir or '(空)'}"}

    folder = rework_dir(project_dir, session_id or "unassigned")
    try:
        os.makedirs(folder, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        name = f"{stamp}-{aid}.md"
        path = os.path.join(folder, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(order["markdown"])
        _append_index(folder, {"aid": aid, "title": "", "file": name,
                               "at": _iso(), "notes": order["notes"]})
        return {"ok": True, "path": path, "dir": folder, "session_id": session_id,
                "index": os.path.join(folder, "index.json")}
    except OSError as exc:
        return {"ok": False, "reason": f"返工单写不进原项目目录：{exc}"}


def _append_index(folder: str, entry: dict) -> None:
    path = os.path.join(folder, "index.json")
    items: list = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
            if isinstance(loaded, list):
                items = loaded
    except Exception:
        items = []
    items.insert(0, entry)
    try:
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(items[:200], fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        pass


# ---- 对话注入：写进 PilotDeck 的会话输入队列 --------------------------------

def sanitize_session_id(session_id: str) -> str:
    r"""与 PilotDeck 的 sanitizeSessionIdForPath 逐字对齐（ui/server/utils/pilotPaths.js:110）。

    **必须对齐**：会话队列的文件名是 PilotDeck 自己算的，我们算出的名字
    只要差一个字符，它就永远读不到我们写的返工单 —— 而且不报错，只是
    静默不生效。POSIX 下它只把 `/` `\` 换成 `-`，`web:s_xxx` 里的冒号原样
    保留（只有 Windows 才连 `:` 一起换）。这里照抄，包括去首尾横线和
    空串兜底成 `session`。
    """
    import sys as _sys
    illegal = r'[\\/:<>"|?*]+' if _sys.platform == "win32" else r'[\\/]+'
    out = re.sub(illegal, "-", (session_id or "").strip())
    out = re.sub(r"^-+|-+$", "", out)
    return out or "session"


def project_storage_dir(project_slug: str, pilot_home: str) -> str:
    return os.path.join(pilot_home, "projects", project_slug, "pending-inputs")


def enqueue_session_input(project_slug: str, session_id: str, item: dict,
                          pilot_home: str) -> dict:
    """把返工单排进对应会话的输入队列。

    只写 pending-inputs 的磁盘态；这是 PilotDeck 自己恢复队列时读的那份。
    会话正在实时跑时不写 —— 那份文件正被 gateway 持有内存态并随时整体覆写，
    我们写进去会被无声抹掉，不如明说没成功。
    """
    if not project_slug or not session_id:
        return {"ok": False, "reason": "没有解析到项目/会话，未注入对话"}
    folder = project_storage_dir(project_slug, pilot_home)
    path = os.path.join(folder, f"{sanitize_session_id(session_id)}.json")
    doc = {"version": 2, "revision": 0, "items": []}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
            if isinstance(loaded, dict):
                doc.update(loaded)
    except FileNotFoundError:
        pass
    except Exception as exc:
        return {"ok": False, "reason": f"会话队列读不出来：{exc}"}
    if not isinstance(doc.get("items"), list):
        doc["items"] = []
    if any(isinstance(x, dict) and x.get("id") == item.get("id") for x in doc["items"]):
        return {"ok": True, "path": path, "dedup": True, "reason": "同一条返工单已在队列里"}
    doc["items"].append(item)
    doc["version"] = 2
    doc["revision"] = int(doc.get("revision") or 0) + 1
    try:
        os.makedirs(folder, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        return {"ok": True, "path": path, "queued": len(doc["items"])}
    except OSError as exc:
        return {"ok": False, "reason": f"会话队列写不进：{exc}"}


def resolve_session(tree_projects: list, run_id: str | None,
                    project_name: str | None) -> dict:
    """成果 → 它的会话。优先 run_id 精确命中，其次项目里最活跃的那个会话。"""
    projects = tree_projects or []
    if run_id:
        for p in projects:
            for s in p.get("sessions") or []:
                if s.get("id") == run_id:
                    return {"ok": True, "exact": True, "project": p, "session": s,
                            "slug": p.get("name"), "session_id": run_id,
                            "project_dir": p.get("fullPath") or p.get("path") or ""}
    if project_name:
        for p in projects:
            if (p.get("name") or "") != project_name and \
               (p.get("displayName") or "") != project_name:
                continue
            sessions = p.get("sessions") or []
            if sessions:
                live = [s for s in sessions if s.get("live")]
                s = (live or sessions)[0]
                return {"ok": True, "exact": False, "project": p, "session": s,
                        "slug": p.get("name"), "session_id": s.get("id"),
                        "project_dir": p.get("fullPath") or p.get("path") or ""}
            return {"ok": False, "exact": False, "project": p, "session": None,
                    "slug": p.get("name"), "session_id": "",
                    "project_dir": p.get("fullPath") or p.get("path") or "",
                    "reason": "项目里还没有会话，返工单已落盘但没法排进对话"}
    return {"ok": False, "exact": False, "reason": "这份成果没归到任何项目/会话"}

# --------------------------------------------------------------------- 图纸栅格化
# 浏览器里用 <object>/<embed> 放 PDF，缺内置 PDF 插件时就是一个黑框
# （用户报「图纸选中了显示小黑矩形」就是这个）。改成服务端把每页栅格化成
# PNG、前端拿 <img> 显示：看着跟普通图片一样，标注坐标也终于对得上。
PDF_PAGE_DIR = "pages"


def pdf_page_count(src: str) -> int:
    """PDF 有几页。拿不到就当 1 —— 至少还能显示第一页。"""
    import subprocess
    try:
        out = subprocess.run(["pdfinfo", src], capture_output=True, text=True,
                             timeout=30).stdout
        for line in out.splitlines():
            if line.lower().startswith("pages:"):
                return max(1, int(line.split(":", 1)[1].strip()))
    except Exception:
        pass
    return 1


def rasterize_pdf_page(src: str, page: int, dst: str, scale: int = 1600) -> bool:
    """把 PDF 第 page 页栅格化成 PNG 写到 dst。成功返回 True。

    pdftoppm 会按 `<前缀>-<页码>.png` 落盘，这里再搬到位；页码越界或
    工具缺失都返回 False，交给调用方回退（回退要能说清是「没装 pdftoppm」
    还是「这个 PDF 根本打不开」，不能一律当成打不开）。
    """
    import subprocess
    page = max(1, int(page or 1))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return True
    prefix = dst[:-4] + "-"
    try:
        subprocess.run(["pdftoppm", "-png", "-f", str(page), "-l", str(page),
                        "-scale-to", str(scale), src, prefix],
                       check=True, timeout=120)
    except FileNotFoundError:
        raise RuntimeError("服务器没装 pdftoppm，PDF 图纸栅格化不可用")
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"PDF 打不开或第 {page} 页不存在（pdftoppm 退出码 {exc.returncode}）")
    except subprocess.TimeoutExpired:
        raise RuntimeError("PDF 栅格化超时，文件可能太大或已损坏")
    made = sorted(f for f in os.listdir(os.path.dirname(dst))
                  if f.startswith(os.path.basename(prefix)) and f.endswith(".png"))
    if not made:
        raise ValueError(f"PDF 第 {page} 页栅格化后没拿到图")
    shutil.move(os.path.join(os.path.dirname(dst), made[0]), dst)
    return os.path.getsize(dst) > 0


# --------------------------------------------------------------------- 视频时间轴
# 标注要能记「画面位置 + 时间点」，所以得先知道这个视频有多长、帧率多少。
# 帧率只在文件里真的写了才算数（r_frame_rate 是容器给的，可能和真实不符）；
# 探测不到就不编一个假的帧号，宁可只记秒数。
def probe_video(src: str) -> dict:
    """ffprobe 探测时长/帧率/分辨率。失败返回 {}，别让探测把成果卡住。"""
    import subprocess
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=duration,r_frame_rate,avg_frame_rate,"
             "width,height:format=duration",
             "-of", "json", src],
            capture_output=True, text=True, timeout=30).stdout
        data = json.loads(out or "{}")
    except Exception:
        return {}
    meta: dict = {}
    dur = (data.get("format") or {}).get("duration")
    if not dur:
        streams = data.get("streams") or [{}]
        dur = (streams[0] if streams else {}).get("duration")
    try:
        meta["duration"] = round(float(dur), 3)
    except (TypeError, ValueError):
        pass
    streams = data.get("streams") or [{}]
    st = streams[0] if streams else {}
    for key, target in (("avg_frame_rate", "fps"), ("r_frame_rate", "fps_container")):
        val = st.get(key)
        if key == "avg_frame_rate" and val and "/" in val:
            try:
                num, den = val.split("/", 1)
                fps = float(num) / float(den) if float(den) else 0.0
                if fps > 0:
                    meta[target] = round(fps, 3)
            except (TypeError, ValueError, ZeroDivisionError):
                pass
    if st.get("width") and st.get("height"):
        meta["width"] = int(st["width"])
        meta["height"] = int(st["height"])
    return meta


def anchor_time(t, fps: float | None = None) -> dict:
    """把「第几个时间点」规整成 {t 秒, frame 帧}。

    帧号只在真的知道帧率时才给 —— 拿一个猜的帧号去跟人对，是会害人的。
    """
    try:
        sec = max(0.0, float(t))
    except (TypeError, ValueError):
        return {}
    out = {"t": round(sec, 3)}
    if fps and float(fps) > 0:
        out["frame"] = int(round(sec * float(fps)))
    return out


# --------------------------------------------------------------------- 重复成果
# 真实实例上同一份文件被反复发布（shot.png ×104、plan.svg ×106），735 条其实
# 只有 30 组不同的文件。版本链（parent_id）救不了这种：反复发布往往没带
# parent_id，于是变成一堆互不相干的「最新版」。这里给一个可分组、可解释的键，
# 让展示端能把同源的折叠起来 —— 但**不删除任何记录**，历史还得能翻。
def dup_key(project: str | None, file_name: str | None, size, mime: str | None = None) -> str:
    """同名 + 同大小 + 同项目 ⇒ 大概率是同一个文件被反复发布。

    刻意不含 agent/run_id/时间：跨会话、跨 agent 的同一份产物（同一张图被
    两个步骤各发一次）正是最该折叠的那批。带 agent 进去就永远折不掉。
    size 参与键是为了避免「同名的两个不同成品」被误并。
    """
    name = (file_name or "").strip()
    if not name:
        return ""
    return "|".join([(project or "").strip(), name.lower(), str(size or 0)])
