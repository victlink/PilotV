#!/usr/bin/env bash
# 统一开启 PilotDeck 本地登录并注册统一账号，作用于所有目标机。
#
# 口令怎么传的（这是重点）：
#   口令只出现在 stdin 第一行，远端读进环境变量 PD_PASS 后 exec 脚本。
#   argv 全局可见、/proc/<pid>/environ 只有同 uid 可见 —— 所以绝不能把口令
#   写进命令行参数。仓库里也不存口令，口令文件在仓库外且 600。
#
# 用法：
#   scripts/set_login_password.sh                # 全部目标机
#   scripts/set_login_password.sh marc-linux-pc  # 只对某台
set -uo pipefail

SECRETS="${PILOTV_SECRETS_FILE:-$HOME/.config/pilotv/login.env}"
PORT="${PILOTV_BACKEND_PORT:-3001}"
ONLY="${1:-}"

[ -r "$SECRETS" ] || { echo "✗ 找不到口令文件 $SECRETS" >&2; exit 1; }
# shellcheck disable=SC1090
source "$SECRETS"
: "${PILOTV_LOGIN_USER:?口令文件里缺 PILOTV_LOGIN_USER}"
: "${PILOTV_LOGIN_PASS:?口令文件里缺 PILOTV_LOGIN_PASS}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_SH="$HERE/set_login_remote.sh"
[ -r "$REMOTE_SH" ] || { echo "✗ 找不到 $REMOTE_SH" >&2; exit 1; }

TARGETS=(
  "marc-linux-pc|Linux"
  "leo-mac|Mac"
  "jx88@100.108.86.109|PC"
)

run_one() {
  local host="$1" name="$2" rc
  printf '  ▸ %s (%s)\n' "$name" "$host"
  # 第一行口令，其余是脚本内容；远端读完第一行就 exec bash -s。
  {
    printf '%s\n' "$PILOTV_LOGIN_PASS"
    cat "$REMOTE_SH"
  } | ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" \
        'IFS= read -r PD_PASS; export PD_PASS; exec bash -s -- '"$PORT"' '"$PILOTV_LOGIN_USER" 2>&1
  rc=$?
  return $rc
}

echo "开启登录并注册 ${PILOTV_LOGIN_USER}（口令走 stdin，不进命令行）"
echo
ok=0; fail=0
for t in "${TARGETS[@]}"; do
  h="${t%%|*}"; n="${t##*|}"
  [ -n "$ONLY" ] && [ "$ONLY" != "$h" ] && continue
  if run_one "$h" "$n"; then
    ok=$((ok+1)); echo "  ✓ $n 就绪"
  else
    fail=$((fail+1)); echo "  ✗ $n 失败"
  fi
  echo
done
echo "成功 ${ok} 台，失败 ${fail} 台"
[ "$fail" -eq 0 ]
