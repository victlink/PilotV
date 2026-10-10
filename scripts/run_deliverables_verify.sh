#!/usr/bin/env bash
# 重启隔离的验收服务，跑交付物验收，收拾干净。
set -uo pipefail
cd "$(dirname "$0")/.."
export ARTIFACTS_DATA_DIR=${ARTIFACTS_DATA_DIR:-/tmp/art-verify-deliver}
rm -rf "$ARTIFACTS_DATA_DIR"; mkdir -p "$ARTIFACTS_DATA_DIR"
export PILOTDECK_HOME=${PILOTDECK_HOME:-$(mktemp -d /tmp/pd-fake-home-XXXXXX)}
PORT=${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')}
python3 -u scripts/serve_test.py --port "$PORT" >/tmp/srv_deliver.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.3
done
python3 scripts/verify_deliverables.py --api "http://127.0.0.1:$PORT"
rc=$?
exit $rc