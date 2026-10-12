#!/usr/bin/env bash
# PilotV 一键启动：把「前端 + 成果台」当成一个可搬走的产品来启动。
#
# 组成（都能用环境变量覆盖，换机器部署只改这几行）：
#   UI_PORT              前端端口，默认 5186
#   PILOTDECK_BACKEND    PilotDeck 后端 host:port，默认 127.0.0.1:3001
#   ARTIFACTS_TARGET     成果台 API/静态页来源，默认 http://127.0.0.1:8799
#   HOST_CONSOLE_DIR     宿主 console 代码目录（PilotDeck 侧，不属于本项目）
#   CONSOLE_CONFIG       成果台 console 配置，默认 console-artifacts.yaml
#
# 用法：
#   ./start.sh              前台启动（Ctrl-C 退出）
#   ./start.sh --status     只看状态
#   ./start.sh --stop       停掉本脚本起的进程
#   ./start.sh --no-console 不动 console，只把前端指到现成的成果台
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
UI_DIR="$HERE/pilotdeck-mobile/upstream-official/ui"
UI_PORT=${UI_PORT:-5186}
PILOTDECK_BACKEND=${PILOTDECK_BACKEND:-127.0.0.1:3001}
ARTIFACTS_TARGET=${ARTIFACTS_TARGET:-http://127.0.0.1:8799}
HOST_CONSOLE_DIR=${HOST_CONSOLE_DIR:-/vol3/1000/Work/PilotDeck/PilotCode}
CONSOLE_CONFIG=${CONSOLE_CONFIG:-$HERE/console-artifacts.yaml}
SECRETS="$HERE/.artifacts-secrets.env"
RUN_DIR=${RUN_DIR:-/tmp/pilotv-run}
UI_LOG="$RUN_DIR/ui.log"
PID_UI="$RUN_DIR/ui.pid"

mkdir -p "$RUN_DIR"

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

console_port() {
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
}

# 用 ss 判断端口占用：/dev/tcp 只探测本机 IPv4，绑定在其它接口上的服务会漏掉。
port_busy() { ss -ltn "sport = :$1" 2>/dev/null | grep -q ":$1" ; }

stop_all() {
  if [ -f "$PID_UI" ]; then kill "$(cat "$PID_UI")" 2>/dev/null || true; rm -f "$PID_UI"; echo "已停止前端（$UI_PORT）"; fi
  if [ -f /tmp/art-console.pid ]; then kill "$(cat /tmp/art-console.pid)" 2>/dev/null || true; rm -f /tmp/art-console.pid; echo "已停止成果台 console"; fi
}

status() {
  port_busy "$UI_PORT" && echo "前端 http://<本机>:$UI_PORT/ 运行中" || echo "前端未运行（$UI_PORT）"
  local cp; cp=$(console_port)
  port_busy "$cp" && echo "成果台 http://127.0.0.1:$cp/ 运行中" || echo "成果台未运行（$cp）"
  curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$cp/api/artifacts?limit=1" >/dev/null 2>&1 \
    && echo "成果台 API 正常" || echo "成果台 API 不可达（未启动或被锁定）"
}

case "${1:-}" in
  --status) status; exit 0 ;;
  --stop) stop_all; exit 0 ;;
  --no-console) : ;;
  "")
    # 默认顺手把成果台也带起来；HOST_CONSOLE_DIR 缺失就只提示，不猜路径。
    cp=$(console_port)
    if port_busy "$cp"; then
      echo "成果台已在 $cp 运行，沿用现有实例"
    elif [ -f "$HOST_CONSOLE_DIR/console_server.py" ]; then
      # 三个鉴权变量必须显式传入：console 不读自己的 env 文件，漏一个就全员掉线。
      if [ -f "$SECRETS" ]; then set -a; . "$SECRETS"; set +a; fi
      export ARTIFACTS_CONSOLE_DIR="$HERE"   # 明确指向本项目，不靠宿主里的猜测路径
      (cd "$HOST_CONSOLE_DIR" && setsid nohup python3 console_server.py --config "$CONSOLE_CONFIG" </dev/null >"$RUN_DIR/console.log" 2>&1 & echo $! > /tmp/art-console.pid)
      sleep 2
      port_busy "$cp" && echo "成果台已启动（$cp）" || die "成果台启动失败，见 $RUN_DIR/console.log"
    else
      echo "! 找不到宿主 console：$HOST_CONSOLE_DIR" >&2
      echo "  前端仍可启动，成果窗口会提示 API 不可用。" >&2
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
    if curl -fsS --noproxy '*' --max-time 2 "http://$probe:$UI_PORT/" >/dev/null 2>&1; then
      echo "就绪：http://$probe:$UI_PORT/"; exit 0
    fi
  done
  sleep 1
done
echo "! 前端没能在 20 秒内就绪，日志：$UI_LOG" >&2
tail -5 "$UI_LOG" >&2 2>/dev/null
exit 1