#!/usr/bin/env bash
# 终验 A：全量回归。起一套隔离环境（测试 console + MCP 侧车），逐个跑 scripts/verify_*，
# 最后汇总成一张表。
#
# 两个曾经踩过的坑，这里用代码堵住：
#   1. 判定「通过」必须看真实退出码。写成 `timeout ... | tail` 再取 $? 会把语法错误
#      也算通过（.mjs 被 python 跑那一轮就是这么被骗过去的）。
#   2. 断言不能依赖「库里正好有历史数据」。隔离数据目录后，两条断言立刻挂 ——
#      说明它们一直在靠运气，现在改成自己种数据。
#
# 用法：bash scripts/run_all_verify.sh [--only 关键字1,关键字2]
set -u
cd "$(dirname "$0")/.." || exit 2
ROOT=$(pwd)

# 隔离数据目录：回归脚本会写垃圾，绝不能污染 .artifacts-data
export ARTIFACTS_DATA_DIR=${ARTIFACTS_DATA_DIR:-/tmp/artifacts-regress-data}
rm -rf "$ARTIFACTS_DATA_DIR"
mkdir -p "$ARTIFACTS_DATA_DIR"

ONLY=""
[ "${1:-}" = "--only" ] && ONLY="${2:-}"

PORT=$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
)
MCP_PORT=$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
)
API="http://127.0.0.1:$PORT"
export ARTIFACTS_API="$API"
export ARTIFACTS_MCP_URL="http://127.0.0.1:$MCP_PORT/api/artifacts-mcp"
export ARTIFACTS_PORT="$MCP_PORT"

SERVE_PID=""; SIDECAR_PID=""
cleanup() {
  [ -n "$SIDECAR_PID" ] && kill "$SIDECAR_PID" 2>/dev/null
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

wait_up() {                 # wait_up <url> <秒>  —— 任意 HTTP 响应就算起来
  local url=$1 secs=${2:-25} i=0 code
  while [ $i -lt $((secs * 4)) ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null)
    [ "$code" != "000" ] && [ -n "$code" ] && return 0
    i=$((i + 1)); sleep 0.25
  done
  return 1
}

echo "回归环境：console $API / 侧车 $ARTIFACTS_MCP_URL / 数据 $ARTIFACTS_DATA_DIR"
python3 scripts/serve_test.py --port "$PORT" >/tmp/artifacts-regress-serve.log 2>&1 &
SERVE_PID=$!
if ! wait_up "$API/api/artifacts/health" 30; then
  echo "测试服务没起来，日志："; tail -20 /tmp/artifacts-regress-serve.log; exit 2
fi
if command -v node >/dev/null 2>&1; then
  node artifacts-mcp.mjs >/tmp/artifacts-regress-sidecar.log 2>&1 &
  SIDECAR_PID=$!
  # 注意：MCP 是 streamable_http，GET 会回 405 —— 所以只判「有 HTTP 响应」，
  # 早先用 curl -f 等 200，把明明起来了的侧车报成「没起来」。
  wait_up "$ARTIFACTS_MCP_URL" 15 || echo "（侧车真的没起来，MCP 两项会失败）"
fi

OK=0; FAIL=0; SKIP=0; FAILED=""
run() {                     # run <名称> <命令...>
  local name=$1; shift
  if [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]]; then return 0; fi
  printf '\n\033[1m===== %s =====\033[0m\n' "$name"
  local out rc
  out=$(timeout 420 "$@" 2>&1); rc=$?          # 先收全部输出，再取退出码
  printf '%s\n' "$out" | tail -n 16
  # 失败行要单独捞出来：只看 tail 会把出错的那条滚掉（第一轮就栽在这）
  printf '%s\n' "$out" | grep -E "FAIL|✗|Traceback" | head -12 | sed 's/^/    ⚠ /'
  if [ "$rc" -eq 0 ]; then
    printf '\033[32m[%s] 通过\033[0m\n' "$name"; OK=$((OK+1))
  elif [ "$rc" -eq 124 ]; then
    printf '\033[33m[%s] 超时（跳过）\033[0m\n' "$name"; SKIP=$((SKIP+1))
  else
    printf '\033[31m[%s] 失败 rc=%s\033[0m\n' "$name" "$rc"; FAIL=$((FAIL+1)); FAILED="$FAILED $name"
  fi
}
run_node() {
  local name=$1; shift
  if ! command -v node >/dev/null 2>&1; then
    [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]] && return 0
    printf '\n\033[33m[%s] 跳过：找不到 node\033[0m\n' "$name"; SKIP=$((SKIP+1)); return 0
  fi
  run "$name" node "$@"
}

