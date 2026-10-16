#!/usr/bin/env python3
"""检查网关派发的前端资源是否都能真正拿到。

背景：PilotV bundle 里有一段「崩溃自愈」逻辑 —— 动态 import 失败（chunk
404、被网关拦了、缓存了旧文件等）就 window.location.reload()，页面上看不出
任何错误，表现就是「登录后又回到登录页」。

所以这里把 index.html 和主 bundle 里引用到的每一个 /assets/ 文件都去
真实请求一遍，列出任何非 200 的。

用法: python3 scripts/check_frontend_chunks.py [网关地址]
"""
import re
import subprocess
import sys

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5186").rstrip("/")


def fetch(path, binary=False):
    cmd = ["curl", "-s", "--max-time", "15", "-o", "-", "-w", "\n%{http_code}",
           "-X", "GET", f"{BASE}{path}"]
    out = subprocess.run(cmd, capture_output=True)
    raw = out.stdout
    body, _, code = raw.rpartition(b"\n")
    return code.decode().strip(), (body if binary else body.decode("utf-8", "replace"))


def main():
    code, html = fetch("/index.html")
    print(f"index.html -> {code}")
    if code != "200":
        print("首页都拿不到，后面不用测了")
        return

    # index.html 里引用的资源
    refs = set(re.findall(r'["\'(/](assets/[^"\'\s)]+)', html))
    print(f"index.html 引用 {len(refs)} 个资源")

    # 主 bundle 里动态 import / 预加载引用的资源（懒加载 chunk 的来源）
    main_js = None
    for ref in sorted(refs):
        if ref.endswith(".js"):
            main_js = ref
    if main_js:
        c, js = fetch(f"/{main_js}")
        print(f"主 bundle {main_js} -> {c}, {len(js)} 字节")
        if c == "200":
            chunks = set(re.findall(r'["\'(](assets/[^"\'\s)]+\.(?:js|css))', js))
            print(f"主 bundle 里还动态引用了 {len(chunks)} 个 chunk/css")
            refs |= chunks

    bad = []
    print("\n逐个探测:")
    for ref in sorted(refs):
        c, body = fetch(f"/{ref}")
        note = ""
        if c != "200":
            note = body[:80]
            bad.append((ref, c))
        elif ref.endswith(".html"):
            note = "  <-- 注意：是 HTML 兜底页，不是真资源"
        print(f"  {c}  {ref}{note}")

    print()
    if bad:
        print(f"!! {len(bad)} 个资源拿不到：")
        for ref, c in bad:
            print(f"   {c}  {ref}")
    else:
        print(f"全部 {len(refs)} 个资源都返回 200")


if __name__ == "__main__":
    main()
