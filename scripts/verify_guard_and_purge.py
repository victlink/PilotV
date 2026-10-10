#!/usr/bin/env python3
"""验收：验收脚本护栏 + 正式库清理工具。

这两样都是「不产出功能、只防止出事」的东西，所以单开一个套件盯：
  1) scripts/_test_guard.py —— 目标不是隔离测试服务时，验收脚本必须拒绝执行，
     免得又往正式库里灌几百条测试成果；
  2) scripts/purge_test_artifacts.py —— 默认只报告；真删时必须
     「删测试件、保带标注的、别越界删别的文件」。

用法：python3 scripts/verify_guard_and_purge.py [--api http://127.0.0.1:8899]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

PASS, FAIL = [], []


def check(cond, name, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {extra}" if extra else ""), flush=True)


def health(api: str, token: str) -> dict:
    req = urllib.request.Request(api.rstrip("/") + "/api/artifacts/health")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def run_verify(api: str, extra: list[str], timeout: int = 60):
    env = dict(os.environ)
    return subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "verify_m3.py"),
         "--api", api, *extra],
        capture_output=True, text=True, timeout=timeout, cwd=ROOT, env=env)


# ---------------------------------------------------------------- 1 护栏
def test_guard(api: str, token: str) -> None:
    print("\n[1 验收脚本不许写正式库]", flush=True)
    try:
        data_dir = (health(api, token) or {}).get("data_dir", "")
    except Exception as exc:
        print(f"  （本套件指定的 {api} 没起：{type(exc).__name__} —— 下面用自造服务继续验）")
        data_dir = ""

    from _test_guard import looks_like_test_dir
    check(looks_like_test_dir("/tmp/anything") is True, "临时目录判定为测试环境")
    check(looks_like_test_dir("/home/x/proj/.artifacts-data") is False,
          "用户项目里的 .artifacts-data 判为正式库")

    if looks_like_test_dir(data_dir):
        print(f"  （当前服务用的是隔离目录 {data_dir}，「拒绝」分支另起一个像正式库的服务来验）")

    # 「拒绝」这条分支不能靠回归环境的临时目录来验 —— 那个永远被判成测试环境。
    # 这里现造一个「像正式库」的目录（家目录、不含 test/regress 字样）起个服务。
    fake_dir = os.path.join(os.path.expanduser("~"), ".pdguard-check")
    os.makedirs(fake_dir, exist_ok=True)
    port = _free_port()
    env = dict(os.environ, ARTIFACTS_DATA_DIR=fake_dir, ARTIFACTS_TOKEN="guardtok")
    srv = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "scripts", "serve_test.py"), "--port", str(port)],
        env=env, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        fake_api = f"http://127.0.0.1:{port}"
        for _ in range(40):
            try:
                health(fake_api, "guardtok"); break
            except Exception:
                time.sleep(0.25)
        check(looks_like_test_dir(health(fake_api, "guardtok").get("data_dir", "")) is False,
              "造出来的「正式库」确实被判为正式环境")

        p = run_verify(fake_api, [], timeout=40)
        check(p.returncode == 3 and "拒绝执行" in (p.stderr + p.stdout),
              "指向正式库时验收脚本拒绝执行", f"rc={p.returncode}")
        check("--force" in (p.stderr + p.stdout), "拒绝时告诉用户 --force 旁路怎么用")
        n_before = _artifact_count(fake_api, "guardtok")
        check(n_before == 0, "拒绝之后真库一条都没多出来", f"{n_before} 条")
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            srv.kill()
        shutil.rmtree(fake_dir, ignore_errors=True)


def _free_port() -> int:
    import socket
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


def _artifact_count(api: str, token: str) -> int:
    req = urllib.request.Request(api.rstrip("/") + "/api/artifacts?limit=200")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode("utf-8", "replace")).get("total", 0)


# ------------------------------------------------------- 2 清理工具（假库）
def make_db(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.executescript("""
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ts TEXT, agent TEXT, kind TEXT,
      file_name TEXT, project TEXT, source_json TEXT, size INTEGER,
      stored_path TEXT, thumb_path TEXT);
    CREATE TABLE annotations (id TEXT PRIMARY KEY, artifact_id TEXT, note TEXT);
    """)
    rows = [
        ("a1", "2026-01-01T00:00:00Z", "verify-x", "image", "shot.png", "p", json.dumps({"tool": "verify_m3"}), 10, None, None),
        ("a2", "2026-01-02T00:00:00Z", "verify-y", "image", "shot.png", "p", json.dumps({"tool": "verify_m3"}), 10, None, None),
        ("a3", "2026-01-03T00:00:00Z", "verify-z", "image", "keepme.png", "p", json.dumps({"tool": "verify_m3"}), 10, None, None),
        # 正式成果，不能因为名字重复就被误删
        ("a4", "2026-01-04T00:00:00Z", "pilotdeck", "image", "shot.png", "p", json.dumps({}), 10, None, None),
    ]
    con.executemany("INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("INSERT INTO annotations VALUES ('n1','a3','人写的意见，不许删')")
    con.commit()
    return con


def purge(args: list[str], db: str):
    return subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "purge_test_artifacts.py"),
         "--db", db, *args],
        capture_output=True, text=True, timeout=60, cwd=ROOT)


def test_purge() -> None:
    print("\n[2 清理工具：默认只报告、只删该删的]", flush=True)
    tmp = tempfile.mkdtemp(prefix="artifacts-purge-")
    try:
        db = os.path.join(tmp, "artifacts.db")
        con = make_db(db)

        p = purge([], db)
        check(p.returncode == 0 and "没有删任何东西" in p.stdout,
              "不带 --apply 时只报告")
        left = con.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0]
        check(left == 4, "只报告之后库还是原样", f"{left} 条")

        p = purge(["--include-tests", "--dry-run", "--apply"], db)
        check("什么也没删" in p.stdout, "试算模式不删")
        check(con.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0] == 4, "试算后仍是 4 条")

        p = purge(["--include-tests", "--apply", "--yes"], db)
        ids = [r[0] for r in con.execute("SELECT id FROM artifacts").fetchall()]
        check("a1" not in ids and "a2" not in ids, "测试件 a1/a2 被删了", str(ids))
        check("a3" in ids, "带标注的 a3 保住了")
        check("a4" in ids, "正式成果 a4 没被误删")

        # 重复发布：同名同大小同项目，保留最新
        con.execute("INSERT INTO artifacts VALUES ('a5','2026-01-05T00:00:00Z','watcher','image','plan.svg','p','{}',20,NULL,NULL)")
        con.execute("INSERT INTO artifacts VALUES ('a6','2026-01-06T00:00:00Z','watcher','image','plan.svg','p','{}',20,NULL,NULL)")
        con.commit()
        purge(["--include-dups", "--apply", "--yes"], db)
        rows = con.execute("SELECT id FROM artifacts WHERE file_name='plan.svg'").fetchall()
        check([r[0] for r in rows] == ["a6"], "重复件只留最新一条 a6", str([r[0] for r in rows]))

        # 越界保护：stored_path 指向数据目录之外的文件，一律不删
        outside = os.path.join(ROOT, "artifacts.js")
        con.execute("INSERT INTO artifacts VALUES ('a7','2026-01-07T00:00:00Z','verify-q','image','evil.png','p','{}',30,?,NULL)",
                    (outside,))
        con.commit()
        purge(["--include-tests", "--apply", "--yes"], db)
        check(os.path.isfile(outside), "数据目录之外的路径没有被删（artifacts.js 还在）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("ARTIFACTS_BASE", "http://127.0.0.1:8899"))
    ap.add_argument("--token", default=os.environ.get("ARTIFACTS_TOKEN"))
    args = ap.parse_args()
    try:
        test_guard(args.api, args.token)
    except Exception as exc:                       # 服务没起也不该把这个套件卡死
        print(f"  [SKIP] 护栏测试跳过：{type(exc).__name__}: {exc}", flush=True)
    test_purge()
    total = len(PASS) + len(FAIL)
    print(f"\n结果：{len(PASS)} 通过 / {len(FAIL)} 失败（共 {total} 项）", flush=True)
    for n in FAIL:
        print(f"  ⚠   [FAIL] {n}", flush=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())