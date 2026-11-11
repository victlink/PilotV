#!/usr/bin/env bash
# PilotV version-unity self check.
#
# Answers one question: "is every running component on this machine actually
# coming from the pinned GitHub PilotV checkout?" It never writes anything.
#
# Usage:
#   deploy/verify-unity.sh                report; WARN does not fail
#   deploy/verify-unity.sh --strict       WARN becomes FAIL (clean device mirrors)
#   deploy/verify-unity.sh --offline      skip git ls-remote
#   deploy/verify-unity.sh --probe        additionally curl critical /api endpoints
#
# Exit codes: 0 all hard checks pass, 1 drift, 2 could not run the check.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/.." && pwd -P)"
STRICT=0
OFFLINE=0
PROBE=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --offline) OFFLINE=1 ;;
    --probe) PROBE=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

FAILS=0
WARNS=0
fail() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf '  WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }
pass() { printf '  OK    %s\n' "$*"; }
info() { printf '        %s\n' "$*"; }

RUNTIME_PATHS=(
  "pilotdeck-mobile/upstream-official/ui/server"
  "pilotdeck-mobile/upstream-official/src"
  "service"
  "deploy"
  "scripts/artifacts_service.py"
  "artifacts-mcp.mjs"
)

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }

printf 'PilotV version unity @ %s\n' "$(hostname)"
printf 'checked at   %s\n' "$(date -Is)"
printf 'repo         %s\n' "$REPO"
printf '%s\n' '------------------------------------------------------------------------'

# ---- 1. repository identity -------------------------------------------------
HEAD="$(git -C "$REPO" rev-parse HEAD)"
REF="$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '(detached HEAD)')"
NEAREST="$(git -C "$REPO" describe --tags --always --dirty 2>/dev/null || echo '(no tag)')"
REMOTE="$(git -C "$REPO" remote get-url origin 2>/dev/null || echo '(no origin)')"
info "HEAD         $HEAD"
info "ref          $REF"
info "describe     $NEAREST"
info "origin       $REMOTE"

case "$REMOTE" in
  *github.com*PilotV*|*github.com*pilotv*) pass "origin is the GitHub PilotV repository" ;;
  *) fail "origin is not GitHub victlink/PilotV: $REMOTE" ;;
esac

if [ -f "$HERE/release.json" ]; then
  REL_TAG="$(node -e 'const d=require(process.argv[1]);process.stdout.write(String(d.releaseTag||""))' "$HERE/release.json")"
  REL_STATUS="$(node -e 'const d=require(process.argv[1]);process.stdout.write(String(d.status||""))' "$HERE/release.json")"
  info "release.json tag=$REL_TAG status=$REL_STATUS"
  if [ -z "$REL_TAG" ]; then fail "release.json has no releaseTag"; fi
  if [ "$REL_STATUS" != "released" ]; then
    warn "release status is '$REL_STATUS' (tag not published / branch still under review)"
  fi
  if git -C "$REPO" rev-parse -q --verify "refs/tags/$REL_TAG^{commit}" >/dev/null 2>&1; then
    TAG_COMMIT="$(git -C "$REPO" rev-parse "$REL_TAG^{commit}")"
    if [ "$TAG_COMMIT" = "$HEAD" ]; then pass "HEAD equals release tag $REL_TAG"; else fail "HEAD $HEAD != tag $REL_TAG -> $TAG_COMMIT"; fi
  else
    warn "tag $REL_TAG does not exist locally yet; HEAD is pinned by commit only"
  fi
else
  fail "deploy/release.json is missing"
fi

if [ "$OFFLINE" -eq 0 ]; then
  MAIN="$(git -C "$REPO" ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$MAIN" ]; then
    info "origin/main   $MAIN"
    if git -C "$REPO" merge-base --is-ancestor "$MAIN" HEAD 2>/dev/null; then
      pass "local HEAD contains origin/main"
    else
      warn "local HEAD does not contain origin/main (review branch or unpushed release)"
    fi
  else
    warn "could not reach origin (offline or credentials missing)"
  fi
fi

# ---- 2. working tree drift in runtime paths ---------------------------------
DIRTY="$(git -C "$REPO" status --porcelain -- "${RUNTIME_PATHS[@]}" 2>/dev/null || true)"
DIRTY_COUNT=0
if [ -n "$DIRTY" ]; then DIRTY_COUNT="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"; fi
if [ "$DIRTY_COUNT" -eq 0 ]; then
  pass "runtime subtrees are byte-identical to HEAD"
else
  if [ "$STRICT" -eq 1 ]; then fail "$DIRTY_COUNT runtime file(s) differ from HEAD"; else warn "$DIRTY_COUNT runtime file(s) differ from HEAD (dev tree in-flight work)"; fi
  printf '%s\n' "$DIRTY" | head -12 | while IFS= read -r line; do info "drift: $line"; done
fi
ALL_DIRTY="$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
info "whole-tree dirty entries: $ALL_DIRTY"

