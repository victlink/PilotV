#!/usr/bin/env bash
# 远端助手：注册并验证 PilotDeck 登录。单独成文件是为了不跟驱动脚本的引号打架。
#
# 口令不在本文件里，也不在命令行参数里 —— 驱动脚本把口令放在 stdin 第一行，
# 经环境变量 PD_PASS 传进来（同 uid 才看得到 /proc/<pid>/environ，
# 而 argv 是全局可见的）。
set -uo pipefail

PORT="${1:-3001}"
PD_USER="${2:-}"        # 用户名不是机密，走 argv（ssh 不会转发本地环境变量）
PD_PASS="${PD_PASS:-}"  # 口令只走环境变量，绝不进 argv
base="http://127.0.0.1:${PORT}"

[ -n "$PD_USER" ] || { echo "    ✗ 没给用户名"; exit 1; }
[ -n "$PD_PASS" ] || { echo "    ✗ 没给口令"; exit 1; }

payload() { python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$1" "$2"; }
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

# 1) 后端在不在、是不是免登录模式
status="$(curl -s --connect-timeout 5 "${base}/api/auth/status" 2>/dev/null || true)"
echo "    auth/status: ${status:-无响应}"
case "$status" in
  *'"authDisabled":true'*) echo "    ✗ 后端仍是免登录模式，得先在本机把开关打开"; exit 2 ;;
  '')                      echo "    ✗ 后端没起来"; exit 3 ;;
esac

# 2) 注册（账号已存在时后端会拒，不影响下一步）
code="$(payload "$PD_USER" "$PD_PASS" | curl -s -o "$tmp" -w '%{http_code}' \
          -X POST -H 'Content-Type: application/json' --data-binary @- "${base}/api/auth/register")"
echo "    register -> HTTP ${code} $(head -c 90 "$tmp")"

# 3) 真登录：拿到 token 才算成
code="$(payload "$PD_USER" "$PD_PASS" | curl -s -o "$tmp" -w '%{http_code}' \
          -X POST -H 'Content-Type: application/json' --data-binary @- "${base}/api/auth/login")"
if [ "$code" != "200" ]; then
  echo "    ✗ 登录失败 HTTP ${code}: $(head -c 120 "$tmp")"
  exit 1
fi
grep -q '"token"' "$tmp" || { echo "    ✗ 登录 200 但响应里没有 token"; exit 5; }
echo "    ✓ 登录成功，拿到 token"

# 4) 反验：错误口令必须被拒，否则等于没开鉴权
bad="$(payload "$PD_USER" "definitely-wrong-pw" | curl -s -o /dev/null -w '%{http_code}' \
         -X POST -H 'Content-Type: application/json' --data-binary @- "${base}/api/auth/login")"
if [ "$bad" = "401" ]; then
  echo "    ✓ 错误口令被拒（401）"
  exit 0
fi
echo "    ✗ 错误口令返回 ${bad}，鉴权没生效"
exit 4
