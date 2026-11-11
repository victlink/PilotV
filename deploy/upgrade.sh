#!/usr/bin/env bash
# PilotV unified upgrade: the ONLY supported way to change code on a device.
#
#   deploy/upgrade.sh <tag>
#   deploy/upgrade.sh v20261111.1 --dry-run
#   deploy/upgrade.sh v20261111.1 --no-build --no-restart
#   deploy/upgrade.sh --write-manifest        (release maintainer, on main)
#
# Guarantees:
#   * never merges, commits, pushes, or follows a floating branch
#   * pins the checkout to an immutable tag commit
#   * refuses when runtime subtrees have local edits (device hotfixes)
#   * rebuilds dist from the tagged sources, then verifies the running processes
#   * rolls the checkout back to the previous commit if any step fails
#
# Environment overrides:
#   PILOTV_SERVICES       space-separated systemd units to restart
#   PILOTV_RESTART_CMD    full restart command (replaces the systemd default)
#   PILOTV_BUILD_CMD      full dist build command (replaces the npm default)

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/.." && pwd -P)"
UPSTREAM="$REPO/pilotdeck-mobile/upstream-official"
UI="$UPSTREAM/ui"

TAG=""
DRY_RUN=0
NO_BUILD=0
NO_RESTART=0
ALLOW_RC=0
WRITE_MANIFEST=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) NO_BUILD=1 ;;
    --no-restart) NO_RESTART=1 ;;
    --allow-rc) ALLOW_RC=1 ;;
    --write-manifest) WRITE_MANIFEST=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) [ -z "$TAG" ] || { echo "only one tag is allowed" >&2; exit 2; }; TAG="$arg" ;;
  esac
done

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
ROLLBACK_ARMED=0
ROLLBACK_FN=''
die()  {
  printf 'ERROR: %s\n' "$*" >&2
  if [ "$ROLLBACK_ARMED" -eq 1 ] && [ -n "$ROLLBACK_FN" ]; then "$ROLLBACK_FN"; fi
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node is required"

# ---- release-maintainer helper ----------------------------------------------
if [ "$WRITE_MANIFEST" -eq 1 ]; then
  [ -d "$UI/dist" ] || die "dist not built: $UI/dist"
  DIGEST="$(find "$UI/dist" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
  printf '%s  %s  %s\n' "$DIGEST" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git -C "$REPO" rev-parse HEAD)" > "$HERE/dist-manifest.sha256"
  log "wrote deploy/dist-manifest.sha256 ($DIGEST)"
  log "commit this file, then create the release tag. Devices will verify against it."
  exit 0
fi

[ -n "$TAG" ] || die "usage: deploy/upgrade.sh <tag> [--dry-run] [--no-build] [--no-restart] [--allow-rc]"

RUNTIME_PATHS=(
  "pilotdeck-mobile/upstream-official/ui/server"
  "pilotdeck-mobile/upstream-official/src"
  "service"
  "deploy"
  "scripts/artifacts_service.py"
  "artifacts-mcp.mjs"
)

# ---- preflight ---------------------------------------------------------------
log "preflight: remote and working tree"
REMOTE="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
case "$REMOTE" in
  *github.com*PilotV*|*github.com*pilotv*) : ;;
  *) die "origin is not GitHub victlink/PilotV: $REMOTE" ;;
esac

DIRTY="$(git -C "$REPO" status --porcelain -- "${RUNTIME_PATHS[@]}" || true)"
OTHER_DIRTY="$(git -C "$REPO" status --porcelain | grep -vE '^.. (pilotdeck-mobile/upstream-official/ui/server|pilotdeck-mobile/upstream-official/src|service/|deploy/|scripts/artifacts_service.py|artifacts-mcp.mjs)' || true)"
if [ -n "$OTHER_DIRTY" ]; then
  warn "non-runtime files have local edits; they will be carried across the checkout:"
  printf '%s\n' "$OTHER_DIRTY" | head -10 | while IFS= read -r line; do warn "  $line"; done
fi
if [ -n "$DIRTY" ]; then
  die "runtime subtrees contain local edits (device hotfixes are forbidden). Commit them through a PR first:
$DIRTY"
fi

PREV_HEAD="$(git -C "$REPO" rev-parse HEAD)"
PREV_REF="$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')"
log "current HEAD: $PREV_HEAD ${PREV_REF:+(branch $PREV_REF)}"

