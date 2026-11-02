"""STEP / IGES / STL / OBJ / PLY → GLB 转换（成果台三维预览用）。

model-viewer 只认 glTF，这些格式喂进去就是一片空白。这里在成果台里做
两件事：**找得到转换器**、**转一次就缓存**。转换本身跑在隔离 venv 的子进程里
（scripts/cad_to_glb.py，需要 OCP/OpenCASCADE 与 VTK），成果台主进程不 import
它 —— 几百 MB 的二进制库挂在 Web 服务进程里，崩一次就带走整个成果台。

转换器没装 / 装不上时不是静默失败：`viewer()` 抛 CadUnavailable，接口如实
告诉页面「这台机器没装三维转换器」，页面再提示用户改下 glb 或下载原文件。
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
CONVERTER = os.path.join(HERE, "scripts", "cad_to_glb.py")

CAD_EXT = {".step", ".stp", ".iges", ".igs"}
# 网格格式：里面已经是三角面，但 model-viewer 同样不认，一样要转。
MESH_EXT = {".stl", ".obj", ".ply"}
CONVERTIBLE_EXT = CAD_EXT | MESH_EXT
# 这些格式 model-viewer 自己能读，别多绕一圈转换。
NATIVE_3D_EXT = {".glb", ".gltf"}

# 转换要解 B-rep 再网格化，大装配体可能几十秒。超时就当这次没转成，
# 让用户重试或调细一点，而不是把请求挂在那儿。
TIMEOUT = float(os.environ.get("ARTIFACTS_CAD_TIMEOUT", "240"))

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class CadError(RuntimeError):
    """转换跑过了但没成功（模型有问题、超上限等）。"""


class CadUnavailable(RuntimeError):
    """这台机器上没有可用的三维转换器。"""


# 改了转换器（材质、网格精度、脚本结构、支持了哪种格式）就 +1：
# 缓存文件名带它，用户的成果立刻换新渲染。
CONVERTER_VERSION = 4


def is_cad(path: str) -> bool:
    return os.path.splitext(path or "")[1].lower() in CAD_EXT


def is_convertible(path: str) -> bool:
    return os.path.splitext(path or "")[1].lower() in CONVERTIBLE_EXT


def needs_conversion(path: str) -> bool:
    return is_convertible(path)


def converter_python() -> str:
    """转换器解释器。可用 ARTIFACTS_CAD_PYTHON 覆盖（比如指到系统 python）。"""
    explicit = os.environ.get("ARTIFACTS_CAD_PYTHON", "").strip()
    if explicit:
        if os.path.isfile(explicit) and os.access(explicit, os.X_OK):
            return explicit
        raise CadUnavailable(f"ARTIFACTS_CAD_PYTHON 指向的文件不可用：{explicit}")
    data_dir = os.environ.get("ARTIFACTS_DATA_DIR") or os.path.join(HERE, ".artifacts-data")
    venv = os.environ.get("ARTIFACTS_CAD_VENV", "").strip() or os.path.join(data_dir, "venvs", "cad")
    for candidate in (os.path.join(venv, "bin", "python3"), os.path.join(venv, "bin", "python")):
        if os.path.isfile(candidate):
            return candidate
    raise CadUnavailable("没找到三维转换器（隔离 venv 缺失）")


def converter_status() -> dict:
    """给页面/排查用的一句话状态，不抛异常。"""
    try:
        python = converter_python()
    except CadUnavailable as exc:
        return {"ok": False, "error": str(exc), "converter": CONVERTER}
    return {"ok": os.path.isfile(CONVERTER), "converter": CONVERTER,
            "python": python, "ext": sorted(CONVERTIBLE_EXT)}


def _cache_dir() -> str:
    data_dir = os.environ.get("ARTIFACTS_DATA_DIR") or os.path.join(HERE, ".artifacts-data")
    path = os.path.join(data_dir, "viewer")
    os.makedirs(path, exist_ok=True)
    return path


def cached_glb(src: str) -> str:
    """缓存文件名带源文件摘要 + 转换器版本。

    源文件摘要：返工发了新版本（内容变了）就不会吃到旧网格。
    转换器版本：换了转换参数（材质、网格精度）后旧缓存必须失效，不然用户还看着老结果。
    """
    with open(src, "rb") as handle:
        digest = hashlib.sha1(handle.read()).hexdigest()[:12]
    stem = hashlib.sha1(os.path.abspath(src).encode("utf-8")).hexdigest()[:8]
    return os.path.join(_cache_dir(), f"{stem}-{digest}-v{CONVERTER_VERSION}.glb")


def _lock_for(path: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


def convert(src: str, dst: str | None = None) -> dict:
    """把 src 转成 GLB，返回 {path, triangles, ...}。已转过就直接用缓存。

    同步阻塞（要占几秒到几十秒），调用方请丢进 executor。
    """
    if not src or not os.path.isfile(src):
        raise CadError("原始文件不存在")
    if not is_convertible(src):
        raise CadError(f"这个格式没法转成可显示的三维：{os.path.splitext(src)[1] or src}")
    dst = dst or cached_glb(src)
    if os.path.isfile(dst) and os.path.getsize(dst) > 0:
        return {"path": dst, "cached": True}

    python = converter_python()
    if not os.path.isfile(CONVERTER):
        raise CadUnavailable(f"转换脚本缺失：{CONVERTER}")

    # 同一份成果并发打开时只转一次：model-viewer 的 GLB 是整份下载的，
    # 几个请求一起转就是几倍 CPU 和一份份重复的磁盘写入。
    with _lock_for(dst):
        if os.path.isfile(dst) and os.path.getsize(dst) > 0:
            return {"path": dst, "cached": True}
        try:
            done = subprocess.run(
                [python, CONVERTER, src, dst],
                capture_output=True, text=True, timeout=TIMEOUT, check=False)
        except subprocess.TimeoutExpired:
            # 半成品留在磁盘上只会让下次直接命中缓存。
            _drop(dst)
            raise CadError(f"三维转换超时（{TIMEOUT:.0f}s）") from None
        if done.returncode != 0:
            _drop(dst)
            detail = (done.stderr or done.stdout or "").strip()
            try:
                detail = json.loads(detail).get("error", detail)
            except Exception:
                pass
            raise CadError(f"三维转换失败：{detail[:300]}")
        if not os.path.isfile(dst) or os.path.getsize(dst) == 0:
            raise CadError("CAD 转换没有产出文件")
        try:
            stats = json.loads((done.stdout or "{}").strip().splitlines()[-1])
        except Exception:
            stats = {}
        stats.pop("ok", None)
        return {"path": dst, "cached": False, **stats}


def _drop(path: str) -> None:
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass
