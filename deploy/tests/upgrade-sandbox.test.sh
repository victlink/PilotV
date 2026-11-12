#!/usr/bin/env bash
# Sandbox regression tests for deploy/upgrade.sh.
#
# Everything runs inside a temporary directory with mocked git/npm/verify
# commands. No real git checkout, no npm build, no systemctl, no network,
# no write to the real ui/dist.
#
# Covered requirements:
#   * the build is isolated in a staging directory (served dist untouched)
#   * previously served assets survive a publish
#   * the previous dist stays recoverable (snapshot on disk)
#   * a failing build returns non-zero and leaves the served dist intact
#   * a build that pollutes the served dist fails closed and restores it
#   * the rollback hint offers a tag, never a bare SHA

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_SRC="$HERE/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAILED=0
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

make_sandbox() {
  local root="$1"
  mkdir -p "$root/deploy" "$root/bin" "$root/home" "$root/stage-root" "$root/backup-root" \
           "$root/pilotdeck-mobile/upstream-official/ui/dist/assets" \
           "$root/pilotdeck-mobile/upstream-official/ui/server" \
           "$root/pilotdeck-mobile/upstream-official/src" \
           "$root/service" "$root/scripts"
  cp "$DEPLOY_SRC/upgrade.sh" "$root/deploy/upgrade.sh"
  chmod +x "$root/deploy/upgrade.sh"
  if [ -d "$DEPLOY_SRC/lib" ]; then
    mkdir -p "$root/deploy/lib"
    for f in "$DEPLOY_SRC"/lib/*.sh; do
      [ -e "$f" ] || continue
      cat "$f" > "$root/deploy/lib/$(basename "$f")"
      chmod 644 "$root/deploy/lib/$(basename "$f")"
    done
  fi
  cat > "$root/deploy/verify-unity.sh" <<'STUB'
#!/usr/bin/env bash
echo "stub verify-unity (sandbox)"
exit 0
STUB
  chmod +x "$root/deploy/verify-unity.sh"
  : > "$root/service/pilotv_gateway.mjs"
  : > "$root/pilotdeck-mobile/upstream-official/ui/server/index.js"
  : > "$root/scripts/artifacts_service.py"
  printf 'old-index\n' > "$root/pilotdeck-mobile/upstream-official/ui/dist/index.html"
  printf 'old-asset\n' > "$root/pilotdeck-mobile/upstream-official/ui/dist/assets/old.js"
  cat > "$root/bin/git" <<'MOCKGIT'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = "-C" ]; then shift 2; fi
cmd="${1:-}"; shift || true
case "$cmd" in
  remote) echo "git@github.com:victlink/PilotV.git" ;;
  status) exit 0 ;;
  rev-parse)
    for a in "$@"; do
      case "$a" in
        HEAD) cat "$MOCK_GIT_STATE" 2>/dev/null || echo "$MOCK_HEAD"; exit 0 ;;
        refs/tags/*) echo "$MOCK_TAG_COMMIT"; exit 0 ;;
        *'^{commit}') echo "$MOCK_TAG_COMMIT"; exit 0 ;;
      esac
    done
    echo "$MOCK_HEAD" ;;
  symbolic-ref) exit 1 ;;
  fetch) exit 0 ;;
  show) printf '{"releaseTag":"%s","status":"released"}\n' "$MOCK_TAG" ;;
  checkout)
    for a in "$@"; do
      if printf '%s' "$a" | grep -Eq '^[0-9a-f]{40}$'; then echo "$a" > "$MOCK_GIT_STATE"; fi
    done
    exit 0 ;;
  describe) echo "$MOCK_PREV_TAG" ;;
  ls-remote) exit 0 ;;
  merge-base) exit 0 ;;
  *) exit 0 ;;
esac
exit 0
MOCKGIT
  chmod +x "$root/bin/git"
  cat > "$root/bin/npm" <<'MOCKNPM'
#!/usr/bin/env bash
set -u
OUT=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--outDir" ]; then OUT="$a"; fi
  prev="$a"
done
printf '%s\n' "$OUT" > "${MOCK_NPM_LOG:-/dev/null}"
if [ -n "${MOCK_NPM_FAIL:-}" ]; then
  echo "mock npm: synthetic build failure" >&2
  exit 1
fi
if [ -z "$OUT" ]; then
  echo "mock npm: the build was not redirected to an isolated outDir" >&2
  exit 2
fi
mkdir -p "$OUT/assets"
printf 'new-index\n' > "$OUT/index.html"
printf 'new-asset\n' > "$OUT/assets/new.js"
if [ -n "${PILOTV_WEB_BUILD_OUTPUT:-}" ]; then
  printf '{"sourceSha":"mock"}\n' > "$PILOTV_WEB_BUILD_OUTPUT/web-build.json"
fi
if [ -n "${MOCK_NPM_TOUCH_SERVED:-}" ]; then
  mkdir -p "$PWD/dist"
  printf 'polluted\n' > "$PWD/dist/index.html"
fi
exit 0
MOCKNPM
  chmod +x "$root/bin/npm"
}

run_upgrade() {
  local root="$1"; shift
  (
    cd "$root" || exit 1
    env PATH="$root/bin:$PATH" \
        HOME="$root/home" \
        PILOTV_STAGE_ROOT="$root/stage-root" \
        PILOTV_BACKUP_ROOT="$root/backup-root" \
        MOCK_GIT_STATE="$root/git-state" \
        MOCK_HEAD="1111111111111111111111111111111111111111" \
        MOCK_TAG_COMMIT="2222222222222222222222222222222222222222" \
        MOCK_TAG="v20261111.1" \
        MOCK_PREV_TAG="v20261110.2" \
        MOCK_NPM_LOG="$root/npm-outdir.txt" \
        MOCK_NPM_FAIL="${MOCK_NPM_FAIL:-}" \
        MOCK_NPM_TOUCH_SERVED="${MOCK_NPM_TOUCH_SERVED:-}" \
        bash "$root/deploy/upgrade.sh" "$@"
  ) 2>&1
}

# ---- case 1: successful upgrade ---------------------------------------------
ROOT="$TMP/case-success"
make_sandbox "$ROOT"
echo "1111111111111111111111111111111111111111" > "$ROOT/git-state"
OUT="$(run_upgrade "$ROOT" v20261111.1)"
RC=$?
DIST="$ROOT/pilotdeck-mobile/upstream-official/ui/dist"
if [ "$RC" -eq 0 ]; then
  ok "upgrade returned 0"
else
  bad "upgrade returned $RC: $(printf '%s' "$OUT" | tr '\n' '|')"
fi
if [ "$(cat "$DIST/index.html" 2>/dev/null || echo '')" = "new-index" ]; then
  ok "the staged build was published"
else
  bad "the staged build was not published"
fi
if [ -f "$DIST/assets/old.js" ] && [ "$(cat "$DIST/assets/old.js")" = "old-asset" ]; then
  ok "the previously served asset survived the publish"
else
  bad "the previously served asset was dropped"
fi
OUTDIR="$(cat "$ROOT/npm-outdir.txt" 2>/dev/null || echo '')"
case "$OUTDIR" in
  "$ROOT"/*) ok "the build ran in an isolated staging directory ($OUTDIR)" ;;
  *) bad "the build was not isolated from the served dist (outDir='$OUTDIR')" ;;
esac
if [ -n "$OUTDIR" ] && [ "$OUTDIR" != "$DIST" ]; then
  :
else
  bad "the build output directory equals the served dist"
fi
if find "$ROOT/backup-root" -type f -name index.html 2>/dev/null | grep -q .; then
  if grep -q 'old-index' "$(find "$ROOT/backup-root" -type f -name index.html 2>/dev/null | head -1)"; then
    ok "the previous dist is recoverable from the on-disk snapshot"
  else
    bad "the dist snapshot does not contain the previous build"
  fi
else
  bad "no snapshot of the previous dist was kept"
fi
if printf '%s' "$OUT" | grep -Eq 'upgrade\.sh +v[0-9]'; then
  ok "the rollback hint offers a tag"
else
  bad "the rollback hint does not offer a tag: $(printf '%s' "$OUT" | tr '\n' '|')"
fi
if printf '%s' "$OUT" | grep -Eq 'upgrade\.sh +[0-9a-f]{7,40}'; then
  bad "the rollback hint still offers a bare commit SHA"
else
  ok "the rollback hint no longer offers a bare commit SHA"
fi

# ---- case 2: the build fails ------------------------------------------------
ROOT="$TMP/case-build-failure"
make_sandbox "$ROOT"
echo "1111111111111111111111111111111111111111" > "$ROOT/git-state"
OUT="$(MOCK_NPM_FAIL=1 run_upgrade "$ROOT" v20261111.1)"
RC=$?
DIST="$ROOT/pilotdeck-mobile/upstream-official/ui/dist"
if [ "$RC" -ne 0 ]; then
  ok "a failing build returns a non-zero exit code"
else
  bad "a failing build returned 0"
fi
if [ "$(cat "$DIST/index.html" 2>/dev/null || echo '')" = "old-index" ]; then
  ok "the served dist is untouched after a failed build"
else
  bad "the served dist changed after a failed build"
fi
if [ -f "$DIST/assets/old.js" ]; then
  ok "the previously served asset survived the failed build"
else
  bad "the previously served asset was lost after a failed build"
fi

# ---- case 3: the build pollutes the served dist (must fail closed) ----------
ROOT="$TMP/case-pollution"
make_sandbox "$ROOT"
echo "1111111111111111111111111111111111111111" > "$ROOT/git-state"
OUT="$(MOCK_NPM_TOUCH_SERVED=1 run_upgrade "$ROOT" v20261111.1)"
RC=$?
DIST="$ROOT/pilotdeck-mobile/upstream-official/ui/dist"
if [ "$RC" -ne 0 ]; then
  ok "a build that touches the served dist fails closed"
else
  bad "a build that touches the served dist returned 0"
fi
if [ "$(cat "$DIST/index.html" 2>/dev/null || echo '')" = "old-index" ]; then
  ok "the polluted served dist was restored"
else
  bad "the polluted served dist was not restored"
fi

if [ "$FAILED" -ne 0 ]; then
  printf 'upgrade-sandbox: %s check(s) failed\n' "$FAILED"
  exit 1
fi
printf 'upgrade-sandbox: all checks passed\n'
exit 0
