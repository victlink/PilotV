#!/usr/bin/env bash
# 起隔离服务 + 隔离 PilotDeck 家目录，跑需求 1-5 的浏览器手势验收。
set -uo pipefail
cd "$(dirname "$0")/.."
export ARTIFACTS_DATA_DIR=${ARTIFACTS_DATA_DIR:-/tmp/art-gestures-data}
export PILOTDECK_HOME=${PILOTDECK_HOME:-$(mktemp -d /tmp/pd-gestures-XXXXXX)}
rm -rf "$ARTIFACTS_DATA_DIR"; mkdir -p "$ARTIFACTS_DATA_DIR"
PORT=${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')}
python3 -u scripts/serve_test.py --port "$PORT" >/tmp/srv_gestures.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.3
done
node scripts/verify_gestures.mjs --api "http://127.0.0.1:$PORT"
exit $?