#!/usr/bin/env bash
# Regression tests for the shared dist helpers (deploy/lib/*.sh).
#
# Scope: pure filesystem fixtures under a temporary directory. No git, no npm,
# no network, no real ui/dist, no service operations.
#
# Covered requirements:
#   * the bundle digest uses relative paths (stable across directories)
#   * the bundle digest uses LC_ALL=C ordering
#   * publishing a staged build keeps the previously served assets
#   * a restore brings the served directory back to its exact previous state

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LIB="$HERE/../lib"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAILED=0
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

if [ ! -f "$LIB/dist-digest.sh" ] || [ ! -f "$LIB/dist-stage.sh" ]; then
  printf '  FAIL  deploy/lib/dist-digest.sh and deploy/lib/dist-stage.sh must exist\n'
  exit 1
fi

# shellcheck source=../lib/dist-digest.sh
. "$LIB/dist-digest.sh"
# shellcheck source=../lib/dist-stage.sh
. "$LIB/dist-stage.sh"

if ! declare -F pilotv_dist_digest >/dev/null; then
  printf '  FAIL  pilotv_dist_digest is not defined by deploy/lib/dist-digest.sh\n'
  exit 1
fi
if ! declare -F pilotv_dist_publish >/dev/null; then
  printf '  FAIL  pilotv_dist_publish is not defined by deploy/lib/dist-stage.sh\n'
  exit 1
fi
if ! declare -F pilotv_dist_restore >/dev/null; then
  printf '  FAIL  pilotv_dist_restore is not defined by deploy/lib/dist-stage.sh\n'
  exit 1
fi

# ---- 1. digest is independent of the directory location ---------------------
A="$TMP/loc-a"
B="$TMP/deeper/loc-b"
mkdir -p "$A/assets" "$B/assets"
printf 'index\n' > "$A/index.html"
printf 'chunk\n' > "$A/assets/app.js"
printf 'index\n' > "$B/index.html"
printf 'chunk\n' > "$B/assets/app.js"
DA="$(pilotv_dist_digest "$A" 2>/dev/null || echo '')"
DB="$(pilotv_dist_digest "$B" 2>/dev/null || echo '')"
if [ -n "$DA" ] && [ "$DA" = "$DB" ]; then
  ok "digest is identical for identical content in different directories"
else
  bad "digest still depends on the directory path ($DA vs $DB)"
fi

# ---- 2. digest uses relative paths and C-locale ordering --------------------
C="$TMP/order"
mkdir -p "$C"
printf 'B\n' > "$C/B.txt"
printf 'a\n' > "$C/a.txt"
EXPECT="$(cd "$C" && { printf '%s  %s\n' "$(sha256sum ./B.txt | cut -d' ' -f1)" './B.txt'; printf '%s  %s\n' "$(sha256sum ./a.txt | cut -d' ' -f1)" './a.txt'; } | sha256sum | awk '{print $1}')"
DC="$(pilotv_dist_digest "$C" 2>/dev/null || echo '')"
if [ "$DC" = "$EXPECT" ]; then
  ok "digest matches the relative-path, C-locale reference"
else
  bad "digest does not match the relative-path, C-locale reference ($DC vs $EXPECT)"
fi

# ---- 3. digest reacts to content changes -----------------------------------
printf 'a-changed\n' > "$C/a.txt"
DC2="$(pilotv_dist_digest "$C" 2>/dev/null || echo '')"
if [ "$DC2" != "$DC" ]; then
  ok "digest changes when a file changes"
else
  bad "digest did not change after a content change"
fi

# ---- 4. publishing keeps previously served assets ---------------------------
SERVED="$TMP/served"
STAGE="$TMP/stage"
BACKUP="$TMP/backup"
mkdir -p "$SERVED/assets" "$STAGE/assets" "$BACKUP"
printf 'old-index\n' > "$SERVED/index.html"
printf 'old-asset\n' > "$SERVED/assets/old.js"
cp -a "$SERVED/." "$BACKUP/"
printf 'new-index\n' > "$STAGE/index.html"
printf 'new-asset\n' > "$STAGE/assets/new.js"

if pilotv_dist_publish "$STAGE" "$SERVED" >/dev/null 2>&1; then
  ok "publish reported success"
else
  bad "publish returned a failure status"
fi
if [ "$(cat "$SERVED/index.html" 2>/dev/null || echo '')" = "new-index" ]; then
  ok "publish replaced the entry document"
else
  bad "publish did not replace the entry document"
fi
if [ -f "$SERVED/assets/old.js" ] && [ "$(cat "$SERVED/assets/old.js")" = "old-asset" ]; then
  ok "publish kept the previously served asset"
else
  bad "publish dropped the previously served asset"
fi
if [ -f "$SERVED/assets/new.js" ]; then
  ok "publish added the new asset"
else
  bad "publish did not add the new asset"
fi

# ---- 5. restore returns the served directory to its exact previous state ----
if pilotv_dist_restore "$SERVED" "$BACKUP" >/dev/null 2>&1; then
  ok "restore reported success"
else
  bad "restore returned a failure status"
fi
if [ "$(cat "$SERVED/index.html" 2>/dev/null || echo '')" = "old-index" ]; then
  ok "restore brought back the previous entry document"
else
  bad "restore did not bring back the previous entry document"
fi
if [ -f "$SERVED/assets/old.js" ] && [ ! -f "$SERVED/assets/new.js" ]; then
  ok "restore removed the files added by the failed publish"
else
  bad "restore left the failed publish files behind"
fi
RS="$(cd "$SERVED" && find . -type f | LC_ALL=C sort)"
RB="$(cd "$BACKUP" && find . -type f | LC_ALL=C sort)"
if [ "$RS" = "$RB" ]; then
  ok "restored file list matches the backup exactly"
else
  bad "restored file list differs from the backup"
fi

# ---- 6. publishing from a missing stage directory fails ---------------------
if pilotv_dist_publish "$TMP/does-not-exist" "$SERVED" >/dev/null 2>&1; then
  bad "publish accepted a missing stage directory"
else
  ok "publish refuses a missing stage directory"
fi

if [ "$FAILED" -ne 0 ]; then
  printf 'dist-lib: %s check(s) failed\n' "$FAILED"
  exit 1
fi
printf 'dist-lib: all checks passed\n'
exit 0
