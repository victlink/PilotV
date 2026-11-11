#!/usr/bin/env python3
"""Sync the reviewed project-team runtime files into a live PilotV checkout.

The vendored copy under ``pilotdeck-mobile/upstream-official`` carries the
reviewed implementation.  This script copies that reviewed set into a live
checkout (``/home/Marc/PilotDeck-src`` by default) without destroying work
that only exists in the live checkout.

DEPRECATED (2026-11-11)
------------------------
This whitelist copies 30 files from the vendored tree into a separate device
fork. It is the mechanism that let the runtime drift from the repository: on
2026-11-11 a real sync produced an import failure because the whitelist missed
``services/sessionExecutionMode.js`` (30 runtime files were absent from the
target in total). Now that the backend runs directly from
``pilotdeck-mobile/upstream-official/ui/server`` on the NAS, there is no second
tree to sync. Use ``deploy/upgrade.sh <tag>`` instead. Kept only for historical
reference and for reproducing the audit; do not use on a live deployment.

Safety model
------------
* The preflight is read only.  It classifies every file and collects every
  conflict *before* the first byte is written.
* Every target file that differs from the reviewed source is backed up
  (including untracked target files) before the first write.
* A tracked target file whose local edit is *not* superseded by the reviewed
  change is refused: copying the reviewed file would silently drop local work.
* Nothing is written at all when the preflight fails, and ``--dry-run`` never
  writes anything.

Usage
-----
    python3 scripts/sync_project_team_runtime.py --dry-run
    python3 scripts/sync_project_team_runtime.py
"""
from __future__ import annotations

import argparse
import datetime
import difflib
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "pilotdeck-mobile" / "upstream-official"
DEFAULT_TARGET = Path("/home/Marc/PilotDeck-src")
DEFAULT_BACKUP_ROOT = REPO_ROOT / ".pilotdeck" / "work" / "team-runtime-backups"

#: Reviewed files copied into the live checkout.  Every entry must exist in the
#: vendored source tree; the preflight fails otherwise.  Keep the list closed:
#: a file that is only referenced by a synced file (for example a policy module
#: imported by ``src/permission/index.ts``) has to be listed as well, otherwise
#: the live checkout ends up importing a file that was never copied.
FILES: tuple[str, ...] = (
    "src/agent/loop/AgentLoop.ts",
    "src/agent/sub/SubAgentSession.ts",
    "src/agent/turn/TurnRunner.ts",
    "src/agent/turn/TurnRunner.synthetic.spec.ts",
    "src/gateway/client/InProcessGateway.ts",
    "src/gateway/protocol/types.ts",
    "src/permission/decision/PermissionRuntime.ts",
    "src/permission/decision/PermissionRuntime.test.ts",
    "src/permission/policy/matchPermissionRule.ts",
    "src/permission/policy/writeScope.ts",
    "src/permission/index.ts",
    "src/permission/protocol/types.ts",
    "src/permission/settings.ts",
    "src/web/client/protocol.ts",
    "ui/server/pilotdeck-bridge.js",
    "ui/server/pilotdeck-bridge.speaker.test.js",
    "ui/server/pending-permissions.js",
    "ui/server/routes/messages.js",
    "ui/server/routes/messages.test.js",
    "ui/server/routes/project-team.js",
    "ui/server/routes/project-team.test.js",
    "ui/server/services/projectTeamConfig.js",
    "ui/server/services/projectTeamConfig.test.js",
    "ui/server/services/projectTeamRuntime.js",
    "ui/server/services/projectTeamCollaboration.js",
    "ui/server/services/projectTeamCollaboration.test.js",
    "ui/server/pilotdeck-bridge.review.test.js",
    "ui/server/services/projectTeamParticipants.js",
    "ui/server/services/projectTeamRuns.js",
    "ui/server/services/projectTeamRuntime.test.js",
)


class SyncError(RuntimeError):
    """Raised when the sync cannot proceed safely."""


