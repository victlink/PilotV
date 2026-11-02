#!/usr/bin/env bash
# 在远端把 PilotDeck 单用户账号设成指定用户名 + 已算好的 bcrypt 哈希。
#
# 为什么改 DB：官方后端是单用户设计，一旦有用户，注册接口固定返回 403
# （"User already exists. This is a single-user system."），也没有改密码接口。
# 要统一凭据只能落库。
#
# 为什么用 Python 的 sqlite3 而不是后端的 better-sqlite3：
# better-sqlite3 是原生模块，NODE_MODULE_VERSION 必须和跑它的 node 对得上。
# 实测在 marc-linux-pc 上后端是 Node 22 编译的，PATH 上的 node 却是 26，
# 直接 require 会 ERR_DLOPEN_FAILED。哈希已由驱动脚本在匹配的后端上算好，
# 这里只剩一条 UPDATE，标准库 sqlite3 足够，且没有原生依赖。
#
# 安全约定：
#   口令哈希由环境变量 PD_HASH 传入，本脚本不含口令。
#   改之前一定备份 auth.db，出错直接拷回即可。
#
# 用法（远端）：
#   UI_DIR=<ui 目录> PORT=3001 PD_HASH='$2b$12$...' bash set_pilotdeck_account.sh <用户名> [数据库路径]
set -euo pipefail

UI_DIR="${UI_DIR:?要指定 PilotDeck 的 ui 目录}"
DB="${2:-${DATABASE_PATH:-$UI_DIR/server/database/auth.db}}"
PORT="${PORT:-3001}"
NEW_USER="${1:?要指定用户名}"
PD_HASH="${PD_HASH:?没给哈希}"

# 校验哈希形状，防止把非 bcrypt 的东西写进库（整段放单引号，避免 $ 被展开）
case "$PD_HASH" in
  '$2b$'*|'$2a$'*|'$2y$'*) : ;;
  *) echo "    ✗ PD_HASH 不像 bcrypt 哈希"; exit 1 ;;
esac

[ -f "$DB" ] || { echo "    ✗ 找不到数据库 $DB"; exit 1; }

echo "    数据库: $DB"

# 1) 备份。带纳秒与 pid，同一秒内多次运行不会互相覆盖。
stamp="$(date +%Y%m%d-%H%M%S)-$$"
cp -p "$DB" "$DB.bak.$stamp"
echo "    已备份: $(basename "$DB").bak.$stamp"

# 2) 列出当前用户（只列用户名，不读哈希），再改。单用户系统所以复用第一行，
#    保留 id 以免别处按 id 外键引用断掉。
DB="$DB" PD_HASH="$PD_HASH" NEW_USER="$NEW_USER" python3 - <<'PY'
import os, sqlite3
db = sqlite3.connect(os.environ["DB"], timeout=10)
try:
    db.execute("PRAGMA busy_timeout=10000")
    rows = db.execute("SELECT id, username, is_active FROM users ORDER BY id").fetchall()
    print("    现有用户: " + (", ".join(
        f"{u}{'' if a else '（已停用）'}" for _i, u, a in rows) if rows else "（无）"))
    h, u = os.environ["PD_HASH"], os.environ["NEW_USER"]
    if rows:
        db.execute("UPDATE users SET username=?, password_hash=?, is_active=1 WHERE id=?", (u, h, rows[0][0]))
        print(f"    已更新 id={rows[0][0]}")
    else:
        db.execute("INSERT INTO users (username,password_hash,is_active) VALUES (?,?,1)", (u, h))
        print("    已创建新用户")
    db.commit()
finally:
    db.close()
PY

# 3) 真验证：登录拿到 token，且错误口令被拒
payload() { python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$1" "$2"; }
base="http://127.0.0.1:${PORT}"
code="$(payload "$NEW_USER" "${PD_PLAIN:?要同时给 PD_PLAIN 才能验证登录}" | \
        curl -s -o /tmp/.pd.$$ -w '%{http_code}' -X POST \
              -H 'Content-Type: application/json' --data-binary @- "${base}/api/auth/login" || true)"
rm -f /tmp/.pd.$$
if [ "$code" = "200" ]; then
  bad="$(payload "$NEW_USER" "definitely-wrong-pw" | curl -s -o /dev/null -w '%{http_code}' \
          -X POST -H 'Content-Type: application/json' --data-binary @- "${base}/api/auth/login")"
  [ "$bad" = "401" ] && { echo "    ✓ 登录成功，错误口令被拒"; exit 0; }
  echo "    ✗ 错误口令返回 $bad，鉴权没生效"; exit 4
fi
echo "    ✗ 登录验证失败 HTTP ${code}（若后端处于免登录模式，先开开关再重跑）"
exit 1
