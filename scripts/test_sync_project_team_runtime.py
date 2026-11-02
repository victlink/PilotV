"""Regression tests for ``scripts/sync_project_team_runtime.py``.

The tests never touch the live checkout: every scenario runs against a
temporary source tree and a temporary git repository created by the test
itself.
"""
from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parent / "sync_project_team_runtime.py"
_spec = importlib.util.spec_from_file_location("sync_project_team_runtime", MODULE_PATH)
assert _spec and _spec.loader
sync_mod = importlib.util.module_from_spec(_spec)
# dataclasses resolves annotations through sys.modules, so register first.
sys.modules["sync_project_team_runtime"] = sync_mod
_spec.loader.exec_module(sync_mod)

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = REPO_ROOT / "pilotdeck-mobile" / "upstream-official"

IMPORT_RE = re.compile(r"""from\s+["'](\.[^"']+)["']""")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), "-c", "commit.gpgsign=false", *args],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def make_git_repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True, capture_output=True)
    git(path, "config", "user.email", "sync-test@example.com")
    git(path, "config", "user.name", "sync test")
    for name, content in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    git(path, "add", "-A")
    git(path, "commit", "-q", "--allow-empty", "-m", "base")
    return path


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# --------------------------------------------------------------------------- #
# file list
# --------------------------------------------------------------------------- #
def test_write_scope_is_part_of_the_sync_list():
    assert "src/permission/policy/writeScope.ts" in sync_mod.FILES


def test_every_listed_file_exists_in_the_vendored_source():
    if not SOURCE_ROOT.is_dir():
        pytest.skip("vendored source tree is not present")
    missing = [name for name in sync_mod.FILES if not (SOURCE_ROOT / name).is_file()]
    assert missing == []


def test_new_dependencies_of_synced_files_are_listed():
    """A reviewed file that is new to the vendored tree must be synced too.

    ``src/permission/index.ts`` and ``PermissionRuntime.ts`` import
    ``src/permission/policy/writeScope.ts``; when that module is missing from
    the list the live checkout ends up importing a file that was never copied.
    """
    if not SOURCE_ROOT.is_dir():
        pytest.skip("vendored source tree is not present")

    def tracked(rel: str) -> bool:
        proc = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files", "--error-unmatch", "--", rel],
            capture_output=True,
        )
        return proc.returncode == 0

    unlisted: list[str] = []
    for name in sync_mod.FILES:
        source_file = SOURCE_ROOT / name
        for spec in IMPORT_RE.findall(source_file.read_text(encoding="utf-8")):
            if not spec.endswith(".js"):
                continue
            base = (source_file.parent / spec[: -len(".js")]).resolve()
            for suffix in (".ts", ".tsx", ".js"):
                candidate = base.with_name(base.name + suffix)
                if candidate.is_file():
                    rel = candidate.relative_to(SOURCE_ROOT).as_posix()
                    if not tracked(f"pilotdeck-mobile/upstream-official/{rel}") and rel not in sync_mod.FILES:
                        unlisted.append(f"{name} -> {rel}")
                    break
    assert unlisted == []


# --------------------------------------------------------------------------- #
# preflight behaviour
# --------------------------------------------------------------------------- #
def test_local_edit_conflicts_flags_unrelated_change():
    base = b"line1\nline2\n"
    local = b"line1\nline2\nlocal unrelated work\n"
    source = b"line1\nreviewed\nline2\n"
    reasons = sync_mod.local_edit_conflicts(base, local, source)
    assert reasons, "an unrelated local edit must be reported"


def test_local_edit_conflicts_accepts_superseded_change():
    base = b"line1\nline2\n"
    local = b"line1\nreviewed\nline2\n"
    source = b"line1\nreviewed\nreviewed extra\nline2\n"
    assert sync_mod.local_edit_conflicts(base, local, source) == []


