#!/usr/bin/env python3
"""M4 验收：外部 agent 一次导一批 —— 去重、冲突提示、多 agent 同流。

    python3 scripts/verify_import.py [--api http://127.0.0.1:8899] [--keep-server]

自带服务：端口被占就不起，直接用现有那个；否则拉一个 serve_test 起来，退出时收掉。
"""
from __future__ import annotations
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server

import argparse
import json
import os
import shutil
import signal
import subprocess
import tempfile
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PASS, FAIL = [], []


def check(ok, name, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def req(api, path, method="GET", payload=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(api + path, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def up(api):
    try:
        req(api, "/api/artifacts/health", timeout=3)
        return True
    except Exception:
        return False


def port_busy(port):
    """端口上还有没有人听。"""
    import socket
    s = socket.socket()
    try:
        s.settimeout(0.5)
        s.connect(("127.0.0.1", int(port)))
        return True
    except OSError:
        return False
    finally:
        s.close()


def kill_stale_servers(port):
    """只清 serve_test.py 留下的残留，不碰别的进程。"""
    try:
        out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True,
                             text=True, timeout=10).stdout
    except Exception:
        return
    me = os.getpid()
    victims = []
    for line in out.splitlines():
        line = line.strip()
        if not line or "serve_test.py" not in line or "ps -eo" in line:
            continue
        pid_s = line.split(None, 1)[0]
        if not pid_s.isdigit() or int(pid_s) == me:
            continue
        if f"--port {port}" not in line:
            continue
        victims.append(int(pid_s))

    for pid in victims:
        # aiohttp 有时不吃 SIGTERM，直接上 SIGKILL，省得在这儿耗
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
            except Exception:
                break
            for _ in range(15):
                time.sleep(0.1)
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
            else:
                continue
            break
        print(f"  清掉端口 {port} 上的残留测试服务（pid {pid}）", flush=True)


def start_server(api, keep=False):
    """起一个测试服务，保证跑的是当前这份代码。

    以前这里只要端口上有东西在听就直接复用，结果非常坑：
    端口上留着的是改动之前起的老进程 —— 路由还没有 DELETE，
    浏览器里点删除拿到 405，排查半天才发现根本不是代码的问题。
    所以这里先清掉自己家的残留进程，绝不复用来路不明的服务。

    **但不能对外部托管的服务动这个手**：run_all_verify.sh 起的是一套
    共用服务，它自己的 --api 指过来的时候如果还去 kill_stale_servers，
    就会把后面所有用例的服务器杀掉 —— 表现是「import 之后的用例集体
    ECONNREFUSED」，看起来像代码炸了，其实是这个脚本动了手。
    认 ARTIFACTS_API 环境变量作为「别碰，它有主人」的信号。
    """
    if os.environ.get("ARTIFACTS_API"):
        print(f"  用外部托管的服务 {api}（由 ARTIFACTS_API 指定，不接管）", flush=True)
        return None
    port = api.rsplit(":", 1)[-1]
    kill_stale_servers(port)
    for _ in range(30):                      # 等端口真正松开，不然新进程 bind 失败
        if not port_busy(port):
            break
        time.sleep(0.2)
    if up(api):
        print(f"  用已在跑的服务 {api}", flush=True)
        return None
    log = open("/tmp/artifacts-serve.log", "ab")
    # 自起服务时必须显式给一个隔离数据目录。漏了这行，serve_test.py 会退回
    # artifacts_console 的默认值（项目里的 .artifacts-data），于是「跑验收」
    # 直接往正式成果台里写 —— 验收写的 shot.png / plan.svg 混进你的正式成果，
    # 左栏被几百条测试项淹没就是这么来的。
    env = dict(os.environ)
    if not env.get("ARTIFACTS_DATA_DIR"):
        env["ARTIFACTS_DATA_DIR"] = tempfile.mkdtemp(prefix="artifacts-verify-")
        env["ARTIFACTS_TOKEN"] = env.get("ARTIFACTS_TOKEN") or f"verify-{os.getpid()}"
        print(f"  自起服务，数据目录隔离在 {env['ARTIFACTS_DATA_DIR']}", flush=True)
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "serve_test.py"), "--port", port],
                            cwd=ROOT, stdout=log, stderr=log, env=env)
    for _ in range(60):
        if up(api):
            print(f"  已起测试服务 {api}（pid {proc.pid}）", flush=True)
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.4)
    print("  测试服务起不来，看 /tmp/artifacts-serve.log", flush=True)
    return proc


HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>%s</title>
<style>body{font:16px system-ui;background:#0b1020;color:#e9eef9;padding:40px}</style>
</head><body><h1>%s</h1><p>%s</p></body></html>"""


def build_dir(path, tag, rev=1):
    """造一个「外部 agent 的产出目录」：页面 + 图 + 图纸 + 该被跳过的杂项。

    rev 改内容但标题不变 —— 这才是「同名不同内容」的冲突场景；
    每次改完要重新调用一次，磁盘上的内容才会跟着变。
    """
    os.makedirs(os.path.join(path, "node_modules"), exist_ok=True)
    os.makedirs(os.path.join(path, ".cache"), exist_ok=True)
    title = f"外部页面 {tag}"
    open(os.path.join(path, "index.html"), "w", encoding="utf-8").write(
        HTML % (title, title, f"第 {rev} 版正文"))
    open(os.path.join(path, "shot.png"), "wb").write(
        b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * (rev if rev > 1 else 1))
    open(os.path.join(path, "plan.svg"), "w", encoding="utf-8").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">'
        f'<rect width="200" height="120" fill="#123"/><text x="20" y="60">{tag} v{rev}</text></svg>')
    open(os.path.join(path, "notes.md"), "w", encoding="utf-8").write("不该被导入的杂项")
    open(os.path.join(path, "junk.tmp"), "w", encoding="utf-8").write("写一半的临时文件")
    open(os.path.join(path, "node_modules", "dep.html"), "w", encoding="utf-8").write("<p>依赖目录不该进来</p>")
    open(os.path.join(path, ".cache", "hidden.html"), "w", encoding="utf-8").write("<p>隐藏目录不该进来</p>")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
    ap.add_argument("--keep-server", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="确实要写进这个数据目录（默认拒绝写正式库）")
    args = ap.parse_args()
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。护栏放在 parse_args 之后。
    try:
        assert_test_server(getattr(args, "api", None), getattr(args, "token", None) or os.environ.get("ARTIFACTS_TOKEN"), force=getattr(args, "force", False))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    api = args.api.rstrip("/")
    proc = start_server(api, keep=args.keep_server)
    tag = str(int(time.time()))
    # agent 名带上 run 标记：否则上一轮跑过的同名文件会被去重掉，测的就不是新链路了
    agent_a, agent_b = f"opencode-{tag}", f"opencode2-{tag}"
    # 造样本的目录也跟着数据目录隔离：否则每次跑回归都会在真 .artifacts-data
    # 里留一堆 m4import-<时间戳> 垃圾
    sandbox = os.environ.get("ARTIFACTS_DATA_DIR") or os.path.join(ROOT, ".artifacts-data")
    src = os.path.join(sandbox, f"m4import-{tag}")
    os.makedirs(src, exist_ok=True)

    try:
        print("\n[1 dry-run：先看清楚会导什么]", flush=True)
        build_dir(src, tag)
        r = req(api, "/api/artifacts/import", "POST",
                {"dir": src, "agent": agent_a, "dry_run": True})
        c = r["counts"]
        check(c["imported"] == 3, "dry-run 认出 3 个可导文件", f"{c}")
        check(r["dry_run"] is True and c["candidates"] == 3,
              "md/tmp/node_modules/.cache 都没混进来", f"candidates={c['candidates']}")
        check(req(api, f"/api/artifacts?agent={agent_a}&limit=5")["total"] == 0,
              "dry-run 没真写库")

        print("\n[2 真导 + 重复导入去重]", flush=True)
        r = req(api, "/api/artifacts/import", "POST", {"dir": src, "agent": agent_a})
        check(r["counts"]["imported"] == 3, "一次导入 3 件", json.dumps(r["counts"], ensure_ascii=False))
        titles = {i["title"] for i in r["imported"]}
        check(any(t.startswith("外部页面") for t in titles), "html 标题取自 <title>",
              " / ".join(sorted(titles))[:70])
        kinds = {i["kind"] for i in r["imported"]}
        check(kinds == {"page", "image", "drawing"}, "扩展名决定类型", " ".join(sorted(kinds)))

        again = req(api, "/api/artifacts/import", "POST", {"dir": src, "agent": agent_a})
        check(again["counts"]["imported"] == 0 and again["counts"]["skipped"] == 3,
              "再导一次全是「重复导入」", json.dumps(again["counts"], ensure_ascii=False))
        check(all("重复" in s["reason"] for s in again["skipped"]), "跳过理由写清楚了")

        print("\n[3 冲突：同名不同内容]", flush=True)
        build_dir(src, tag, rev=2)
        dry = req(api, "/api/artifacts/import", "POST",
                  {"dir": src, "agent": agent_a, "dry_run": True})
        check(dry["counts"]["conflicts"] == 3, "同名不同内容被识别为冲突",
              json.dumps(dry["counts"], ensure_ascii=False))

        skipped = req(api, "/api/artifacts/import", "POST",
                      {"dir": src, "agent": agent_a, "on_conflict": "skip"})
        check(skipped["counts"]["imported"] == 0 and skipped["counts"]["conflicts"] == 3,
              "策略 skip：不覆盖原成果", json.dumps(skipped["counts"], ensure_ascii=False))

        ver = req(api, "/api/artifacts/import", "POST",
                  {"dir": src, "agent": agent_a, "on_conflict": "version"})
        check(ver["counts"]["imported"] == 3 and
              all(i["action"] == "versioned" and i["version"] == 2 for i in ver["imported"]),
              "策略 version：接在原成果后开 v2",
              ", ".join(f"{i['title'][:8]}→v{i['version']}" for i in ver["imported"]))

        chain = req(api, f"/api/artifacts/{ver['imported'][0]['id']}/chain")
        check(len(chain.get("chain") or []) >= 2, "版本链连上了",
              f"{len(chain.get('chain') or [])} 版")

        build_dir(src, tag, rev=3)   # 又改了：这次是新内容，才轮得到「另起一条」策略
        newp = req(api, "/api/artifacts/import", "POST",
                   {"dir": src, "agent": agent_a, "on_conflict": "new"})
        check(newp["counts"]["imported"] == 3 and
              all("导入" in i["title"] for i in newp["imported"]) and
              all(i["version"] == 1 for i in newp["imported"]),
              "策略 new：另起 v1，标题带内容指纹，不混进原链",
              ", ".join(i["title"][:26] for i in newp["imported"])[:96])

        print("\n[4 多 agent 同流]", flush=True)
        # 同一批文件换个 agent 身份再导一次：各算各的，不该被判成冲突
        fresh = req(api, "/api/artifacts/import", "POST", {"dir": src, "agent": agent_b})
        check(fresh["counts"]["imported"] == 3 and fresh["counts"]["conflicts"] == 0 and
              all(i["version"] == 1 for i in fresh["imported"]),
              "另一个 agent 导同一批 = 各算各的，不算冲突",
              json.dumps(fresh["counts"], ensure_ascii=False))

        mine = req(api, f"/api/artifacts?agent={agent_a}&limit=50")
        theirs = req(api, f"/api/artifacts?agent={agent_b}&limit=50")
        # pilotdeck 那一路自己登记一件：不能指望库里「正好有」别的脚本留下的数据
        # （之前在干净数据目录下跑就挂过：断言依赖历史残留，换台机器必挂）
        req(api, "/api/artifacts", "POST",
            {"agent": "pilotdeck", "kind": "image", "title": f"本地成果 {tag}"})
        pilot = req(api, "/api/artifacts?agent=pilotdeck&limit=5")
        check(mine["total"] >= 3 and theirs["total"] >= 3 and pilot["total"] >= 1,
              "按 agent 分流互不串味",
              f"A={mine['total']} B={theirs['total']} pilotdeck={pilot['total']}")
        allitems = req(api, "/api/artifacts?limit=200")["artifacts"]
        check(any(a["agent"] == agent_a for a in allitems) and
              any(a["agent"] == "pilotdeck" for a in allitems),
              "总列表里两类 agent 并排出现")
        agents = sorted({a["agent"] for a in allitems})
        check(len(agents) >= 3, "总表 agent 维度", " ".join(agents))

        print("\n[5 审计留痕]", flush=True)
        aud = req(api, f"/api/artifacts/{ver['imported'][0]['id']}/audit?limit=20")
        events = [e.get("event") for e in (aud.get("audit") or [])]
        check("artifact.created" in events, "导入的成果有审计记录", " ".join(events[:4]))

        print("\n[6 CLI：外部 agent 不装插件也能用]", flush=True)
        cli = os.path.join(HERE, "artifacts_cli.py")
        p = subprocess.run([sys.executable, cli, "--base", api, "import", src,
                            "--agent", agent_a, "--dry-run"],
                           capture_output=True, text=True, timeout=60)
        check(p.returncode == 0 and "导入" in p.stdout, "CLI import 可用（dry-run）",
              p.stdout.strip().replace("\n", " | ")[:90])

        shutil.rmtree(src, ignore_errors=True)
    finally:
        if proc and proc.poll() is None and not args.keep_server:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            print(f"  测试服务已收（pid {proc.pid}）", flush=True)

    print("\n" + "=" * 56, flush=True)
    print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败（共 {len(PASS) + len(FAIL)} 项）", flush=True)
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}", flush=True)
        sys.exit(1)
    print("全部通过 ✓", flush=True)


if __name__ == "__main__":
    # 必须把 main() 的返回值交给 SystemExit：护栏拒绝时 return 3，
    # 直接 main() 会把返回值丢掉、退出码恒为 0，回归脚本会以为这套「通过了」。
    raise SystemExit(main() or 0)
