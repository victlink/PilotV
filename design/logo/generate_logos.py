#!/usr/bin/env python3
"""PilotV logo concept generator.

Emits pure-vector SVG concepts (no font dependency for the marks) so they
scale from 16px favicon to 512px app icon without redrawing.

Run:  python3 design/logo/generate_logos.py

环境变量（可选）：
  PILOTDECK_SESSION_ID   当前会话 ID，写完每个文件自动发布到成果台
  ARTIFACTS_BASE        成果台地址，默认 http://127.0.0.1:8799
  ARTIFACTS_TOKEN       成果台令牌（成果台绑非回环时需要）
"""
from pathlib import Path
import os
import json
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent
CONCEPTS = ROOT / "concepts"
LOCKUPS = ROOT / "lockups"
RENDERS = ROOT / "renders"

# Palette -------------------------------------------------------------
INK = "#0A0A0A"          # tile background (matches current product chrome)
PAPER = "#FAFAFA"        # mark on dark
ACCENT = "#4F7DFF"       # single accent, swappable
ACCENT_DEEP = "#2F5FE0"

SIZE = 512
TILE_R = 112             # app-icon corner radius

# --------------------------------------------------------------------- 成果台发布

_ARTIFACTS_BASE = os.environ.get("ARTIFACTS_BASE", "http://127.0.0.1:8799")
_ARTIFACTS_TOKEN = os.environ.get("ARTIFACTS_TOKEN", "")


def _call(method, path, payload=None):
    url = _ARTIFACTS_BASE.rstrip("/") + path
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if _ARTIFACTS_TOKEN:
        req.add_header("Authorization", f"Bearer {_ARTIFACTS_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode("utf-8")) if r.read else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": body[:300]}
    except Exception as exc:
        return 0, {"error": f"{type(exc).__name__}: {exc}"}


def publish(path, kind, title, run_id, deliverable="final"):
    """将已写入磁盘的文件注册到成果台。静默失败，不阻塞生成流程。"""
    if not run_id:
        return None
    status, data = _call("POST", "/api/artifacts", {
        "kind": kind, "title": title, "path": path,
        "run_id": run_id, "agent": "pilotdeck", "deliverable": deliverable,
    })
    if status == 200:
        aid = data.get("id", "?")
        print(f"  → 成果台 {aid} ({title})")
        return aid
    else:
        print(f"  ! 成果台发布失败 {status}: {data.get('error', '')[:80]}")
        return None


def v_path(cx, top, apex, half_w, thick):
    """Filled V glyph; arms are parallel so it stays optically clean."""
    ox_l, ox_r = cx - half_w, cx + half_w
    ix_l, ix_r = cx - half_w + thick, cx + half_w - thick
    inner_apex = apex - (thick / half_w) * (apex - top)
    return (f"M{ox_l:.1f} {top} H{ix_l:.1f} "
            f"L{cx:.1f} {inner_apex:.1f} "
            f"L{ix_r:.1f} {top} H{ox_r:.1f} "
            f"L{cx:.1f} {apex:.1f} Z")


def rect_path(x, y, w, h, rx):
    return (f"M{x + rx} {y} H{x + w - rx} A{rx} {rx} 0 0 1 {x + w} {y + rx} "
            f"V{y + h - rx} A{rx} {rx} 0 0 1 {x + w - rx} {y + h} "
            f"H{x + rx} A{rx} {rx} 0 0 1 {x} {y + h - rx} "
            f"V{y + rx} A{rx} {rx} 0 0 1 {x + rx} {y} Z")


def svg(body, bg=INK, size=SIZE, rx=TILE_R):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
            f'width="{size}" height="{size}" fill="none">\n'
            f'  <rect width="{size}" height="{size}" rx="{rx}" fill="{bg}"/>\n'
            f'{body}\n</svg>\n')


def bar(x, y, w, h, fill, rx):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
            f'fill="{fill}"/>')


# --- concept 1: Deck V (monogram resting on a baseline) --------------
def concept_1(fg, accent, bg=INK):
    glyph = v_path(256, 144, 330, 102, 64)
    return f'  <path d="{glyph}" fill="{fg}"/>\n' \
           f'  {bar(154, 362, 204, 24, accent, 12)}'


# --- concept 2: Phone V (device silhouette, V knocked out) -----------
def concept_2(fg, accent, bg=INK):
    body = rect_path(142, 80, 228, 352, 54)
    glyph = v_path(256, 164, 312, 44, 38)
    home = bar(212, 358, 88, 12, bg, 6)
    return (f'  <path fill-rule="evenodd" clip-rule="evenodd" d="\n'
            f'    {body}\n    {glyph}\n  " fill="{fg}"/>\n'
            f'  {home}')


# --- concept 3: Link V (nested chevron echo / hand-off) --------------
def concept_3(fg, accent, bg=INK):
    outer = v_path(256, 156, 372, 108, 62)
    slope = (372 - 156) / 108                      # shared arm angle
    inner = v_path(256, 156, 156 + slope * 36, 36, 24)
    return (f'  <path d="{outer}" fill="{fg}"/>\n'
            f'  <path d="{inner}" fill="{accent}"/>')