def test_unrelated_tracked_modification_is_refused(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    write(source / "a.ts", "line1\nreviewed\nline2\n")
    make_git_repo(target, {"a.ts": "line1\nline2\n"})
    write(target / "a.ts", "line1\nline2\nlocal unrelated work\n")

    with pytest.raises(sync_mod.SyncError):
        sync_mod.sync(
            source=source,
            target=target,
            files=("a.ts",),
            backup_root=backup_root,
        )

    # nothing was written: the target still holds the local work, and no
    # backup directory was created.
    assert (target / "a.ts").read_text(encoding="utf-8") == "line1\nline2\nlocal unrelated work\n"
    assert not backup_root.exists()


def test_conflict_blocks_every_other_write(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    write(source / "a.ts", "line1\nreviewed\nline2\n")
    write(source / "b.ts", "brand new\n")
    make_git_repo(target, {"a.ts": "line1\nline2\n"})
    write(target / "a.ts", "line1\nline2\nlocal unrelated work\n")

    with pytest.raises(sync_mod.SyncError):
        sync_mod.sync(
            source=source,
            target=target,
            files=("a.ts", "b.ts"),
            backup_root=backup_root,
        )

    assert not (target / "b.ts").exists()
    assert not backup_root.exists()


def test_superseded_tracked_edit_is_allowed_and_backed_up(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    write(source / "a.ts", "line1\nreviewed\nreviewed extra\nline2\n")
    make_git_repo(target, {"a.ts": "line1\nline2\n"})
    write(target / "a.ts", "line1\nreviewed\nline2\n")

    result = sync_mod.sync(
        source=source,
        target=target,
        files=("a.ts",),
        backup_root=backup_root,
    )

    assert (target / "a.ts").read_text(encoding="utf-8") == "line1\nreviewed\nreviewed extra\nline2\n"
    assert result.backup_dir is not None
    backup = result.backup_dir / "a.ts"
    assert backup.read_text(encoding="utf-8") == "line1\nreviewed\nline2\n"
    manifest = (result.backup_dir / "manifest.json").read_text(encoding="utf-8")
    assert "a.ts" in manifest


def test_untracked_divergent_file_is_backed_up_then_replaced(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    write(source / "a.ts", "reviewed\n")
    make_git_repo(target, {"keep.ts": "keep\n"})
    write(target / "a.ts", "untracked local version\n")

    result = sync_mod.sync(
        source=source,
        target=target,
        files=("a.ts",),
        backup_root=backup_root,
    )

    assert (target / "a.ts").read_text(encoding="utf-8") == "reviewed\n"
    assert result.backup_dir is not None
    assert (result.backup_dir / "a.ts").read_text(encoding="utf-8") == "untracked local version\n"


def test_missing_target_file_is_created(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    write(source / "nested/new.ts", "fresh\n")
    make_git_repo(target, {"keep.ts": "keep\n"})

    result = sync_mod.sync(
        source=source,
        target=target,
        files=("nested/new.ts",),
        backup_root=backup_root,
    )

    assert (target / "nested" / "new.ts").read_text(encoding="utf-8") == "fresh\n"
    assert result.created == ["nested/new.ts"]
    assert result.synced == []


def test_dry_run_writes_nothing(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    write(source / "a.ts", "line1\nreviewed\nreviewed extra\nline2\n")
    make_git_repo(target, {"a.ts": "line1\nline2\n"})
    write(target / "a.ts", "line1\nreviewed\nline2\n")

    result = sync_mod.sync(
        source=source,
        target=target,
        files=("a.ts",),
        backup_root=backup_root,
        dry_run=True,
    )

    assert result.backup_dir is None
    assert result.synced == []
    assert (target / "a.ts").read_text(encoding="utf-8") == "line1\nreviewed\nline2\n"
    assert not backup_root.exists()


def test_non_git_target_is_refused_without_the_flag(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    write(source / "a.ts", "reviewed\n")
    target.mkdir()
    write(target / "a.ts", "local\n")

    with pytest.raises(sync_mod.SyncError):
        sync_mod.sync(
            source=source,
            target=target,
            files=("a.ts",),
            backup_root=tmp_path / "backups",
        )

    result = sync_mod.sync(
        source=source,
        target=target,
        files=("a.ts",),
        backup_root=tmp_path / "backups",
        allow_non_git=True,
    )
    assert (target / "a.ts").read_text(encoding="utf-8") == "reviewed\n"
    assert result.synced == ["a.ts"]


# --------------------------------------------------------------------------- #
# command line
# --------------------------------------------------------------------------- #
def test_cli_copies_the_full_file_list(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    for name in sync_mod.FILES:
        write(source / name, f"reviewed content for {name}\n")
    make_git_repo(target, {})

    exit_code = sync_mod.main(
        [
            "--source",
            str(source),
            "--target",
            str(target),
            "--backup-root",
            str(backup_root),
        ]
    )

    assert exit_code == 0
    for name in sync_mod.FILES:
        assert (target / name).read_text(encoding="utf-8") == f"reviewed content for {name}\n"
    assert (target / "src" / "permission" / "policy" / "writeScope.ts").is_file()


def test_cli_dry_run_leaves_the_target_untouched(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    for name in sync_mod.FILES:
        write(source / name, f"reviewed {name}\n")
    make_git_repo(target, {})
    write(target / "src" / "permission" / "index.ts", "local\n")

    exit_code = sync_mod.main(
        [
            "--source",
            str(source),
            "--target",
            str(target),
            "--backup-root",
            str(backup_root),
            "--dry-run",
        ]
    )

    assert exit_code == 0
    assert (target / "src" / "permission" / "index.ts").read_text(encoding="utf-8") == "local\n"
    assert not (target / "src" / "permission" / "policy" / "writeScope.ts").exists()
    assert not backup_root.exists()


def test_cli_reports_a_conflict_with_exit_code_one(tmp_path):
    source = tmp_path / "src"
    target = tmp_path / "target"
    backup_root = tmp_path / "backups"

    for name in sync_mod.FILES:
        write(source / name, f"reviewed {name}\n")
    make_git_repo(target, {"src/permission/index.ts": "base\n"})
    write(target / "src" / "permission" / "index.ts", "base\nlocal unrelated work\n")

    exit_code = sync_mod.main(
        [
            "--source",
            str(source),
            "--target",
            str(target),
            "--backup-root",
            str(backup_root),
        ]
    )

    assert exit_code == 1
    assert not backup_root.exists()