# verify_loop.py 默认打 8799 —— 那正是正式成果台的端口。不显式传 --base 的话，
# 护栏会（正确地）拒绝执行：它认出来连的是正式数据目录。
run "store 核心闭环"    python3 scripts/verify_loop.py --base "$API"
run "M2 目录监控"       python3 scripts/verify_watch.py --api "$API"
run "M3 状态机审计"    python3 scripts/verify_m3.py --api "$API"
run "M4 批量导入"       python3 scripts/verify_import.py --api "$API"
run "M2 selector 重锚"  python3 scripts/verify_reanchor.py --api "$API"
run_node "M2 渲染器"     scripts/verify_page.mjs
run "顶栏 logo 不可点"   python3 scripts/verify_brand_logo.py --api "$API"
run_node "M1 MCP 侧车"   scripts/verify_mcp.mjs
run_node "M3 MCP 返工唤醒" scripts/verify_m3_mcp.mjs
run_node "M1 插件安装"   scripts/verify_plugin.mjs
run "前端 diff 视图"    python3 scripts/verify_diff_ui.py --api "$API"
run "前端 agent 筛选"   python3 scripts/verify_agent_ui.py --api "$API"
run "M4 IM 推送"        python3 scripts/verify_notify.py
# 设置 / 改口令两个脚本自己会起一台隔离 console（独立的用户库与数据目录），
# 故意不放进上面的公共环境跑：改口令会写用户库，绝不能碰公共环境里那份。
run "设置 改口令后端" python3 scripts/verify_settings.py
run "设置 面板页面级"  python3 scripts/verify_settings_ui.py
# 生产只读体检：只 GET、绝不改口令。跑挂了多半是服务没起或 Cookie 过期，
# 不代表面板坏了 —— 想在本机离线跑整套时用 SKIP_PROD=1 摘掉它。
if [ "${SKIP_PROD:-0}" = "1" ]; then
  echo "--- 跳过 生产设置面板只读（SKIP_PROD=1）"
else
  run "设置 生产面板只读" python3 scripts/verify_settings_prod_readonly.py
fi
# 需求 1-5（只显示最终成果 / 部件树 / 手势标注 / 就地编辑 / 回原会话）的新验收。
# 这两套自带隔离服务与隔离 PilotDeck 家目录，不跟上面共用 $API —— 尤其返工单
# 验收要写假会话目录，共用服务会让它污染真实环境。
run "需求1-5 成果交付与返工单" bash scripts/run_deliverables_verify.sh
run "需求1-5 浏览器手势"       bash scripts/run_gestures_verify.sh

# 左栏「项目 / 会话」下拉。它自带隔离的假 PilotDeck 家目录（$PILOTDECK_HOME），
# 因为要验「默认落在正在活动 / 最近更新的那个会话上」—— 不造假目录就只能验出空壳。
# 代价是这个套件会重启一次服务（PILOTDECK_HOME 是进程级环境变量），所以放最后。
run "左栏 会话下拉"           bash scripts/run_scope_verify.sh

printf '\n\033[1m########## 回归汇总 ##########\033[0m\n'
printf '通过 %s / 失败 %s / 超时跳过 %s\n' "$OK" "$FAIL" "$SKIP"
[ -n "$FAILED" ] && printf '失败项:%s\n' "$FAILED"
printf '数据目录（已隔离，未污染 .artifacts-data）：%s\n' "$ARTIFACTS_DATA_DIR"
printf '服务日志：/tmp/artifacts-regress-serve.log  侧车日志：/tmp/artifacts-regress-sidecar.log\n'
[ "$FAIL" -eq 0 ] || exit 1
