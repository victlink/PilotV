#!/usr/bin/env python3
"""把「评审过的增量」套用到 live checkout 的后端文件上。

为什么需要这个脚本
------------------
``scripts/sync_project_team_runtime.py`` 的 preflight 会把 live checkout 里
「相对它自己那个较旧的 git HEAD 的本地改动」判为 *不可覆盖* 并拒绝同步。
对本次评审来说这属于误判：live 的 ``ui/server/pilotdeck-bridge.js`` 与**评审基线
提交**逐字节一致（它就是上一次评审同步过去的版本），相对 live 自己的 HEAD 看到的
"本地改动" 其实正是上一轮评审成果。直接整文件覆盖是正确的，但必须证明**没有丢掉
live 独有的东西**。

安全模型
--------
对每个文件：

1. live 目标必须是普通文件（拒绝软链接）；
2. live 现状必须与**评审基线** ``git show <baseline>:<path>`` 逐字节一致；
   不一致就 REFUSE —— 说明 live 已经偏离基线，套用增量会丢东西；
3. 写入前把 live 原文件备份到 ``<backup-root>/<时间戳>/<原路径>``；
4. 写入后校验：
   - live 前后差异 == 基线与评审源差异（逐行 unified diff 一致）；
   - ``node --check`` 语法校验通过；
   任一校验失败立即从备份回滚。

用法
----
    python3 scripts/_archive/sync_reviewed_backend_delta.py --dry-run
    python3 scripts/_archive/sync_reviewed_backend_delta.py
"""
from __future__ import annotations

import argparse
import datetime
import difflib
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT
DEFAULT_TARGET = Path("/home/Marc/PilotDeck-src")
DEFAULT_BACKUP_ROOT = REPO_ROOT / ".pilotdeck" / "work" / "live-patch-backups"
DEFAULT_BASELINE = "3ea675e"
DEFAULT_SOURCE_PREFIX = "pilotdeck-mobile/upstream-official"
DEFAULT_FILES = ("ui/server/pilotdeck-bridge.js",)


def git_bytes(repo: Path, revision: str, rel: str) -> bytes | None:
    proc = subprocess.run(
        ["git", "-C", str(repo), "show", f"{revision}:{rel}"],
        capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def unified(a: bytes, b: bytes) -> str:
    return "\n".join(
        difflib.unified_diff(
            a.decode("utf-8").splitlines(),
            b.decode("utf-8").splitlines(),
            lineterm="",
            n=3,
        )
    )


def node_check(path: Path) -> tuple[int, str]:
    proc = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    return proc.returncode, (proc.stderr or "").strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--target", default=str(DEFAULT_TARGET))
    parser.add_argument("--backup-root", default=str(DEFAULT_BACKUP_ROOT))
    parser.add_argument("--baseline", default=DEFAULT_BASELINE, help="评审基线提交")
    parser.add_argument(
        "--source-prefix",
        default=DEFAULT_SOURCE_PREFIX,
        help="评审源在仓库里的前缀（目标路径 = 去掉该前缀）",
    )
    parser.add_argument("--files", nargs="*", default=list(DEFAULT_FILES))
    parser.add_argument("-n", "--dry-run", action="store_true")
    args = parser.parse_args(argv)

    source = Path(args.source).expanduser().resolve()
    target = Path(args.target).expanduser().resolve()
    backup_root = Path(args.backup_root).expanduser().resolve()

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    failed = False

    for rel in args.files:
        repo_rel = f"{args.source_prefix}/{rel}" if args.source_prefix else rel
        src = source / repo_rel
        dst = target / rel
        print(f"== {rel} ==")
        if not src.is_file():
            print(f"  REFUSE | 评审源缺失 {src}", file=sys.stderr)
            failed = True
            continue
        if dst.is_symlink():
            print(f"  REFUSE | 目标是软链接 {dst}", file=sys.stderr)
            failed = True
            continue
        if not dst.is_file():
            print(f"  REFUSE | 目标不存在 {dst}", file=sys.stderr)
            failed = True
            continue

        base = git_bytes(source, args.baseline, repo_rel)
        if base is None:
            print(f"  REFUSE | 取不到基线 {args.baseline}:{rel}", file=sys.stderr)
            failed = True
            continue

        before = dst.read_bytes()
        after = src.read_bytes()
        if before != base:
            print("  REFUSE | live 现状与评审基线不一致，套用增量可能丢内容", file=sys.stderr)
            failed = True
            continue
        if before == after:
            print("  SKIP | 已经等于评审源")
            continue

        delta = unified(base, after)
        print(f"  基线一致 | live == {args.baseline}:{rel}")
        print(f"  增量行数 | {len(delta.splitlines())} 行 unified diff")
        if args.dry_run:
            print("  DRY RUN | 未写入任何字节")
            continue

        backup = backup_root / stamp / rel
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dst, backup)
        print(f"  BACKUP | {backup}")

        dst.write_bytes(after)
        applied = unified(before, dst.read_bytes())
        if applied != delta:
            shutil.copy2(backup, dst)
            print("  FAIL | 实际差异与评审增量不一致，已回滚", file=sys.stderr)
            failed = True
            continue
        code, err = node_check(dst)
        if code != 0:
            shutil.copy2(backup, dst)
            print(f"  FAIL | node --check 失败，已回滚：{err}", file=sys.stderr)
            failed = True
            continue
        print("  OK | 已套用评审增量，差异一致且通过 node --check")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
