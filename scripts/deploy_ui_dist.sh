#!/usr/bin/env bash
# Deploy a built UI bundle into a serving dist directory, with backup + verification.
#
# Usage: deploy_ui_dist.sh <source-dist> <target-dist> <label>
#
# - Backs up the current target into .pilotdeck/work/dist-backups/<ts>-<label>/
# - Copies source -> target (rsync --delete semantics)
# - Verifies the copied tree hash-for-hash against the source
set -euo pipefail

SRC="${1:?source dist}"
DST="${2:?target dist}"
LABEL="${3:-deploy}"

REPO=/vol3/1000/Work/00/PilotV
BACKUP_ROOT="$REPO/.pilotdeck/work/dist-backups"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/${TS}-${LABEL}"

if [ ! -f "$SRC/index.html" ]; then
  echo "FATAL: source has no index.html: $SRC" >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"

echo "== pre-deploy fingerprint =="
if [ -f "$DST/index.html" ]; then
  echo "target index.html sha256: $(sha256sum "$DST/index.html" | cut -d' ' -f1)"
  echo "target file count:        $(find "$DST" -type f | wc -l)"
  echo "target index.html mtime:   $(stat -c '%y' "$DST/index.html")"
else
  echo "target does not exist yet"
fi
echo "source index.html sha256: $(sha256sum "$SRC/index.html" | cut -d' ' -f1)"
echo "source file count:        $(find "$SRC" -type f | wc -l)"

# ---- backup ----
if [ -d "$DST" ]; then
  mkdir -p "$BACKUP"
  cp -a "$DST/." "$BACKUP/"
  echo "== backed up target to: $BACKUP =="
  echo "backup file count: $(find "$BACKUP" -type f | wc -l)"
fi

# ---- deploy ----
mkdir -p "$DST"
# remove stale hashed assets so the old bundle's files do not linger
find "$DST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$SRC/." "$DST/"

# ---- verify ----
echo "== post-deploy verification =="
SRC_HASHES="$(cd "$SRC" && find . -type f -exec sha256sum {} + | sort -k2 | sha256sum | cut -d' ' -f1)"
DST_HASHES="$(cd "$DST" && find . -type f -exec sha256sum {} + | sort -k2 | sha256sum | cut -d' ' -f1)"
echo "source tree hash: $SRC_HASHES"
echo "target tree hash: $DST_HASHES"
if [ "$SRC_HASHES" != "$DST_HASHES" ]; then
  echo "FATAL: tree hash mismatch" >&2
  exit 1
fi
echo "OK: target matches source exactly"

# ---- rollback helper ----
cat > "$BACKUP/ROLLBACK.sh" <<EOS
#!/usr/bin/env bash
set -euo pipefail
DST="$DST"
BACKUP="$BACKUP"
if [ ! -d "\$BACKUP" ]; then echo "backup missing: \$BACKUP" >&2; exit 1; fi
find "\$DST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "\$BACKUP/." "\$DST/"
echo "rolled back to $BACKUP"
EOS
chmod +x "$BACKUP/ROLLBACK.sh"
echo "rollback script: $BACKUP/ROLLBACK.sh"
echo "DEPLOY_OK label=$LABEL backup=$BACKUP"