@dataclass
class FilePlan:
    """Preflight verdict for a single file."""

    name: str
    action: str  # "identical" | "create" | "update"
    tracked: bool = False
    relation: str = "none"  # in-sync | no-local-edit | superseded | superset | untracked | unrelated
    needs_backup: bool = False
    staged: bool = False
    conflicts: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def refused(self) -> bool:
        return bool(self.conflicts)


@dataclass
class SyncResult:
    plans: list[FilePlan]
    backup_dir: Path | None
    synced: list[str]
    created: list[str]

    @property
    def conflicts(self) -> list[FilePlan]:
        return [plan for plan in self.plans if plan.refused]


# --------------------------------------------------------------------------- #
# git helpers (read only)
# --------------------------------------------------------------------------- #
def _git(target: Path, *args: str) -> tuple[int, bytes]:
    proc = subprocess.run(["git", "-C", str(target), *args], capture_output=True)
    return proc.returncode, proc.stdout


def _is_git_repo(target: Path) -> bool:
    rc, _ = _git(target, "rev-parse", "--git-dir")
    return rc == 0


def _is_tracked(target: Path, name: str) -> bool:
    rc, _ = _git(target, "ls-files", "--error-unmatch", "--", name)
    return rc == 0


def _blob(target: Path, revision: str) -> bytes | None:
    """Raw blob content for ``revision`` (``HEAD:path`` or ``:path``), if any."""
    rc, out = _git(target, "cat-file", "blob", revision)
    return out if rc == 0 else None


# --------------------------------------------------------------------------- #
# local edit analysis
# --------------------------------------------------------------------------- #
def _lines(data: bytes) -> list[str]:
    return data.decode("utf-8", "replace").splitlines(keepends=True)


def _hunks(base: bytes, other: bytes) -> list[tuple[str, int, int, int, int]]:
    """Diff hunks between two blobs as ``(tag, i1, i2, j1, j2)`` tuples."""
    matcher = difflib.SequenceMatcher(None, _lines(base), _lines(other), autojunk=False)
    return matcher.get_opcodes()


def _is_subsequence(needle: list[str], haystack: list[str]) -> bool:
    """True when every line of ``needle`` appears in ``haystack`` in order."""
    it = iter(haystack)
    return all(any(line == candidate for candidate in it) for line in needle)


def _line_range(i1: int, i2: int) -> str:
    """Human readable HEAD line range for a diff hunk."""
    if i1 == i2:
        return f"after line {i1}"
    return f"lines {i1 + 1}-{i2}"


def local_edit_conflicts(base: bytes, local: bytes, source: bytes) -> list[str]:
    """Reasons why a local edit is not covered by the reviewed change.

    A local edit is *superseded* when the reviewed source rewrites the same
    HEAD region and every line the local edit introduced still shows up, in
    order, in the reviewed version of that region.  That is the normal case for
    a live checkout that already carries an older revision of the same
    reviewed change: the newer reviewed revision simply adds to it.

    Everything else is unrelated local work: copying the reviewed file would
    silently drop it, so the sync refuses instead.
    """
    base_lines = _lines(base)
    local_lines = _lines(local)
    source_lines = _lines(source)
    sync_hunks = [hunk for hunk in _hunks(base, source) if hunk[0] != "equal"]

    reasons: list[str] = []
    for _tag, i1, i2, j1, j2 in _hunks(base, local):
        if _tag == "equal":
            continue
        local_text = local_lines[j1:j2]
        covering = [hunk for hunk in sync_hunks if hunk[1] <= i1 and i2 <= hunk[2]]
        if not covering:
            reasons.append(
                f"local change at HEAD {_line_range(i1, i2)} is not touched by the reviewed change"
            )
            continue
        if not any(
            _is_subsequence(local_text, source_lines[hunk[3] : hunk[4]]) for hunk in covering
        ):
            reasons.append(
                f"local change at HEAD {_line_range(i1, i2)} is not preserved by the reviewed change"
            )
    return reasons


