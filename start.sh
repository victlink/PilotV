#!/usr/bin/env bash
# PilotV 一键启动：把「前端 + 成果台」当成一个可搬走的产品来启动。
#
# 换一台机器部署，只需要改下面这几个环境变量，不用碰代码：
#   UI_PORT              前端端口，默认 5186
#   PILOTDECK_BACKEND    PilotDeck 后端 host:port，默认 127.0.0.1:3001
#   ARTIFACTS_PORT       成果台端口，默认 8799
#   ARTIFACTS_TARGET     前端代理的成果台地址，默认就是本机 $ARTIFACTS_PORT；
#                        要挂到别的机器上的成果台时才需要显式写
#   ARTIFACTS_DATA_DIR   成果存储目录，默认 <项目根>/.artifacts-data
#   ARTIFACTS_BIND       成果台监听地址，默认 127.0.0.1（只有回环）。
#                        改成 0.0.0.0 必须同时设 ARTIFACTS_TOKEN，否则服务拒绝启动。
#   PILOTV_ARTIFACTS_HOST  service（默认，本项目自带）| console（挂 PilotDeck 宿主 console）
#
# 用法：
#   ./start.sh              起成果台（若未运行）再起前端
#   ./start.sh --status     只看状态
#   ./start.sh --stop       停掉本脚本起的进程
#   ./start.sh --no-console 不动成果台，只把前端指到现成的成果台
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
UI_DIR="$HERE/pilotdeck-mobile/upstream-official/ui"
UI_PORT=${UI_PORT:-5186}
PILOTDECK_BACKEND=${PILOTDECK_BACKEND:-127.0.0.1:3001}
ARTIFACTS_PORT=${ARTIFACTS_PORT:-8799}
HOST_CONSOLE_DIR=${HOST_CONSOLE_DIR:-/vol3/1000/Work/PilotDeck/PilotCode}
CONSOLE_CONFIG=${CONSOLE_CONFIG:-$HERE/console-artifacts.yaml}
SECRETS="$HERE/.artifacts-secrets.env"
RUN_DIR=${RUN_DIR:-/tmp/pilotv-run}
UI_LOG="$RUN_DIR/ui.log"
PID_UI="$RUN_DIR/ui.pid"

mkdir -p "$RUN_DIR"

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 成果台端口：自带 service 时看 ARTIFACTS_PORT；挂宿主 console 时看它的配置文件。
console_port() {
  if [ "${PILOTV_ARTIFACTS_HOST:-service}" = "console" ]; then
    python3 - "$CONSOLE_CONFIG" <<'PY'
import re, sys
text = ""
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        text = fh.read()
except OSError:
    pass
m = re.search(r"^port:\s*(\d+)", text, re.M)
print(m.group(1) if m else 8799)
PY
  else
    echo "$ARTIFACTS_PORT"
  fi
}

# 用 ss 判断端口占用：/dev/tcp 只探测本机 IPv4，绑定在其它接口上的服务会漏掉。
port_busy() { ss -ltn "sport = :$1" 2>/dev/null | grep -q ":$1" ; }

stop_all() {
  if [ -f "$PID_UI" ]; then kill "$(cat "$PID_UI")" 2>/dev/null || true; rm -f "$PID_UI"; echo "已停止前端（$UI_PORT）"; fi
  if [ -f /tmp/art-console.pid ]; then kill "$(cat /tmp/art-console.pid)" 2>/dev/null || true; rm -f /tmp/art-console.pid; echo "已停止成果台 console"; fi
}

status() {
  port_busy "$UI_PORT" && echo "前端 http://<本机>:$UI_PORT/ 运行中" || echo "前端未运行（$UI_PORT）"
  local cp="${ARTIFACTS_TARGET##*:}"
  port_busy "$cp" && echo "成果台 $ARTIFACTS_TARGET 运行中" || echo "成果台未运行（$ARTIFACTS_TARGET）"
  curl -fsS --noproxy '*' --max-time 3 "$ARTIFACTS_TARGET/api/artifacts?limit=1" >/dev/null 2>&1 \
    && echo "成果台 API 正常" || echo "成果台 API 不可达（未启动或被锁定）"
  curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$UI_PORT/" >/dev/null 2>&1 \
    && echo "前端代理 http://127.0.0.1:$UI_PORT/api/artifacts 正常" || echo "前端代理未就绪"
}

