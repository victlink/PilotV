#!/usr/bin/env bash
# 修复 live dist 部署：用 rsync 且不保留权限/ACL，避免 cp -a 把 671+ACL 语义带到目标目录。
# 用法: restore_dist.sh <source-dir> <target-dist> <label>
set -euo pipefail
SRC="${1:?source dist}"
DST="${2:?target dist}"
LABEL="${3:-restore}"

REPO=/vol3/1000/Work/00/PilotV
BACKUP_ROOT="$REPO/.pilotdeck/work/dist-backups"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/${TS}-${LABEL}"

if [ ! -f "$SRC/index.html" ]; then
  echo "FATAL: source has no index.html: $SRC" >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"

# 1) 备份当前目标（只读复制，不动权限语义）
if [ -d "$DST" ]; then
  mkdir -p "$BACKUP"
  rsync -a --no-perms --no-owner --no-acls "$DST/" "$BACKUP/" 2>/dev/null || true
  echo "== backup =="
  echo "backup: $BACKUP (files=$(find "$BACKUP" -type f 2>/dev/null | wc -l))"
fi

# 2) 清空目标并复制新内容
mkdir -p "$DST"
find "$DST" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
rsync -a --delete --no-perms --no-owner --no-acls "$SRC/" "$DST/"

# 3) 固定权限：目录 755，文件 644，保证 web 服务可读
find "$DST" -type d -exec chmod 755 {} +
find "$DST" -type f -exec chmod 644 {} +

# 4) 校验
SRC_COUNT=$(find "$SRC" -type f | wc -l)
DST_COUNT=$(find "$DST" -type f | wc -l)
SRC_HASH=$(sha256sum "$SRC/index.html" | cut -d' ' -f1)
DST_HASH=$(sha256sum "$DST/index.html" | cut -d' ' -f1)
echo "== verify =="
echo "files: src=$SRC_COUNT dst=$DST_COUNT"
echo "index.html sha256: src=$SRC_HASH dst=$DST_HASH"
if [ "$SRC_COUNT" != "$DST_COUNT" ] || [ "$SRC_HASH" != "$DST_HASH" ]; then
  echo "FAIL: target does not match source" >&2
  exit 1
fi

cat > "$BACKUP/ROLLBACK.sh" <<EOS
#!/usr/bin/env bash
set -euo pipefail
DST="$DST"
BACKUP="$BACKUP"
[ -d "\$BACKUP" ] || { echo "backup missing: \$BACKUP" >&2; exit 1; }
find "\$DST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
rsync -a --no-perms --no-owner --no-acls "\$BACKUP/" "\$DST/"
find "\$DST" -type d -exec chmod 755 {} +
find "\$DST" -type f -exec chmod 644 {} +
echo "rolled back to \$BACKUP"
EOS
chmod +x "$BACKUP/ROLLBACK.sh"
echo "rollback: $BACKUP/ROLLBACK.sh"
echo "DEPLOY_OK label=$LABEL backup=$BACKUP"