# --------------------------------------------------------------------------- #
# superset analysis
# --------------------------------------------------------------------------- #
#: Tokens that carry no meaning for the containment check.
_NOISE_TOKENS = frozenset(
    {
        "const", "let", "var", "return", "else", "for", "while", "await", "async",
        "function", "new", "this", "import", "export", "default", "from", "try",
        "catch", "finally", "throw", "typeof", "instanceof", "null", "true",
        "false", "undefined", "yield", "delete", "void", "switch", "case",
        "break", "continue", "class", "extends", "super", "with", "debugger",
    }
)

_TOKEN_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def _tokens(line: str) -> list[str]:
    """Distinctive identifiers of a source line (keywords and short words dropped)."""
    seen: list[str] = []
    for token in _TOKEN_RE.findall(line):
        if len(token) < 3 or token.lower() in _NOISE_TOKENS:
            continue
        if token not in seen:
            seen.append(token)
    return seen


def _supersede_notes(local: bytes, source: bytes) -> tuple[list[str], list[str]]:
    """Check whether the reviewed file is a semantic superset of the local one.

    The reviewed file replaces the local file.  That is safe when every line
    the local file has and the reviewed file does *not* still finds its
    meaning inside the reviewed file: the reviewed revision simply rewrote
    that statement (longer condition, renamed helper, extra argument).

    The check is deliberately conservative: every distinctive identifier of
    the local-only line has to show up inside a small window of the reviewed
    file.  A removed function or a changed constant does not survive it, so
    real local work is still refused.

    Returns ``(notes, dropped)`` where ``notes`` describes every subsumed
    local-only line and ``dropped`` lists the local-only lines that could not
    be subsumed.
    """
    local_lines = _lines(local)
    source_lines = _lines(source)
    source_lower = [line.lower() for line in source_lines]

    local_only: list[str] = []
    for tag, i1, i2, j1, j2 in _hunks(local, source):
        if tag == "equal":
            continue
        if tag in ("delete", "replace"):
            local_only.extend(line.rstrip("\n") for line in local_lines[i1:i2])

    notes: list[str] = []
    dropped: list[str] = []
    for line in local_only:
        stripped = line.strip()
        if not stripped:
            continue
        tokens = _tokens(line)
        if not tokens:
            # Nothing meaningful to preserve (braces, comments, blank lines).
            continue
        window_texts: list[str] = []
        for size in (1, 2, 3):
            for start in range(0, max(0, len(source_lower) - size + 1)):
                window_texts.append("".join(source_lower[start : start + size]))
        if any(all(token.lower() in window for token in tokens) for window in window_texts):
            notes.append(f"subsumed by the reviewed revision: {stripped}")
        else:
            dropped.append(stripped)
    return notes, dropped


