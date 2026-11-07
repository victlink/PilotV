#!/bin/sh
# Back up the listed ui/src files from a PilotV checkout into a backup dir.
# usage: ui_backup.sh <checkout-root> <backup-dir> <list-file>
set -eu
ROOT="$1"
BACKUP="$2"
LIST="$3"
mkdir -p "$BACKUP"
count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ -f "$ROOT/$f" ]; then
    mkdir -p "$BACKUP/$(dirname "$f")"
    cp -p "$ROOT/$f" "$BACKUP/$f"
    count=$((count + 1))
  fi
done < "$LIST"
echo "backed_up=$count"