# ---- 3. component files -----------------------------------------------------
for rel in \
  "service/pilotv_gateway.mjs" \
  "pilotdeck-mobile/upstream-official/ui/server/index.js" \
  "pilotdeck-mobile/upstream-official/ui/dist/index.html" \
  "scripts/artifacts_service.py" \
  "artifacts-mcp.mjs"; do
  if [ -f "$REPO/$rel" ]; then pass "component present: $rel"; else fail "component missing: $rel"; fi
done

# ---- 4. where the running processes actually live --------------------------
find_pids_on_port() {
  local port="$1" pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' || true)"
  fi
  if [ -z "$pids" ] && command -v ss >/dev/null 2>&1; then
    pids="$(ss -lntp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $0}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | tr '\n' ' ' || true)"
  fi
  printf '%s' "$pids"
}

check_port() {
  local port="$1" label="$2" pids="" pid cwd n=0
  pids="$(find_pids_on_port "$port")"
  if [ -z "$pids" ]; then warn "$label (port $port) is not listening"; return; fi
  for pid in $pids; do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ -z "$cwd" ] && continue
    n=$((n + 1))
    case "$cwd" in
      "$REPO"/*|"$REPO") pass "$label pid=$pid cwd inside repo: ${cwd#"$REPO/"}" ;;
      *) fail "$label pid=$pid cwd OUTSIDE repo: $cwd" ;;
    esac
  done
  if [ "$n" -eq 0 ]; then warn "$label pid(s) found but /proc cwd unreadable"; fi
}

check_port 3001 "web/API backend"
check_port 5187 "frontend gateway"
check_port 8799 "artifacts service"

# A compatibility shim is allowed only if it resolves inside the repo.
for shim in "$HOME/.pilotdeck/app" "$HOME/.pilotv/app/repo"; do
  if [ -L "$shim" ] || [ -d "$shim" ]; then
    target="$(readlink -f "$shim" 2>/dev/null || true)"
    case "$target" in
      "$REPO"/*|"$REPO") pass "shim $shim resolves into repo: ${target#"$REPO/"}" ;;
      *) fail "shim $shim points outside repo: $target" ;;
    esac
  fi
done

# ---- 5. native runtime dependency ------------------------------------------
UPSTREAM="$REPO/pilotdeck-mobile/upstream-official"
if node -e 'const{createRequire}=require("module");const p=require.resolve("node-pty/package.json",{paths:[process.argv[1]+"/ui"]});const r=createRequire(p);r("node-pty")' "$UPSTREAM" >/dev/null 2>&1; then
  pass "node-pty native module loads"
else
  warn "node-pty native module did not resolve from upstream-official/ui (may still load via nested pnpm paths)"
fi

# ---- 6. dist manifest -------------------------------------------------------
DIST="$UPSTREAM/ui/dist"
if [ -d "$DIST" ]; then
  CUR="$(find "$DIST" -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
  info "dist digest  $CUR"
  if [ -f "$HERE/dist-manifest.sha256" ]; then
    REC="$(awk 'NR==1{print $1}' "$HERE/dist-manifest.sha256")"
    if [ "$CUR" = "$REC" ]; then pass "dist matches release manifest"; else
      if [ "$STRICT" -eq 1 ]; then fail "dist differs from release manifest"; else warn "dist differs from release manifest (locally rebuilt)"; fi
    fi
  else
    warn "no deploy/dist-manifest.sha256 committed for this release"
  fi
else
  fail "dist directory missing: $DIST"
fi

# ---- 7. optional live API probe --------------------------------------------
if [ "$PROBE" -eq 1 ]; then
  # PILOTV_PROBE_TOKEN lets an operator pass a valid JWT so the probe exercises
  # the full route contract instead of stopping at the auth middleware.
  PROBE_HEADER=()
  if [ -n "${PILOTV_PROBE_TOKEN:-}" ]; then
    PROBE_HEADER=(-H "Authorization: Bearer $PILOTV_PROBE_TOKEN")
  fi
  for ep in \
    "/api/settings/general-workspace" \
    "/api/project-team/session-execution-mode?projectRoot=$(printf '%s' "$REPO" | sed 's|/|%2F|g')&sessionKey=verify"; do
    code="$(curl -s -m 12 -o /dev/null -w '%{http_code}' ${PROBE_HEADER[@]+"${PROBE_HEADER[@]}"} "http://127.0.0.1:3001$ep" 2>/dev/null || echo 000)"
    case "$code" in
      200|304) info "probe $code ${ep%%\?*} (route reachable)" ;;
      401|403) info "probe $code ${ep%%\?*} (backend alive; auth required - set PILOTV_PROBE_TOKEN for a full check)" ;;
      404) info "probe 404 ${ep%%\?*} (structured 404 proves the route when auth passed)" ;;
      *) warn "probe returned $code for ${ep%%\?*}" ;;
    esac
  done
fi

printf '%s\n' '------------------------------------------------------------------------'
printf 'FAIL=%s WARN=%s (strict=%s)\n' "$FAILS" "$WARNS" "$STRICT"
if [ "$STRICT" -eq 1 ] && [ "$WARNS" -gt 0 ]; then exit 1; fi
[ "$FAILS" -eq 0 ] || exit 1
exit 0