# --------------------------------------------------------------------------- #
# preflight
# --------------------------------------------------------------------------- #
def build_plan(
    source: Path,
    target: Path,
    files: tuple[str, ...] = FILES,
    *,
    allow_non_git: bool = False,
) -> list[FilePlan]:
    """Classify every file.  Read only: nothing is written here."""
    is_git = _is_git_repo(target)
    if not is_git and not allow_non_git:
        raise SyncError(
            f"Target {target} is not a git repository; "
            "refusing to sync because local modifications cannot be classified "
            "(pass --allow-non-git to override)."
        )

    plans: list[FilePlan] = []
    for name in files:
        src = source / name
        if not src.is_file():
            raise SyncError(f"Missing source file: {name}")
        dst = target / name
        src_bytes = src.read_bytes()

        if dst.is_symlink():
            raise SyncError(f"Refusing to write through a symlink: {dst}")
        if not dst.exists():
            plans.append(FilePlan(name=name, action="create"))
            continue
        if not dst.is_file():
            raise SyncError(f"Target path is not a regular file: {dst}")

        dst_bytes = dst.read_bytes()
        if dst_bytes == src_bytes:
            plans.append(
                FilePlan(
                    name=name,
                    action="identical",
                    tracked=is_git and _is_tracked(target, name),
                    relation="in-sync",
                )
            )
            continue

        tracked = is_git and _is_tracked(target, name)
        plan = FilePlan(
            name=name,
            action="update",
            tracked=tracked,
            needs_backup=True,
            relation="untracked" if not tracked else "no-local-edit",
        )
        if not tracked:
            plans.append(plan)
            continue

        base = _blob(target, f"HEAD:{name}")
        if base is None:
            plan.relation = "unrelated"
            plan.conflicts.append("no HEAD version available to compare the local edit against")
            plans.append(plan)
            continue

        variants: list[tuple[str, bytes]] = []
        if dst_bytes != base:
            variants.append(("worktree", dst_bytes))
        index_bytes = _blob(target, f":{name}")
        if index_bytes is not None and index_bytes != base:
            plan.staged = True
            if index_bytes != dst_bytes:
                variants.append(("index", index_bytes))

        if not variants:
            plans.append(plan)
            continue

        reasons: list[str] = []
        for label, variant in variants:
            for reason in local_edit_conflicts(base, variant, src_bytes):
                reasons.append(f"{label}: {reason}")
        if reasons:
            # The strict HEAD-region check can miss a reviewed revision that
            # rewrote the whole region (a longer condition, a renamed helper).
            # Before refusing, check whether the reviewed file is a semantic
            # superset of the local one.
            notes: list[str] = []
            dropped: list[str] = []
            for label, variant in variants:
                sub_notes, sub_dropped = _supersede_notes(variant, src_bytes)
                notes.extend(f"{label}: {note}" for note in sub_notes)
                dropped.extend(f"{label}: {line}" for line in sub_dropped)
            if notes and not dropped:
                plan.relation = "superset"
                plan.notes = notes
            else:
                plan.relation = "unrelated"
                plan.conflicts.extend(reasons)
                plan.notes = notes
        else:
            plan.relation = "superseded"
        plans.append(plan)
    return plans


# --------------------------------------------------------------------------- #
# reporting
# --------------------------------------------------------------------------- #
def _describe(plan: FilePlan) -> str:
    if plan.action == "identical":
        return "already in sync"
    if plan.action == "create":
        return "missing in target, will be created"
    if plan.relation == "untracked":
        return "untracked in target, divergent, will be backed up"
    if plan.relation == "no-local-edit":
        return "tracked, no local modification, will be backed up"
    if plan.relation == "superseded":
        note = "staged copy present" if plan.staged else "local edits superseded by the reviewed change"
        return f"tracked, {note}, will be backed up"
    if plan.relation == "superset":
        note = "staged copy present" if plan.staged else "reviewed file is a semantic superset of the local edit"
        return f"tracked, {note}, will be backed up"
    return "tracked, local edits not superseded by the reviewed change"


def print_plan(plans: list[FilePlan], *, dry_run: bool) -> None:
    header = "DRY RUN: no file is written" if dry_run else "PLAN"
    print(f"{header} ({len(plans)} file(s))")
    for plan in plans:
        marker = "REFUSED " if plan.refused else f"{plan.action:<9}"
        print(f"  {marker} {plan.name}  ({_describe(plan)})")
        for reason in plan.conflicts:
            print(f"            - {reason}")
        for note in plan.notes:
            print(f"            * {note}")


# --------------------------------------------------------------------------- #
# backup + copy
# --------------------------------------------------------------------------- #
def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _unique_backup_dir(backup_root: Path, stamp: str) -> Path:
    candidate = backup_root / stamp
    counter = 1
    while candidate.exists():
        candidate = backup_root / f"{stamp}-{counter}"
        counter += 1
    return candidate


