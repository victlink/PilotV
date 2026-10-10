#!/usr/bin/env bash
# 起/重启成果台的宿主 console，让 PilotV 在 Tailscale 上真能用。
#
# 边界说清楚（这个项目以前写错过，别再混）：
#   PilotV 自带 artifacts_console.py，它既能被自己的 serve_test.py 独立跑起来，
#   也能作为插件挂进一个已有的宿主 console 上。走宿主这条路是**部署选择**，
#   不是代码归属 —— PilotV 的代码一行都不在那个仓库里，
#   也不该把那个仓库的路径当成自己的默认。
#   所以下面这个目录是「宿主 console 在哪」，仅此而已；用 HOST_CONSOLE_DIR 覆盖。
#
# 为什么需要这个脚本：
#   1. 鉴权靠三个环境变量（会话密钥、成果台 token、登录口令），而 console **不读**
#      console.env —— 不显式传进去，重启后全部失效（会话密钥一变，所有人当场掉线）。
#   2. 光起服务不够：必须 `bind: [loopback, tailscale]` 才会在 100.x 上监听。
#   3. 之前那个 console 是手工 `python3 console_server.py` 起的，没有重启脚本，
#      下次谁重启谁就踩坑。
#
# 用法：
#   bash scripts/start-console-tailscale.sh            # 端口被占就拒绝，不动现有进程
#   bash scripts/start-console-tailscale.sh --restart  # 停掉旧进程再起（会中断正在看页面的人）
#   bash scripts/start-console-tailscale.sh --status
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
# 宿主 console 的代码目录（不是 PilotV 的一部分）
HOST_CONSOLE_DIR=${HOST_CONSOLE_DIR:-/vol3/1000/Work/PilotDeck/PilotCode}
CONFIG=${CONSOLE_CONFIG:-$ROOT/console-artifacts.yaml}
SECRETS="$ROOT/.artifacts-secrets.env"
LOG=${CONSOLE_LOG:-/tmp/art-console.log}
# 配置不存在时兜底 8799：以前这里直接 open()，文件一没就抛 FileNotFoundError，
# 连下面那句 print(... or 8799) 的兜底都走不到，脚本当场崩、连端口都算不出来。
# 配置在 /tmp 时尤其容易踩 —— 一次重启就没了。
PORT=$(python3 - "$CONFIG" <<'PY'
import os, re, sys
text = ""
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        text = fh.read()
except OSError:
    pass
m = re.search(r"^port:\s*(\d+)", text, re.M)
print(m.group(1) if m else 8799)
PY
)
PID_FILE=/tmp/art-console.pid

[ -f "$SECRETS" ] || { echo "缺少 $SECRETS（先 chmod 600 建好，里面是会话密钥/token/口令）"; exit 1; }
set -a; . "$SECRETS"; set +a

# 端口是不是真的有人在服务：用 connect 探，不可用 bind 探。
# 坑：刚 kill 掉 console，8799 上还挂着一堆 TIME_WAIT 连接，裸 bind() 会 EADDRINUSE，
# 于是脚本以为「端口还没让出来」直接放弃 —— 服务就这么没了，人还以为是偶发。
# 服务端 socket 带 SO_REUSEADDR 能正常重启，所以这里必须用 connect 判活。
port_busy() { python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
try:
    sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
finally:
    s.close()
PY
}

case "${1:-}" in
  --status)
    if port_busy "$PORT"; then echo "console 在跑（端口 $PORT）"; else echo "console 没跑（端口 $PORT 空着）"; exit 1; fi
    curl -s -o /dev/null -w "  /artifacts.html=%{http_code}\n" "http://127.0.0.1:$PORT/artifacts.html"
    exit 0 ;;
  --restart) : ;;
  "")
    if port_busy "$PORT"; then
      echo "端口 $PORT 已被占用。确认要重启就加 --restart（会中断正在看成果台的人）。"
      exit 1
    fi ;;
  *) echo "未知参数：$1"; exit 2 ;;
esac

if [ "${1:-}" = "--restart" ]; then
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$(cat "$PID_FILE")" 2>/dev/null || break; sleep 0.5; done
  fi
  pkill -f "console_server.py --config $CONFIG" 2>/dev/null
  for _ in $(seq 1 20); do port_busy "$PORT" || break; sleep 0.5; done
  port_busy "$PORT" && { echo "端口 $PORT 还是没让出来，放弃重启"; exit 1; }
  echo "旧 console 已停。"
fi

cd "$HOST_CONSOLE_DIR" || exit 2
# 成果台实现在 PilotV 仓库里，不在宿主 console 的默认候选路径下；
# 不显式指过去，console 挂载成果台那一步会直接失败。
ARTIFACTS_CONSOLE_DIR=${ARTIFACTS_CONSOLE_DIR:-$ROOT}
export ARTIFACTS_CONSOLE_DIR
[ -f "$CONFIG" ] || echo "提示：配置 $CONFIG 不存在，按默认端口 8799 启动"
nohup python3 console_server.py --config "$CONFIG" >>"$LOG" 2>&1 &
echo $! > "$PID_FILE"

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/artifacts/health" 2>/dev/null; then
    echo "console 已就绪（pid $(cat "$PID_FILE")，日志 $LOG）"
    TS=$(tailscale ip -4 2>/dev/null | head -1)
    [ -n "$TS" ] && echo "Tailscale 链接：http://$TS:$PORT/artifacts.html"
    exit 0
  fi
  sleep 0.5
done
echo "启动超时，日志尾部："; tail -15 "$LOG"; exit 1