# ---- resolve the tag ---------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ]; then
  log "fetching tags from origin"
  git -C "$REPO" fetch --tags --prune origin || die "git fetch failed"
fi
TAG_COMMIT="$(git -C "$REPO" rev-parse -q --verify "refs/tags/$TAG^{commit}" 2>/dev/null || true)"
[ -n "$TAG_COMMIT" ] || die "tag $TAG does not exist (locally or on origin). Create it on main after review."
log "tag $TAG -> $TAG_COMMIT"

DESCRIPTOR="$(git -C "$REPO" show "$TAG_COMMIT:deploy/release.json" 2>/dev/null || true)"
[ -n "$DESCRIPTOR" ] || die "tag $TAG has no deploy/release.json"
REL_TAG="$(printf '%s' "$DESCRIPTOR" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(String(JSON.parse(s).releaseTag||"")))')"
REL_STATUS="$(printf '%s' "$DESCRIPTOR" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(String(JSON.parse(s).status||"")))')"
[ "$REL_TAG" = "$TAG" ] || die "release.json declares '$REL_TAG' but '$TAG' was requested. Fix the descriptor before tagging."
if [ "$REL_STATUS" != "released" ] && [ "$ALLOW_RC" -eq 0 ]; then
  die "release.json status is '$REL_STATUS'. Use --allow-rc only for a review candidate."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN: would pin HEAD to $TAG_COMMIT, rebuild dist=$([ "$NO_BUILD" -eq 1 ] && echo no || echo yes), restart=$([ "$NO_RESTART" -eq 1 ] && echo no || echo yes), then run verify-unity.sh"
  exit 0
fi

# ---- switch, build, restart, verify (with rollback) -------------------------
SERVICES="${PILOTV_SERVICES:-pilotdeck.service pilotv-gateway.service pilotv-artifacts.service}"
restart_services() {
  if [ "$NO_RESTART" -eq 1 ]; then log "restart skipped (--no-restart)"; return 0; fi
  if [ -n "${PILOTV_RESTART_CMD:-}" ]; then
    log "restart: $PILOTV_RESTART_CMD"
    eval "$PILOTV_RESTART_CMD"
  elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^pilotdeck.service'; then
    log "restarting: $SERVICES"
    sudo -n systemctl restart $SERVICES
  else
    warn "no systemd service found; restart the processes manually"
  fi
}

ROLLBACK_DONE=0
rollback() {
  [ "$ROLLBACK_DONE" -eq 1 ] && return
  ROLLBACK_DONE=1
  warn "upgrade failed; rolling the checkout back to $PREV_HEAD"
  git -C "$REPO" checkout --detach "$PREV_HEAD" || warn "rollback checkout failed; fix manually"
  restart_services || warn "rollback restart failed"
}
ROLLBACK_ARMED=1
ROLLBACK_FN=rollback
trap 'rollback' ERR

log "pinning checkout to $TAG_COMMIT (detached HEAD)"
git -C "$REPO" checkout --detach "$TAG_COMMIT"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$TAG_COMMIT" ] || die "checkout did not land on $TAG_COMMIT"

for rel in "service/pilotv_gateway.mjs" "pilotdeck-mobile/upstream-official/ui/server/index.js" "scripts/artifacts_service.py"; do
  [ -f "$REPO/$rel" ] || die "tagged tree is missing $rel"
done

if [ "$NO_BUILD" -eq 1 ]; then
  log "dist rebuild skipped (--no-build)"
else
  if [ -n "${PILOTV_BUILD_CMD:-}" ]; then
    log "building dist: $PILOTV_BUILD_CMD"
    (cd "$UI" && eval "$PILOTV_BUILD_CMD")
  else
    log "building dist from tagged sources: npm run build"
    (cd "$UI" && npm run build)
  fi
fi
[ -f "$UI/dist/index.html" ] || die "dist build did not produce index.html"

restart_services

log "verifying"
"$HERE/verify-unity.sh" --probe || die "verify-unity reported drift"

ROLLBACK_ARMED=0
trap - ERR
log "upgrade to $TAG complete. HEAD=$TAG_COMMIT"
log "rollback if needed: deploy/upgrade.sh ${PREV_HEAD} --no-build --allow-rc"