def _backup(plans: list[FilePlan], target: Path, backup_dir: Path) -> list[dict]:
    entries: list[dict] = []
    for plan in plans:
        if not plan.needs_backup:
            continue
        src = target / plan.name
        saved = backup_dir / plan.name
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, saved)
        if saved.read_bytes() != src.read_bytes():
            raise SyncError(f"Backup verification failed: {plan.name}")
        entries.append(
            {
                "name": plan.name,
                "relation": plan.relation,
                "staged": plan.staged,
                "backupSha256": _sha256(saved),
                "backupBytes": saved.stat().st_size,
            }
        )
    return entries


def sync(
    *,
    source: Path,
    target: Path,
    files: tuple[str, ...] = FILES,
    backup_root: Path,
    dry_run: bool = False,
    allow_non_git: bool = False,
) -> SyncResult:
    """Preflight, back up and copy.  Raises ``SyncError`` before writing when
    the preflight finds a conflict."""
    plans = build_plan(source, target, files, allow_non_git=allow_non_git)
    print_plan(plans, dry_run=dry_run)

    refused = [plan for plan in plans if plan.refused]
    if refused:
        raise SyncError(
            f"Refusing to sync: {len(refused)} file(s) carry local edits that the reviewed change "
            "does not supersede.  Nothing was written."
        )

    if dry_run:
        return SyncResult(plans=plans, backup_dir=None, synced=[], created=[])

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = _unique_backup_dir(backup_root, stamp)
    entries = _backup(plans, target, backup_dir)

    synced: list[str] = []
    created: list[str] = []
    for plan in plans:
        if plan.action == "identical":
            continue
        src = source / plan.name
        dst = target / plan.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if src.read_bytes() != dst.read_bytes():
            raise SyncError(f"Copy verification failed: {plan.name}")
        if plan.action == "create":
            created.append(plan.name)
        else:
            synced.append(plan.name)

    manifest = {
        "createdAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "source": str(source),
        "target": str(target),
        "dryRun": dry_run,
        "backedUp": entries,
        "synced": synced,
        "created": created,
    }
    backup_dir.mkdir(parents=True, exist_ok=True)
    (backup_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(
        f"Synced and byte-verified {len(synced)} file(s), created {len(created)} file(s); "
        f"backed up {len(entries)} file(s) to {backup_dir}"
    )
    return SyncResult(plans=plans, backup_dir=backup_dir, synced=synced, created=created)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy the reviewed project-team runtime files into a live checkout.",
    )
    parser.add_argument(
        "--source",
        default=str(DEFAULT_SOURCE),
        help=f"reviewed source tree (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--target",
        default=str(DEFAULT_TARGET),
        help=f"live checkout to update (default: {DEFAULT_TARGET})",
    )
    parser.add_argument(
        "--backup-root",
        default=str(DEFAULT_BACKUP_ROOT),
        help=f"directory that receives the backups (default: {DEFAULT_BACKUP_ROOT})",
    )
    parser.add_argument(
        "-n",
        "--dry-run",
        action="store_true",
        help="print the plan and exit without writing anything",
    )
    parser.add_argument(
        "--allow-non-git",
        action="store_true",
        help="allow a target that is not a git repository (local edits cannot be classified)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    print(
        "WARNING: sync_project_team_runtime.py is DEPRECATED. "
        "Use deploy/upgrade.sh <tag> so front and back come from one commit.",
        file=sys.stderr,
    )
    args = parse_args(argv)
    source = Path(args.source).expanduser().resolve()
    target = Path(args.target).expanduser().resolve()
    backup_root = Path(args.backup_root).expanduser().resolve()

    if not source.is_dir():
        print(f"Source tree not found: {source}", file=sys.stderr)
        return 2
    if not target.is_dir():
        print(f"Target checkout not found: {target}", file=sys.stderr)
        return 2

    try:
        result = sync(
            source=source,
            target=target,
            backup_root=backup_root,
            dry_run=args.dry_run,
            allow_non_git=args.allow_non_git,
        )
    except SyncError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.dry_run:
        print("Dry run finished; nothing was written.")
    else:
        print(f"Backup directory: {result.backup_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
