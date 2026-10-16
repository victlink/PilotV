#!/usr/bin/env python3
"""判定 transform-box:view-box 下 transform-origin 长度从哪算起（无动画隔离测试）。

问题：组件把批准版的 viewBox 从 "-12 -18 310 130" 裁到 "4 3 275 98"，
transform-origin 的数字该不该跟着平移？
  · 规范口径：参考框是 viewBox 矩形，原点在 (min-x,min-y) → 要平移 min 差
  · 另一种可能：长度按用户坐标系给 → 不用动

两种解释都自洽，必须在浏览器里量。此前带动画的探针被相位干扰（v-reveal
在部分相位把 V 藏起来），这里彻底去掉动画：只施加一个静态 scaleX(-1)，
镜像轴就是 transform-origin，最容易量。

判定基准：V 的几何中心在用户坐标 x=236.575。镜像应当关于轴对称，
所以镜像后的橙色中心应当落在这条轴上（±2px）。若某个候选做不到，
就说明它的 origin 数字给错了。

用法：python3 scripts/probe_transform_origin.py [--keep]
"""
from __future__ import annotations

import argparse
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.request
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MASTER = REPO / "常用资料" / "PilotV-Logo-3D" / "蓝橙循环版" / "pilotv-loop.svg"
CHROME = "/snap/bin/chromium"
PX_PER_UNIT = 4

OLD_VB = (-12, -18, 310, 130)
NEW_VB = (4, 3, 275, 98)
BASE_X, BASE_Y = 236.35, 44.425

# V 的真实几何中心：路径 x 从 -26 到 1457，落点 200.80，缩放 0.05
V_CENTER_X = 200.80 + ((-26 + 1457) / 2) * 0.05

CANDIDATES = {
    "asis": (BASE_X, BASE_Y),
    "minus_newmin": (BASE_X - NEW_VB[0], BASE_Y - NEW_VB[1]),
    "minus_delta": (BASE_X - (NEW_VB[0] - OLD_VB[0]), BASE_Y - (NEW_VB[1] - OLD_VB[1])),
}


def v_path() -> str:
    src = MASTER.read_text(encoding="utf-8")
    m = re.search(r'<g class="v-spin">.*?<g transform="translate\([\d.]+ [\d.]+\) '
                  r'scale\([\d.]+ -[\d.]+\)">\s*<path d="([^"]+)"', src, re.S)
    if not m:
        sys.exit("未能从批准版取出 V 路径")
    return m.group(1)


def page(vb: tuple, origin: tuple[float, float]) -> str:
    d = v_path()
    return f"""<!doctype html><meta charset="utf-8">
<style>
body{{margin:0;background:#0A0A0A}}
#box{{width:1400px;height:800px}}
#t{{transform-box:view-box;transform-origin:{origin[0]:.5f}px {origin[1]:.5f}px;
   transform:scaleX(-1)}}
path{{fill:#e55a09;stroke:#e55a09;stroke-width:32;paint-order:stroke}}
</style>
<div id="box">
<svg viewBox="{vb[0]} {vb[1]} {vb[2]} {vb[3]}" width="{int(vb[2] * PX_PER_UNIT)}"
     height="{int(vb[2] * PX_PER_UNIT * 0.55)}" xmlns="http://www.w3.org/2000/svg">
  <!-- 参照：原样 V，位于左半边；用青色竖线标出其几何中心 -->
  <g transform="translate(200.80 80.85) scale(0.050 -0.050)"><path d="{d}"/></g>
  <line id="refmark" x1="{V_CENTER_X}" x2="{V_CENTER_X}" y1="-10" y2="120"
        stroke="#00E5FF" stroke-width="0.6"/>
  <g id="t"><g transform="translate(200.80 80.85) scale(0.050 -0.050)"><path d="{d}"/></g></g>
</svg></div>
"""


def serve(tmp: Path):
    for port in range(8870, 8950):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
        srv = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
             "--directory", str(tmp)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f"http://127.0.0.1:{port}"
        for _ in range(60):
            try:
                with urllib.request.urlopen(base, timeout=1) as r:
                    if r.status == 200:
                        return base, srv
            except Exception:
                time.sleep(0.1)
        srv.kill()
    sys.exit("无法启动本地静态服务")


def shoot(url: str, out: Path) -> None:
    r = subprocess.run(
        [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
         "--window-size=1400,800", f"--screenshot={out}",
         "--virtual-time-budget=1200", "--no-sandbox", url],
        capture_output=True, text=True, timeout=90, check=False)
    if not out.exists():
        sys.exit(f"截图失败：{url}\n{r.stderr[-400:]}")


