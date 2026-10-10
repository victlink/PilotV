#!/usr/bin/env bash
# 起隔离服务 + 隔离 PilotDeck 家目录，跑左栏「项目 / 会话」下拉的验收。
#
# 为什么必须自带服务而不是共用回归那套：verify_scope.py 靠 PILOTDECK_HOME 指向
# 一个**假的** ~/.pilotdeck/projects/ 才能造出「活跃会话 / 最近更新会话」两种状态。
# PILOTDECK_HOME 是进程级环境变量，共用服务的话要么改不到（不生效），要么改了
# 之后整套回归后面的用例都在对着假家目录跑 —— 那比不跑更糟。
set -uo pipefail
cd "$(dirname "$0")/.."
export ARTIFACTS_DATA_DIR=${ARTIFACTS_DATA_DIR:-/tmp/art-scope-data}
: "${PILOTDECK_HOME:=$(mktemp -d /tmp/pd-scope-XXXXXX)}"
export PILOTDECK_HOME
rm -rf "$ARTIFACTS_DATA_DIR"; mkdir -p "$ARTIFACTS_DATA_DIR"
PORT=${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')}
python3 -u scripts/serve_test.py --port "$PORT" >/tmp/srv_scope.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.3
done
python3 scripts/verify_scope.py --api "http://127.0.0.1:$PORT"
exit $?