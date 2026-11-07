#!/usr/bin/env python3
"""只读探针：枚举所有可能的前端入口，判定其服务的是新构建还是旧构建。

新构建标记：
  - bundle 内含 'data-speaker-key'（agentIdentity 的 data 属性）
  - bundle 内含 'speaker.onlyThis'（新增 i18n 键）
  - 右侧 pd-page-drawer 面板文案里不再含 '改动'

用法：python3 scripts/_archive/probe_entry_points.py
"""
import concurrent.futures as cf
import re
import urllib.request
import urllib.error

ENTRY_POINTS = [
    ("NAS pilotv 网关", "http://127.0.0.1:5187/"),
    ("NAS 本地 UI 3001", "http://127.0.0.1:3001/"),
    ("NAS 自部署 5186", "http://127.0.0.1:5186/"),
    ("NAS 443 (nginx)", "https://127.0.0.1/"),
    ("NAS 80 (nginx)", "http://127.0.0.1/"),
    ("tailscale serve 8444", "http://100.90.196.104:8444/"),
    ("marc-pc (Windows) 3001", "http://100.120.169.61:3001/"),
    ("jx88 3001", "http://100.108.86.109:3001/"),
    ("leo-mac-studio 3002", "http://100.117.103.34:3002/"),
]

TIMEOUT = 12


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": "probe/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.status, resp.read()


def probe(item):
    label, base = item
    out = {"label": label, "base": base}
    try:
        status, html = fetch(base)
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    text = html.decode("utf-8", "replace")
    out["status"] = status
    out["html_len"] = len(html)
    out["index_sha"] = __import__("hashlib").sha256(html).hexdigest()[:12]
    m = re.search(r'src="(/assets/[^"]+\.js)"', text)
    if not m:
        out["note"] = "index.html 内未找到 /assets/*.js 引用"
        return out
    js_path = m.group(1)
    out["bundle"] = js_path
    try:
        jst, js = fetch(base.rstrip("/") + js_path)
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"bundle fetch failed: {exc}"
        return out
    blob = js.decode("utf-8", "replace")
    out["bundle_bytes"] = len(js)
    out["has_data_speaker_key"] = "data-speaker-key" in blob
    out["has_speaker_only_this"] = "speaker.onlyThis" in blob
    out["has_reply_expand"] = "reply.expand" in blob
    i = blob.find("pd-page-drawer-panel")
    if i >= 0:
        seg = blob[i : i + 2200]
        out["drawer_words"] = [w for w in ("对话", "文件", "改动", "成果", "收起") if w in seg]
    else:
        out["drawer_words"] = None
    out["last_modified"] = None
    try:
        req = urllib.request.Request(base.rstrip("/") + js_path, method="HEAD",
                                     headers={"User-Agent": "probe/1.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            out["last_modified"] = resp.headers.get("Last-Modified")
            out["cache_control"] = resp.headers.get("Cache-Control")
    except Exception:  # noqa: BLE001
        pass
    return out


def main():
    with cf.ThreadPoolExecutor(max_workers=9) as pool:
        results = list(pool.map(probe, ENTRY_POINTS))
    for r in results:
        print("=" * 78)
        print(f"{r['label']}  {r['base']}")
        if "error" in r:
            print(f"  ERROR: {r['error']}")
            continue
        print(f"  http={r.get('status')} index_sha={r.get('index_sha')} bundle={r.get('bundle')}")
        print(f"  bundle_bytes={r.get('bundle_bytes')} last_modified={r.get('last_modified')}")
        print(f"  new_impl: data-speaker-key={r.get('has_data_speaker_key')} "
              f"speaker.onlyThis={r.get('has_speaker_only_this')} reply.expand={r.get('has_reply_expand')}")
        print(f"  drawer_words={r.get('drawer_words')}")
        if r.get("note"):
            print(f"  note: {r['note']}")


if __name__ == "__main__":
    main()