start_console() {
  local port="$1"
  if [ -f "$SECRETS" ]; then set -a; . "$SECRETS"; set +a; fi

  # 优先用本项目自带的 service/serve_artifacts.py：只装本项目就能跑，
  # 不再需要 PilotCode 目录里的 console_server.py。
  if [ "${PILOTV_ARTIFACTS_HOST:-service}" = "service" ]; then
    (setsid nohup python3 "$HERE/service/serve_artifacts.py" --host "${ARTIFACTS_BIND:-127.0.0.1}" --port "$port" \
      </dev/null >"$RUN_DIR/console.log" 2>&1 & echo $! > /tmp/art-console.pid)
  elif [ -f "$HOST_CONSOLE_DIR/console_server.py" ]; then
    # 退路：挂到 PilotDeck 宿主 console 上。三个鉴权变量必须显式传入 ——
    # console 不读自己的 env 文件，漏一个就全员掉线。
    export ARTIFACTS_CONSOLE_DIR="$HERE"
    (cd "$HOST_CONSOLE_DIR" && setsid nohup python3 console_server.py --config "$CONSOLE_CONFIG" \
      </dev/null >"$RUN_DIR/console.log" 2>&1 & echo $! > /tmp/art-console.pid)
  else
    die "PILOTV_ARTIFACTS_HOST=${PILOTV_ARTIFACTS_HOST:-service} 但找不到宿主 console：$HOST_CONSOLE_DIR"
  fi

  for _ in $(seq 1 15); do
    if curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$port/api/artifacts?limit=1" >/dev/null 2>&1; then
      echo "成果台已启动（$port，${PILOTV_ARTIFACTS_HOST:-service}）"; return 0
    fi
    sleep 1
  done
  die "成果台启动失败，见 $RUN_DIR/console.log"
}

case "${1:-}" in
  --status) status; exit 0 ;;
  --stop) stop_all; exit 0 ;;
  --no-console) : ;;
  "")
    port=$(console_port)
    if port_busy "$port"; then
      # 端口上已经有东西就复用，但要说清是谁：自带的 service 还是宿主 console。
      if curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
        echo "成果台已在 $port 运行（自带 service），沿用现有实例"
      elif curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$port/artifacts.html" >/dev/null 2>&1; then
        echo "成果台已在 $port 运行（宿主 console），沿用现有实例"
      else
        die "$port 被占用，但不是成果台。换个 ARTIFACTS_PORT，或先停掉占用者。"
      fi
    else
      start_console "$port"
    fi
    ;;
  *) die "未知参数：$1" ;;
esac

[ -d "$UI_DIR" ] || die "缺少前端源码：$UI_DIR"

# dist 不存在或比源码旧就先构建，避免部署到旧产物。
if [ ! -f "$UI_DIR/dist/index.html" ] || [ -n "$(find "$UI_DIR/src" "$UI_DIR/public" "$UI_DIR/vite.config.js" -newer "$UI_DIR/dist/index.html" -print -quit 2>/dev/null)" ]; then
  echo "构建前端…"
  (cd "$UI_DIR" && npm run build) || die "前端构建失败"
fi

port_busy "$UI_PORT" && die "$UI_PORT 已被占用（先 ./start.sh --stop，或换 UI_PORT）"

export PROXY_HOST="${PILOTDECK_BACKEND%:*}"
export SERVER_PORT="${PILOTDECK_BACKEND##*:}"
# 前面 console_port 已经算过端口了：没显式指定就指向本机那个成果台实例。
ARTIFACTS_TARGET=${ARTIFACTS_TARGET:-http://127.0.0.1:$(console_port)}
export ARTIFACTS_PROXY_TARGET="$ARTIFACTS_TARGET"

echo "PilotV"
echo "  前端   http://0.0.0.0:$UI_PORT/"
echo "  后端   $PILOTDECK_BACKEND"
echo "  成果台 $ARTIFACTS_TARGET"
# 放进新会话（setsid）再脱离挂起：调用方的进程组被收走时，前端不会被连带杀掉。
# 只靠 & 或 nohup 不够 —— 这正是之前 5190 起完就消失的原因。
(cd "$UI_DIR" && setsid nohup npx vite preview --host 0.0.0.0 --port "$UI_PORT" --strictPort </dev/null >"$UI_LOG" 2>&1 & echo $! > "$PID_UI")

# 有环境里 vite 只绑到具体网卡、回环不通，所以回环不通再试本机地址。
PROBES="127.0.0.1 $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | head -1)"
for _ in $(seq 1 20); do
  for probe in $PROBES; do
    body=$(curl -fsS --noproxy '*' --max-time 2 "http://$probe:$UI_PORT/" 2>/dev/null)
    # 光看 curl 成功是不够的：端口被别的服务占住时，它同样会回 200。必须确认
    # 回来的页面确实是本项目的前端，否则"就绪"会把人引到一个完全不相干的应用上。
    case "$body" in
      *PilotDeck*|*pilotdeck*) echo "就绪：http://$probe:$UI_PORT/"; exit 0 ;;
      "") ;;
      *) ;; # 有别的应用占着，继续等；20 秒后报错退出
    esac
  done
  sleep 1
done
echo "! 前端没能在 20 秒内就绪（或 $UI_PORT 上跑的是别的应用），日志：$UI_LOG" >&2
tail -5 "$UI_LOG" >&2 2>/dev/null
exit 1