def spans(png: Path) -> dict[str, tuple[int, int, int, int]]:
    """分别量出橙色（被测镜像体）与青色（参照标尺）的像素范围。"""
    out = {}
    data = png.read_bytes()
    pos, idat, w, h, nch = 8, b"", None, None, 4
    while pos < len(data):
        ln = struct.unpack(">I", data[pos : pos + 4])[0]
        typ, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", body[:10])
            nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride, prev = w * nch, bytearray(w * nch)
    acc = {"orange": [w, h, -1, -1, 0], "cyan": [w, h, -1, -1, 0]}
    p = 0
    for y in range(h):
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
        for x in range(w):
            i = x * nch
            r, g, b = line[i], line[i + 1], line[i + 2]
            if r > 150 and 30 < g < 150 and b < 80:
                a = acc["orange"]; a[0] = min(a[0], x); a[1] = min(a[1], y)
                a[2] = max(a[2], x); a[3] = max(a[3], y); a[4] += 1
            elif b > 150 and g > 150 and r < 120:
                a = acc["cyan"]; a[0] = min(a[0], x); a[1] = min(a[1], y)
                a[2] = max(a[2], x); a[3] = max(a[3], y); a[4] += 1
        prev = line
    for k, a in acc.items():
        out[k] = (a[0], a[1], a[2], a[3]) if a[4] else None
    return out


def orange_bbox(png: Path) -> tuple[int, int, int, int] | None:
    data = png.read_bytes()
    pos, idat, w, h, nch = 8, b"", None, None, 4
    while pos < len(data):
        ln = struct.unpack(">I", data[pos : pos + 4])[0]
        typ, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", body[:10])
            nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride, prev = w * nch, bytearray(w * nch)
    lo, hi, tlo, thi, n = w, -1, h, -1, 0
    p = 0
    for y in range(h):
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
        # 只取镜像副本所在的右半边（原图在左）
        for x in range(w // 2, w):
            i = x * nch
            r, g, b = line[i], line[i + 1], line[i + 2]
            if r > 150 and 30 < g < 150 and b < 80:
                n += 1
                lo, hi = min(lo, x), max(hi, x)
                tlo, thi = min(tlo, y), max(thi, y)
        prev = line
    return (lo, tlo, hi, thi) if n else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    tmp = REPO / ".brand-verify-probe"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    base, srv = serve(tmp)

    cases = [("master", OLD_VB, (BASE_X, BASE_Y))] + [
        (k, NEW_VB, v) for k, v in CANDIDATES.items()
    ]
    res = {}
    try:
        for name, vb, origin in cases:
            (tmp / f"{name}.html").write_text(page(vb, origin), encoding="utf-8")
            out = tmp / f"{name}.png"
            shoot(f"{base}/{name}.html", out)
            res[name] = (vb, origin, spans(out))
    finally:
        srv.kill()

    # 先用参照标尺标定坐标映射：它画在已知真值 V_CENTER_X 上。
    # 若标尺落点与假设不符，说明 viewBox→像素的映射另有规则，
    # 后面用同一条映射换算出来的偏差就都没有意义了。
    calib = {}
    for name, (_, _, sp) in res.items():
        c = sp.get("cyan")
        if not c:
            print(f"{name}: 未见参照标尺，页面可能没渲染")
            return 1
        calib[name] = (c[0] + c[2]) / 2

    print(f"V 几何中心（用户坐标）= {V_CENTER_X:.3f}\n")
    print("— 标定：参照竖线画在已知真值上 —")
    mapping_ok = True
    for name, (vb, _, _) in res.items():
        want = (V_CENTER_X - vb[0]) * PX_PER_UNIT
        d = calib[name] - want
        ok = abs(d) <= 1.0
        mapping_ok &= ok
        print(f"{name:<14} 期望x={want:>7.2f}  实测x={calib[name]:>7.2f}  "
              f"偏差={d:>+6.2f}px  {'OK' if ok else 'BAD'}")
    if not mapping_ok:
        print("\n坐标映射与假设不符，探针不可用，停止。")
        if args.keep:
            print(f"截图：{tmp}")
        return 1

    print("\n— 被测：镜像体应当关于 transform-origin 对称 —")
    winners = []
    for name, (vb, origin, sp) in res.items():
        o = sp.get("orange")
        axis_user = vb[0] + origin[0]
        axis_screen = (axis_user - vb[0]) * PX_PER_UNIT
        if not o:
            print(f"{name:<14} （未渲染）")
            continue
        center = (o[0] + o[2]) / 2
        d = center - axis_screen
        ok = abs(d) <= 2.5
        if ok:
            winners.append(name)
        print(f"{name:<14} origin=({origin[0]:>7.2f},{origin[1]:>6.2f}) "
              f"轴x={axis_user:>8.3f}  实测中心={center:>7.2f}  "
              f"偏差={d:>+6.2f}px  {'OK' if ok else 'BAD'}")

    print()
    if "master" not in winners:
        print("批准版自身都不自洽 —— 探针或 artwork 有问题，先别据此改生成器")
        rc = 1
    else:
        pick = "minus_delta" if "minus_delta" in winners else None
        others = [k for k in winners if k not in ("master", "minus_delta")]
        print(f"规范口径候选 minus_delta：{'一致 ✓' if pick else '不一致 ✗'}")
        if others:
            print(f"其他同样一致的候选：{others}")
        print(f"结论：{pick or '无'}")
        rc = 0 if pick else 1
    if args.keep:
        print(f"截图：{tmp}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
