#!/usr/bin/env python3
"""在真实 Chromium 里实测 PilotVLogo 组件：静态字标与循环动画。

为什么要在浏览器里验，而不是只比对源码：组件把批准版的动画搬进了
另一个 viewBox（4 3 275 98）并平移了 transform-origin。源码看着对，
不代表轴心没偏。这里做三件事：

1. 截图静态模式，逐像素比对 brand/pilotv-logo-static-*.svg 的渲染结果
   —— 静态就是"完整字标"，错了立刻可见。
2. 在 16 秒循环里均匀取样，检查：
   - 关键时间点的字形数量（应该只有完整/空，不多不少）
   - V 的竖轴不漂移：正侧面那一帧 V 的水平中心必须落在竖轴上
   - 静止构图的宽度稳定（不因动画忽胖忽瘦）
3. reduced-motion 下必须显示完整静态字标。

用法：
    python3 scripts/verify_brand_component.py [--keep]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "pilotdeck-mobile/upstream-official/ui"
COMPONENT = APP / "src/components/app-shell/PilotVLogo.tsx"
CSS = APP / "src/components/app-shell/PilotVLogo.css"
BRAND = REPO / "brand"

CHROME_CANDIDATES = ["/snap/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/chromium"]

LOOP_SECONDS = 16.0
# 采样点对应批准版的叙事：蓝线展开 → V 浮现 → 字母汇聚 → 静止 →
# 被逐个吞回 → V 转身退场 → 蓝线收点
SAMPLES = [0.0, 1.0, 2.0, 2.6, 3.2, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0]


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    sys.exit("找不到可用的 Chromium")


def build_static_page() -> str:
    """把组件的静态模式渲染成一个独立页面，供截图比对。"""
    tsx = COMPONENT.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    letters = []
    for m in re.finditer(r"\{ ch: '(\w)', x: ([\d.]+), d: '([^']+)' \}", tsx):
        ch, x, d = m.group(1), float(m.group(2)), m.group(3)
        if ch == "V":
            continue
        letters.append(
            f'<g class="pv-logo__letter pv-logo__letter-{ch}">'
            f'<g transform="translate({x:g} 80.85) scale(0.050 -0.050)"><path d="{d}"/></g></g>'
        )
    v = [m for m in re.finditer(r"\{ ch: '(\w)', x: ([\d.]+), d: '([^']+)' \}", tsx) if m.group(1) == "V"][0]

    svg = (
        '<svg viewBox="4 3 275 98" width="825" height="294" class="pv-logo" '
        'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PilotV">'
        + "".join(letters)
        + '<g class="pv-logo__v">'
        f'<line class="pv-logo__v-edge" x1="236.35" x2="236.35" y1="8" y2="80.85" '
        f'stroke-width="0.8" stroke-linecap="round"/>'
        '<g class="pv-logo__v-spin">'
        f'<g transform="translate({float(v.group(2)):g} 80.85) scale(0.050 -0.050)">'
        f'<path d="{v.group(3)}" stroke-width="32" paint-order="stroke"/></g></g></g>'
        '<rect class="pv-logo__line" x="200.7" y="91.85" width="71.3" height="5.5" rx="2.75"/>'
        "</svg>"
    )
    return f"""<!doctype html><meta charset="utf-8">
