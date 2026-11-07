#!/usr/bin/env python3
"""发布 UI 静态 bundle 到生产目录（带备份与校验）。

用法：
  python3 scripts/_archive/deploy_ui_bundle.py \
      --source .pilotdeck/work/project-team-ui-build \
      --target /home/Marc/PilotDeck-src/ui/dist \
      --backup-root .pilotdeck/work/ui-dist-backups

流程：
  1. 记录发布前 target 的文件清单与 index.html 哈希；
  2. 将 target 完整备份到 backup-root/<时间戳>；
  3. 把 source 暂存到 target 同级目录 dist.staged-<时间戳>；
  4. 两次 rename 完成切换（窗口期仅毫秒级）；
  5. 校验发布后 index.html 与主 chunk 是否包含预期标记；
  6. 保留 target.prev-<时间戳> 作为即时回滚路径。

只做静态文件替换，不触碰服务进程。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

MARKERS = [
    ("pd-composer-agent-control", "项目团队 Agent 选择控件"),
    ("project-team-strip", "会话上方项目团队 strip"),
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_tree(src: Path, dst: Path) -> None:
    """复制目录树，刻意不继承 ACL / xattr / 原权限位。

    原因：源构建目录带有 POSIX ACL（owner 缺少 +x），若用 copytree/cp -a
    继承过来，目标目录将无法遍历（stat 报 Permission denied）。
    """
    subprocess.run(
        ["cp", "-r", "--no-preserve=mode,ownership,xattr", "-T", str(src), str(dst)],
        check=True,
    )
    normalize_permissions(dst)


def normalize_permissions(root: Path) -> None:
    """目录 0755、文件 0644，并清除继承来的 ACL，保证可遍历。"""
    for path in [root, *root.rglob("*")]:
        try:
            if path.is_dir() and not path.is_symlink():
                os.chmod(path, 0o755)
            elif not path.is_symlink():
                os.chmod(path, 0o644)
        except OSError:
            continue
    if shutil.which("setfacl"):
        subprocess.run(["setfacl", "-b", "-R", str(root)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def file_list(root: Path) -> list[str]:
    """列出相对路径；符号链接只记录链接本身，不跟随（避免权限/断链报错）。"""
    entries = []
    for path in root.rglob("*"):
        try:
            if path.is_symlink() or path.is_file():
                entries.append(str(path.relative_to(root)))
        except OSError:
            continue
    return sorted(entries)


def count_marker(root: Path, needle: str) -> int:
    hits = 0
    for path in root.rglob("*.js"):
        try:
            if needle in path.read_text(encoding="utf-8", errors="ignore"):
                hits += 1
        except OSError:
            continue
    return hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--backup-root", required=True)
    ap.add_argument("--keep-prev", action="store_true", default=True)
    args = ap.parse_args()

    source = Path(args.source).resolve()
    target = Path(args.target).resolve()
    backup_root = Path(args.backup_root).resolve()

    if not source.is_dir():
        print(f"FAIL | 源目录不存在: {source}")
        return 1
    if not target.is_dir():
        print(f"FAIL | 目标目录不存在: {target}")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = backup_root / stamp
    staged = target.parent / f"{target.name}.staged-{stamp}"
    prev = target.parent / f"{target.name}.prev-{stamp}"

    before_files = file_list(target)
    before_index = sha256(target / "index.html") if (target / "index.html").is_file() else None
    print(f"BEFORE | index.html sha256={before_index}")
    print(f"BEFORE | 文件数={len(before_files)}")

    backup_dir.mkdir(parents=True, exist_ok=True)
    copy_tree(target, backup_dir / target.name)
    print(f"BACKUP | {backup_dir / target.name}")

    if staged.exists():
        shutil.rmtree(staged)
    copy_tree(source, staged)
    staged_files = file_list(staged)
    print(f"STAGED | 文件数={len(staged_files)} 目录={staged}")

    os.rename(target, prev)
    os.rename(staged, target)
    print(f"SWAPPED | prev={prev} target={target}")

    after_index = sha256(target / "index.html")
    after_files = file_list(target)
    print(f"AFTER  | index.html sha256={after_index}")
    print(f"AFTER  | 文件数={len(after_files)}")

    ok = True
    for needle, label in MARKERS:
        hits = count_marker(target, needle)
        print(f"MARKER | {label} ({needle}) 命中 JS 文件数={hits}")
        if hits == 0:
            ok = False

    if not ok:
        print("FAIL | 标记缺失，正在回滚")
        shutil.rmtree(target, ignore_errors=True)
        os.rename(prev, target)
        print(f"ROLLED BACK | target={target}")
        return 2

    if args.keep_prev:
        print(f"ROLLBACK PATH | {prev}")
    else:
        shutil.rmtree(prev, ignore_errors=True)

    print(f"OK | 备份 {backup_dir} | 即时回滚 {prev}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
