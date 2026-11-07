#!/usr/bin/env python3
"""把「显式请求项目审查员」的 WS 分支补丁到 live checkout 的 ui/server/index.js。

为什么需要这个脚本
------------------
live checkout（默认 /home/Marc/PilotDeck-src）的 ``ui/server/index.js`` 与仓库
HEAD 的同名文件**已经分叉**：live 侧多出 ``/api/usage`` 路由与 ``createUsageRouter``
导入，属于 live 独有的本地改动。``scripts/sync_project_team_runtime.py`` 的 preflight
会把这种文件判为 "no-local-edit"（本地改动未被评审集覆盖）并**拒绝覆盖**，直接整文件
覆盖则会静默删掉 live 的 ``/api/usage`` 能力。

因此这里只做**外科式补丁**：从仓库（评审过的源）里抽取本次新增的两处代码

  1. ``import { ..., requestProjectReview, ... }``
  2. ``data.type === 'project-review-request'`` 的 WS 分支

按锚点插入 live 文件，不动其它任何字节。补丁内容直接取自评审过的源文件，避免手抄漂移。

安全模型
--------
* 幂等：目标文件里已经出现 ``project-review-request`` 时直接跳过。
* 先备份再改：目标文件写入前复制到 ``<backup-root>/<时间戳>/index.js``。
* 语法校验：写入后用 ``node --check`` 验证，失败自动回滚。
* ``--dry-run`` 只打印将要插入的内容，不写任何字节。

用法
----
    python3 scripts/patch_live_review_branch.py --dry-run
    python3 scripts/patch_live_review_branch.py
"""
from __future__ import annotations

import argparse
import datetime
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "pilotdeck-mobile" / "upstream-official"
DEFAULT_TARGET = Path("/home/Marc/PilotDeck-src")
DEFAULT_BACKUP_ROOT = REPO_ROOT / ".pilotdeck" / "work" / "live-patch-backups"

IMPORT_ANCHOR = "    runChatViaGateway,\n"
IMPORT_NEW = "    requestProjectReview,\n"

BRANCH_START = "            } else if (data.type === 'project-review-request') {\n"
BRANCH_END = "            } else if (data.type === 'get-input-queue') {\n"

BRANCH_ANCHOR = (
    "                await runChatViaGateway(data.command, data.options, streamWriter, providerHint);\n"
)


def extract_branch(source_text: str) -> str:
    """抽出评审源里新增的 WS 分支（含首尾分支标记）。"""
    start = source_text.find(BRANCH_START)
    if start < 0:
        raise SystemExit("源文件里找不到 project-review-request 分支")
    end = source_text.find(BRANCH_END, start)
    if end < 0:
        raise SystemExit("源文件里找不到分支结束锚点")
    return source_text[start:end]


def node_check(path: Path) -> tuple[int, str]:
    proc = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    return proc.returncode, (proc.stderr or "").strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--target", default=str(DEFAULT_TARGET))
    parser.add_argument("--backup-root", default=str(DEFAULT_BACKUP_ROOT))
    parser.add_argument("-n", "--dry-run", action="store_true")
    args = parser.parse_args(argv)

    source_root = Path(args.source).expanduser().resolve()
    target_root = Path(args.target).expanduser().resolve()
    backup_root = Path(args.backup_root).expanduser().resolve()

    source_file = source_root / "ui" / "server" / "index.js"
    target_file = target_root / "ui" / "server" / "index.js"
    for path in (source_file, target_file):
        if not path.is_file():
            print(f"FATAL | 找不到 {path}", file=sys.stderr)
            return 2

    source_text = source_file.read_text(encoding="utf-8")
    target_text = target_file.read_text(encoding="utf-8")

    if "project-review-request" in target_text:
        print("SKIP | 目标文件已包含 project-review-request 分支，无需补丁")
        return 0

    branch = extract_branch(source_text)
    if IMPORT_ANCHOR not in target_text:
        print(f"FATAL | 目标文件里找不到 import 锚点 {IMPORT_ANCHOR!r}", file=sys.stderr)
        return 2
    if BRANCH_ANCHOR not in target_text:
        print(f"FATAL | 目标文件里找不到分支锚点 {BRANCH_ANCHOR!r}", file=sys.stderr)
        return 2

    patched = target_text.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT_NEW, 1)
    patched = patched.replace(BRANCH_ANCHOR, BRANCH_ANCHOR + branch, 1)

    print("== 将要插入的内容 ==")
    print(IMPORT_NEW, end="")
    print(branch, end="")
    print(f"目标文件：{target_file}")
    print(f"字节数：{len(target_text.encode())} -> {len(patched.encode())}")

    if args.dry_run:
        print("DRY RUN | 未写入任何字节")
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = backup_root / stamp
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_file = backup_dir / "index.js"
    shutil.copy2(target_file, backup_file)
    print(f"BACKUP | {backup_file}")

    target_file.write_text(patched, encoding="utf-8")
    code, err = node_check(target_file)
    if code != 0:
        shutil.copy2(backup_file, target_file)
        print(f"FAIL | node --check 失败，已回滚：{err}", file=sys.stderr)
        return 1

    print("OK | 补丁已写入并通过 node --check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