# --- concept 4: Live V (monogram + always-on status dot) -------------
def concept_4(fg, accent, bg=INK):
    glyph = v_path(240, 152, 364, 102, 64)
    return f'  <path d="{glyph}" fill="{fg}"/>\n' \
           f'  <circle cx="396" cy="146" r="28" fill="{accent}"/>'


BUILDERS = [
    ("c1-deck-v", concept_1, "01 / Deck V",
     "V monogram resting on a baseline — the deck. Steady, ownable, survives 16px."),
    ("c2-phone-v", concept_2, "02 / Phone V",
     "Device silhouette with the V knocked out. Says “the phone client” instantly."),
    ("c3-link-v", concept_3, "03 / Link V",
     "Nested chevrons: one stroke leaving the deck, one arriving. Sync / hand-off."),
    ("c4-live-v", concept_4, "04 / Live V",
     "Monogram plus an always-on status dot. The remote session that is live."),
]


def lockup(mark_body, fg, accent):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 220" '
            f'width="1120" height="220" fill="none">\n'
            f'  <g transform="scale(0.4296875)">\n'
            f'    <rect width="512" height="512" rx="112" fill="{INK}"/>\n'
            f'{mark_body}\n  </g>\n'
            f'  <text x="286" y="148" font-family="Inter, ui-sans-serif, system-ui, '
            f"-apple-system, 'Segoe UI', Roboto, sans-serif\" font-weight=\"800\" "
            f'font-size="130" letter-spacing="-6.5" fill="{fg}">Pilot<tspan '
            f'fill="{accent}">V</tspan></text>\n</svg>\n')


def main():
    run_id = os.environ.get("PILOTDECK_SESSION_ID", "")

    for d in (CONCEPTS, LOCKUPS, RENDERS):
        d.mkdir(parents=True, exist_ok=True)

    cards = []
    for name, builder, label, blurb in BUILDERS:
        dark_body = builder(PAPER, ACCENT, INK)
        (CONCEPTS / f"{name}.svg").write_text(svg(dark_body), encoding="utf-8")
        publish(str(CONCEPTS / f"{name}.svg"), "image", f"{name}.svg", run_id)

        light_body = builder(INK, ACCENT_DEEP, "#FFFFFF")
        (CONCEPTS / f"{name}-light.svg").write_text(
            svg(light_body, bg="#FFFFFF"), encoding="utf-8")
        publish(str(CONCEPTS / f"{name}-light.svg"), "image", f"{name}-light.svg", run_id)

        (LOCKUPS / f"{name}-lockup.svg").write_text(
            lockup(dark_body, INK, ACCENT_DEEP), encoding="utf-8")
        publish(str(LOCKUPS / f"{name}-lockup.svg"), "image", f"{name}-lockup.svg", run_id,
                deliverable="final")

        cards.append((name, label, blurb))

    rows = []
    for name, label, blurb in cards:
        rows.append(f"""
  <section class="card">
    <header><h2>{label}</h2><p>{blurb}</p></header>
    <div class="grid">
      <figure><img src="concepts/{name}.svg" width="220" height="220"><figcaption>dark tile · 220</figcaption></figure>
      <figure><img src="concepts/{name}-light.svg" width="220" height="220" style="border:1px solid #E4E4E7"><figcaption>light tile · 220</figcaption></figure>
      <figure><img src="concepts/{name}.svg" width="64" height="64"><figcaption>64</figcaption></figure>
      <figure><img src="concepts/{name}.svg" width="32" height="32"><figcaption>32</figcaption></figure>
      <figure><img src="concepts/{name}.svg" width="16" height="16"><figcaption>16</figcaption></figure>
      <figure class="lock"><img src="lockups/{name}-lockup.svg"><figcaption>lockup</figcaption></figure>
    </div>
  </section>""")

    preview_html = f"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>PilotV · logo concepts</title>
<style>
 :root {{ color-scheme: light; }}
 * {{ box-sizing: border-box; }}
 body {{ margin:0; padding:48px; background:#F4F4F5; color:#18181B;
   font:15px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }}
 h1 {{ font-size:26px; letter-spacing:-.4px; margin:0 0 4px; }}
 .sub {{ color:#71717A; margin:0 0 32px; }}
 .card {{ background:#fff; border:1px solid #E4E4E7; border-radius:16px;
   padding:24px 24px 20px; margin-bottom:24px; }}
 header h2 {{ font-size:17px; margin:0 0 4px; letter-spacing:-.2px; }}
 header p {{ margin:0 0 20px; color:#71717A; font-size:14px; }}
 .grid {{ display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap; }}
 figure {{ margin:0; text-align:center; }}
 figcaption {{ margin-top:10px; font-size:11px; color:#A1A1AA;
   letter-spacing:.4px; text-transform:uppercase; }}
 .lock {{ align-self:center; }}
 .lock img {{ width:360px; display:block; }}
</style></head><body>
<h1>PilotV — logo concepts</h1>
<p class="sub">Pure-vector marks, no font dependency · app-tile geometry 512 · check the small sizes</p>
{''.join(rows)}
</body></html>"""
    (ROOT / "preview.html").write_text(preview_html, encoding="utf-8")
    publish(str(ROOT / "preview.html"), "page", "logo concepts preview", run_id, deliverable="aux")

    print("generated:", len(cards) * 3, "svgs + preview.html")


if __name__ == "__main__":
    main()
