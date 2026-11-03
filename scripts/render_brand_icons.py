#!/usr/bin/env python3
"""Rasterise the PilotV brand SVGs into every PNG slot the web UI ships.

The upstream app references its favicon, PWA icons and service-worker
notification badge from several places (index.html, public/manifest.json,
public/sw.js). Those were all still PilotDeck artwork, so this script
regenerates each slot from the canonical SVG in ui/public/brand/.

Rasterisation uses headless Chrome because no librsvg/ImageMagick/cairosvg is
installed in this environment. Chrome is invoked once per output with an HTML
wrapper sized to the target so the result is pixel-exact rather than scaled.

Usage:
    python3 scripts/render_brand_icons.py [--ui-root <path to ui/>] [--check]
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CHROME_CANDIDATES = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]

# (target png relative to ui/, size in px, brand svg relative to ui/)
ICON_SLOTS = [
    ("public/favicon.png", 64, "public/brand/pilotv-mark.svg"),
    ("public/logo-128.png", 128, "public/brand/pilotv-mark.svg"),
    ("public/logo-256.png", 256, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-72x72.png", 72, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-96x96.png", 96, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-128x128.png", 128, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-144x144.png", 144, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-152x152.png", 152, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-180x180.png", 180, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-192x192.png", 192, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-384x384.png", 384, "public/brand/pilotv-mark.svg"),
    ("public/icons/icon-512x512.png", 512, "public/brand/pilotv-mark.svg"),
    # Legacy onboarding/illustration slots the server test still guards.
    ("public/pilotdeck-p-mark-transparent.png", 512, "public/brand/pilotv-mark.svg"),
    ("public/pilotdeck-p-mark-transparent-v2.png", 512, "public/brand/pilotv-mark.svg"),
    ("public/pilotdeck-logo-lockup-transparent.png", 1120, "public/brand/pilotv-lockup.svg"),
]

WRAPPER = """<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{{margin:0;padding:0;background:transparent;}}
  svg{{display:block;width:{w}px;height:{h}px;}}
</style></head><body>{svg}</body></html>
"""


def find_chrome() -> str:
    for path in CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    found = shutil.which("google-chrome") or shutil.which("chromium")
    if not found:
        sys.exit("ERROR: no chrome/chromium binary found for SVG rasterisation")
    return found


_SCRATCH_ROOT: dict[str, Path] = {}


def _can_load(chrome: str, directory: Path) -> bool:
    """实测这个 chromium 能不能读该目录：写个 canary 页面再 --dump-dom 看回显。"""
    canary = directory / "canary.html"
    canary.write_text(
        "<!doctype html><title>pilotv-canary-ok</title>probe", encoding="utf-8"
    )
    try:
        proc = subprocess.run(
            [chrome, "--headless", "--disable-gpu", "--no-sandbox", "--dump-dom", canary.as_uri()],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return False
    return "pilotv-canary-ok" in (proc.stdout or "")


def scratch_root(chrome: str) -> Path:
    """探测出这个 chromium 真正能读写的目录（同一进程内只探一次）。

    两种 chromium 的临时目录要求完全不同：Debian 包能读 /tmp；Snap 版受
    confinement 限制，/tmp 是 ERR_FILE_NOT_FOUND、$HOME 下是 ERR_ACCESS_DENIED，
    只有 ~/snap/chromium/common/ 能用 —— 而且两种情况它都 exit 0，只表现为
    「截图文件没生成」。

    不能靠 chrome 的路径字符串判断：/usr/bin/chromium-browser 只是个 exec
    /snap/bin/chromium 的 shell wrapper，路径里根本没有 /snap。所以实测。
    """
    if chrome in _SCRATCH_ROOT:
        return _SCRATCH_ROOT[chrome]

    candidates: list[Path] = []
    snap_common = Path("~/snap/chromium/common/pilotv-brand-icons").expanduser()
    if Path("/snap/bin/chromium").exists():
        candidates.append(snap_common)
    candidates.append(Path(tempfile.gettempdir()) / "pilotv-brand-icons")

    for root in candidates:
        root.mkdir(parents=True, exist_ok=True)
        if _can_load(chrome, root):
            _SCRATCH_ROOT[chrome] = root
            return root

    raise SystemExit(
        "ERROR  chromium 读不到任何候选临时目录："
        + ", ".join(str(c) for c in candidates)
    )


def render(chrome: str, svg_path: Path, out_path: Path, size: int) -> None:
    svg_text = svg_path.read_text(encoding="utf-8")
    # Strip width/height from the ROOT <svg> tag only. A blanket string replace
    # would also hit <rect width="512" height="512"> and silently drop the dark
    # brand background, so match the opening tag with a regex.
    svg_text = re.sub(
        r"(<svg\b[^>]*?)\swidth=\"[^\"]*\"",
        r"\1",
        svg_text,
        count=1,
    )
    svg_text = re.sub(
        r"(<svg\b[^>]*?)\sheight=\"[^\"]*\"",
        r"\1",
        svg_text,
        count=1,
    )
    # 宽高比从源 SVG 的 viewBox 读，不写死方形：方形图标铺满，横向锁定版
    # 按自身比例出图，不会被 letterbox 塞进一个 1120x1120 的空画布。
    vb = re.search(r"<svg\b[^>]*?viewBox=\"([-\d.\s]+)\"", svg_text)
    if not vb:
        raise SystemExit(f"ERROR  {svg_path} 的 <svg> 上没有 viewBox")
    parts = vb.group(1).split()
    vb_w, vb_h = float(parts[2]), float(parts[3])
    if vb_w == vb_h:
        width, height = size, size
    else:
        width = size
        height = max(1, round(size * vb_h / vb_w))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch_root(chrome)) as tmp:
        page = Path(tmp) / "page.html"
        shot = Path(tmp) / "shot.png"
        page.write_text(WRAPPER.format(svg=svg_text, w=width, h=height), encoding="utf-8")
        proc = subprocess.run(
            [
                chrome,
                "--headless",
                "--disable-gpu",
                "--no-sandbox",
                "--hide-scrollbars",
                "--default-background-color=00000000",
                f"--screenshot={shot}",
                f"--window-size={width},{height}",
                page.as_uri(),
            ],
            capture_output=True,
            text=True,
        )
        if not shot.exists():
            # chromium 在 confinement 拒绝时会 exit 0，必须自己判断产物。
            raise SystemExit(
                f"ERROR  chromium 没有生成截图：{chrome}\n"
                f"       临时页面：{page}\n"
                f"       stderr：{proc.stderr.strip() or '(空)'}"
            )
        shutil.copyfile(shot, out_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ui-root", default="pilotdeck-mobile/upstream-official/ui")
    parser.add_argument("--check", action="store_true", help="only report, do not write")
    args = parser.parse_args()

    ui_root = Path(args.ui_root).resolve()
    chrome = find_chrome()

    for rel, size, svg_rel in ICON_SLOTS:
        svg_path = (ui_root / svg_rel).resolve()
        out_path = ui_root / rel
        if not svg_path.exists():
            print(f"MISSING SOURCE  {svg_rel}")
            continue
        if args.check:
            status = "present" if out_path.exists() else "absent"
            print(f"{status:>8}  {rel} ({size}px from {svg_rel})")
            continue
        render(chrome, svg_path, out_path, size)
        print(f"{'rendered':>8}  {rel}  ({out_path.stat().st_size} bytes)")

    if not args.check:
        print(f"\ndone via {chrome}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
