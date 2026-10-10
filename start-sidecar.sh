#!/bin/sh
# 成果台 MCP 侧车 · 拉起器
#
#   ./start-sidecar.sh            # 幂等启动（已在跑就直接返回）
#   ./start-sidecar.sh status
#   ./start-sidecar.sh restart
#   ./start-sidecar.sh stop
#
# 为什么单独一个脚本而不是塞进 console_server.py：
#   侧车是 Node 进程，console 是 Python 进程。混在一起要么 fork node，
#   要么 console 得知道 node 在哪。用 shell 拉最直白，也方便单独重启。
#
# 环境变量：
#   ARTIFACTS_API   console REST 根（默认 http://127.0.0.1:8799）
#   ARTIFACTS_PORT  侧车端口（默认 8801）
#   PILOTDECK_SRC   MCP SDK 所在仓库（默认 /home/Marc/PilotDeck-src）
set -eu
cd "$(dirname "$0")"

PORT="${ARTIFACTS_PORT:-8801}"
API="${ARTIFACTS_API:-http://127.0.0.1:8799}"
RUN_DIR=".artifacts-data"
PID_FILE="$RUN_DIR/sidecar.pid"
LOG_FILE="$RUN_DIR/sidecar.log"

mkdir -p "$RUN_DIR"

port_open() {
  python3 - "$1" <<'EOF' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.4)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
EOF
}

# PID 文件里的进程还活着 **且** 真的在听端口，才算在运行。
# 只看 PID 会误认：PilotDeck 也会用 stdio 方式拉起同一个 artifacts-mcp.mjs
# （那个进程不监听端口、还可能带着错的 ARTIFACTS_API），PID 文件一旦指向它，
# 就会出现「侧车在运行」但工具调用全 fetch failed 的假象。
running_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  port_open "$PORT" || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q "artifacts-mcp.mjs" || return 1
  echo "$pid"
}

# 端口被占但 PID 文件丢了（手起过 / 被回收过）时的兜底：
# 只认命令行里确实是本侧车的进程，绝不误杀同端口的别的服务。
port_owner_pid() {
  pids=$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) \
          | grep -E "[:.]$PORT[[:space:]]" \
          | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u )
  for p in $pids; do
    if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q "artifacts-mcp.mjs"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

wait_ready() {
  i=0
  while [ "$i" -lt 50 ]; do
    if port_open "$PORT"; then return 0; fi
    i=$((i + 1))
    sleep 0.2
  done
  return 1
}

cmd_start() {
  if pid=$(running_pid); then
    echo "侧车已在运行（pid $pid，端口 $PORT）"
    return 0
  fi
  if port_open "$PORT"; then
    if pid=$(port_owner_pid); then          # 自己人，只是 PID 文件丢了 → 认下来
      echo "$pid" >"$PID_FILE"
      echo "侧车已在运行（pid $pid，端口 $PORT，PID 文件已补写）"
      return 0
    fi
    echo "! 端口 $PORT 被别的进程占用：换个 ARTIFACTS_PORT，或先停掉它" >&2
    return 1
  fi
  ARTIFACTS_API="$API" ARTIFACTS_PORT="$PORT" nohup node artifacts-mcp.mjs \
    >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  if wait_ready; then
    echo "侧车已启动（pid $(cat "$PID_FILE")，http://127.0.0.1:$PORT/api/artifacts-mcp → $API）"
    if ! port_open 8799 && [ "$API" = "http://127.0.0.1:8799" ]; then
      echo "! console（8799）还没起，侧车能启动但工具调用会失败" >&2
    fi
  else
    echo "! 侧车启动超时，日志见 $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    return 1
  fi
}

cmd_stop() {
  if ! running_pid >/dev/null 2>&1 && pid=$(port_owner_pid); then
    echo "$pid" >"$PID_FILE"                # PID 文件丢了也照样能停
  fi
  if pid=$(running_pid); then
    kill "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do i=$((i + 1)); sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "侧车已停止（pid $pid）"
  else
    rm -f "$PID_FILE"
    echo "侧车未在运行"
  fi
}

cmd_status() {
  if pid=$(running_pid) || pid=$(port_owner_pid); then
    echo "运行中：pid $pid，端口 $PORT"
    [ -f "$PID_FILE" ] || echo "$pid" >"$PID_FILE"
  else
    echo "未运行"
    return 1
  fi
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop || true; sleep 0.3; cmd_start ;;
  status)  cmd_status ;;
  *) echo "用法: $0 [start|stop|restart|status]" >&2; exit 2 ;;
esac