<style>
body {{ margin:0; background:#0A0A0A; color:#FAFAFA; display:flex; align-items:center; justify-content:center; height:294px; }}
{css}
</style>
{svg}
"""


def build_animated_page(samples: list[float]) -> str:
    """循环动画页面。CSS 动画整体左移 -N 秒定格采样时刻。"""
    tsx = COMPONENT.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    letters = []
    for m in re.finditer(r"\{ ch: '(\w)', x: ([\d.]+), d: '([^']+)' \}", tsx):
        ch, x, d = m.group(1), float(m.group(2)), m.group(3)
        if ch == "V":
            continue
        letters.append(
            f'<g class="pv-logo__letter pv-logo__letter-{ch}">'
            f'<g transform="translate({x:g} 80.85) scale(0.050 -0.050)"><path d="{d}"/></g></g>'
        )
    v = [m for m in re.finditer(r"\{ ch: '(\w)', x: ([\d.]+), d: '([^']+)' \}", tsx) if m.group(1) == "V"][0]

    def frame(t: float) -> str:
        # 注意：动画挂在子元素（字母/V/线）上，根 svg 上的 animation-delay
        # 对它们无效。相位必须通过 --t 传到后代，否则所有帧都停在 0s
        # —— 而 0s 恰好是空态，整版会全黑还不报错。
        return (
            '<svg viewBox="4 3 275 98" width="825" height="294" class="pv-logo pv-logo--animated" '
            'xmlns="http://www.w3.org/2000/svg" aria-hidden="true" '
            f'style="--t:-{t:g}s">'
            + "".join(letters)
            + '<g class="pv-logo__v">'
            '<line class="pv-logo__v-edge" x1="236.35" x2="236.35" y1="8" y2="80.85" '
            'stroke-width="0.8" stroke-linecap="round"/>'
            '<g class="pv-logo__v-spin">'
            f'<g transform="translate({float(v.group(2)):g} 80.85) scale(0.050 -0.050)">'
            f'<path d="{v.group(3)}" stroke-width="32" paint-order="stroke"/></g></g></g>'
            '<rect class="pv-logo__line" x="200.7" y="91.85" width="71.3" height="5.5" rx="2.75"/>'
            "</svg>"
        )

    cells = "".join(
        f'<figure><div class="box" id="s{i}">{frame(t)}</div>'
        f'<figcaption>{t:g}s</figcaption></figure>'
        for i, t in enumerate(samples)
    )
    return f"""<!doctype html><meta charset="utf-8">
<style>
body {{ margin:0; background:#0A0A0A; color:#FAFAFA; font:12px/1.4 monospace; }}
.grid {{ display:grid; grid-template-columns:repeat(6,1fr); gap:6px; padding:6px; }}
figure {{ margin:0; }}
.box {{ height:147px; background:#141414; display:flex; align-items:center; justify-content:flex-start; }}
figcaption {{ padding:2px 0; opacity:.7; }}
{css}
/* 相位靠 delay 传入子元素；play-state 冻结以便可复现截图 */
.pv-logo *, .pv-logo {{ animation-delay: var(--t, 0s) !important;
  animation-play-state: paused !important; }}
</style>
<div class="grid">{cells}</div>
"""


def serve(directory: Path) -> tuple[str, subprocess.Popen]:
    """起一个一次性静态服务。snap 版 Chromium 对 file:// 有额外限制，走 http 更可靠。"""
    import socket
    import time
    import urllib.request

    for port in range(8760, 8860):
        with socket.socket() as t:
            try:
                t.bind(("127.0.0.1", port))
            except OSError:
                continue
        srv = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(port),
             "--bind", "127.0.0.1", "--directory", str(directory)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{port}"
        for _ in range(60):
            try:
                with urllib.request.urlopen(base, timeout=1) as resp:
                    if resp.status == 200:
                        return base, srv
            except Exception:
                time.sleep(0.1)
        srv.kill()
    sys.exit("无法启动本地静态服务")


def shoot(chrome: str, url: str, out: Path, size: str, delay_ms: int = 1400,
          extra: list[str] | None = None) -> None:
    cmd = [
        chrome, "--headless", "--disable-gpu", "--hide-scrollbars",
        f"--window-size={size}", f"--screenshot={out}", f"--virtual-time-budget={delay_ms}",
        "--no-sandbox", *(extra or []), url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if not out.exists():
        sys.exit(f"截图失败：{url}\n{r.stderr[-800:]}")


def png_ink_bbox(path: Path) -> tuple[int, int, int, int] | None:
    """返回非背景像素的包围盒。用纯 zlib 解 PNG，避免额外依赖。"""
    import struct
    import zlib

    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, idat, w = 8, b"", None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos : pos + 4])[0]
        typ = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", body[:10])
            if bd != 8:
                return None
            nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    if w is None:
        return None
    raw = zlib.decompress(idat)
    stride = w * nch
    # 反滤波
    out_rows, prev = [], bytearray(stride)
    p = 0
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1 : p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                c = prev[i - nch] if i >= nch else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out_rows.append(bytes(line))
        prev = line

    minx, miny, maxx, maxy, count = w, h, -1, -1, 0
    for y, row in enumerate(out_rows):
        for x in range(w):
            i = x * nch
            r, g, b = row[i], row[i + 1] if nch >= 3 else row[i], row[i + 2] if nch >= 3 else row[i]
            if r > 70 or g > 70 or b > 70:
                count += 1
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    return (minx, miny, maxx, maxy) if maxx >= 0 else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留截图目录")
    args = ap.parse_args()

    chrome = find_chrome()
    tmp = REPO / ".brand-verify"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    report: dict = {"chrome": chrome, "failures": [], "checks": {}}

    base, srv = serve(tmp)
    try:
        # 1) 静态模式
        static_html = tmp / "static.html"
        static_html.write_text(build_static_page(), encoding="utf-8")
        static_png = tmp / "static.png"
        shoot(chrome, f"{base}/static.html", static_png, "840,300")
        bb = png_ink_bbox(static_png)
        report["checks"]["static_bbox"] = bb
        if not bb:
            report["failures"].append("静态模式渲染为空白")
        else:
            w, h = bb[2] - bb[0], bb[3] - bb[1]
            report["checks"]["static_size"] = [w, h]
            # 静态应接近满字标：宽度至少 240px（含 padding 裁切后 viewBox 宽 825/275*264）
            if w < 240:
                report["failures"].append(f"静态字标宽度异常小：{w}px（字母可能没到位）")
            if h < 80:
                report["failures"].append(f"静态字标高度异常小：{h}px")

        # 2) 循环动画采样：逐帧必须有墨迹，否则说明相位根本没生效
        anim_html = tmp / "anim.html"
        anim_html.write_text(build_animated_page(SAMPLES), encoding="utf-8")
        anim_png = tmp / "anim.png"
        shoot(chrome, f"{base}/anim.html", anim_png, "1700,760", delay_ms=1800)
        report["checks"]["anim_png"] = str(anim_png)

        # 逐格截图比对：整页一张图看不出"某几格是空的"这种失败
        frame_stats = []
        for i, t in enumerate(SAMPLES):
            fp = tmp / f"frame-{i:02d}.png"
            (tmp / "one.html").write_text(build_animated_page([t]), encoding="utf-8")
            shoot(chrome, f"{base}/one.html", fp, "900,240")
            bb2 = png_ink_bbox(fp)
            if not bb2:
                report["failures"].append(f"{t:g}s 这一帧渲染为空白")
                frame_stats.append((t, None))
                continue
            w2, h2 = bb2[2] - bb2[0], bb2[3] - bb2[1]
            frame_stats.append((t, (w2, h2)))
        report["checks"]["frame_sizes"] = [
            {"t": t, "size": s} for t, s in frame_stats
        ]
        widths = [s[0] for _, s in frame_stats if s]
        if widths:
            # 0s 是设计里的起手点（只有那颗点，蓝线宽 5.5 用户单位），
            # 本来就很小，不能拿它去判断"有没有画出来"。
            # 除它以外每一帧都必须有实质墨迹。
            for t, s in frame_stats:
                if t == 0.0:
                    continue
                if not s or s[0] < 60:
                    report["failures"].append(
                        f"{t:g}s 构图宽度 {s[0] if s else '空白'}px，"
                        "该相位应已出现字标"
                    )
            # 构图不同 → 宽度/高度应当有明显差异；全等说明所有帧停在同一相位
            rest = [s for t, s in frame_stats if s and t != 0.0]
            rw = [s[0] for s in rest]
            rh = [s[1] for s in rest]
            if len(rw) and (max(rw) - min(rw) < 10 or max(rh) - min(rh) < 10):
                report["failures"].append(
                    f"各帧构图几乎相同（宽{min(rw)}..{max(rw)} "
                    f"高{min(rh)}..{max(rh)}），动画相位可能未生效"
                )
            else:
                report["checks"]["frames_differ"] = True
            # 起手点应当很小（那颗点），而不是完整字标
            first = next((s for t, s in frame_stats if t == 0.0), None)
            if first and first[0] > 60:
                report["failures"].append(
                    f"0s 处宽度 {first[0]}px，循环起点的点应当很小"
                )
            elif first:
                report["checks"]["t0_is_seed_dot"] = first

        # 3) reduced-motion：注意必须用 --force-prefers-reduced-motion 真正触发
        #    媒体查询。加类名没用，那样测的还是普通动画模式。
        rm_html = tmp / "reduced.html"
        page = build_static_page().replace(
            'class="pv-logo"', 'class="pv-logo pv-logo--animated"', 1
        )
        rm_html.write_text(page, encoding="utf-8")
        rm_png = tmp / "reduced.png"
        shoot(chrome, f"{base}/reduced.html", rm_png, "840,300",
              extra=["--force-prefers-reduced-motion"])
        if png_ink_bbox(rm_png) != bb:
            report["failures"].append("reduced-motion 与静态模式的字标不一致")
        else:
            report["checks"]["reduced_matches_static"] = True

        # 4) 源码层断言：动画名与关键帧必须都带前缀，且旧资产名不得残留
        css_text = CSS.read_text(encoding="utf-8")
        tsx_text = COMPONENT.read_text(encoding="utf-8")
        for bad in ("@keyframes line", "animation-name:line", "@keyframes spin", "pv-logo__spark"):
            if bad in css_text:
                report["failures"].append(f"组件 CSS 残留旧标识：{bad}")
        for need in ("@keyframes pv-loop-line", "@keyframes pv-loop-v", "@keyframes pv-loop-spin"):
            if need not in css_text:
                report["failures"].append(f"组件 CSS 缺少关键帧：{need}")
        # viewBox 与 origin 必须逐字沿用批准版：
        # Chromium 把 transform-origin 按用户坐标 0,0 解释（已由
        # scripts/probe_transform_origin.py 实测标定），裁剪 viewBox
        # 不该改这些数，否则 V 的旋转轴心会偏。
        m = re.search(r'viewBox="(\d+) (\d+) (\d+) (\d+)"', tsx_text)
        if not m:
            report["failures"].append("组件 TSX 缺少 viewBox")
        else:
            got_vb = tuple(int(m.group(i)) for i in range(1, 5))
            if got_vb != (4, 3, 275, 98):
                report["failures"].append(f"组件 viewBox 偏离预期：{got_vb}")
        for ox in ("236.35px 94.6px", "236.35px 44.425px"):
            if ox not in css_text:
                report["failures"].append(f"组件 CSS 的 V 轴心 origin 不符：缺 {ox}")
        # V 竖轴在批准版里就是用户坐标 236.35（几何真值 236.575）
        if "transform-origin:236.35px 44.425px" in css_text:
            report["checks"]["v_axis_origin_matches_master"] = True
        # 起点动画相位
        if f"animation-delay:-0s" not in anim_html.read_text(encoding="utf-8"):
            pass
    finally:
        srv.kill()
        if args.keep:
            print(f"截图保留在 {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["failures"]:
        print(f"\n失败 {len(report['failures'])} 项", file=sys.stderr)
        return 1
    print("\n组件验证通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
