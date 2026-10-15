#!/usr/bin/env bash
# 在一台设备上部署 PilotV 成果台侧车。
#
# 为什么要每台一份：成果台是 PilotV 自己的独立服务，上游 PilotDeck 并不带这个功能
# （实测各版本对 /artifacts/api 都只回 SPA 回退页）。要让成果跟着设备切换，就只能
# 每台各跑一份，各自一份数据目录，成果自然不会串台。
#
# 安全边界（照抄 artifacts_console 自己的要求）：
#   一旦对外监听 0.0.0.0，就必须有令牌，否则拒绝启动——成果里常有未公开的稿子。
#   令牌从文件读，不写进命令行参数（ps 一眼就能看见）。
#
# 跑法： bash scripts/deploy_artifacts_sidecar.sh <解包好的目录> [端口] [令牌文件]
set -euo pipefail

SRC="${1:?用法: deploy_artifacts_sidecar.sh <src目录> [端口] [令牌文件]}"
PORT="${2:-8799}"
TOKEN_FILE="${3:-$HOME/.config/pilotv-artifacts/token}"

case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=mac ;;
  *) echo "不支持的系统：$(uname -s)" >&2; exit 1 ;;
esac

INSTALL="$HOME/pilotv-artifacts"
DATA="$INSTALL/data"

echo "=== 1/6 安装到 $INSTALL ==="
mkdir -p "$INSTALL" "$DATA" "$(dirname "$TOKEN_FILE")"
# 只带必需文件；数据目录和令牌不进包，避免把上一台的成果拷到这一台。
# artifacts_*.py 是一组：console 在不同路径上会 import store/deliver/notify/cdp，
# 少拷一个就是启动时 ModuleNotFoundError —— 所以按前缀整体带，不点名。
for f in "$SRC"/artifacts_*.py; do cp -f "$f" "$INSTALL/"; done
cp -f "$SRC/artifacts.html" "$SRC/artifacts.js" "$SRC/artifacts.css" "$INSTALL/"
rm -rf "$INSTALL/static"
cp -r "$SRC/static" "$INSTALL/static"
cp -f "$SRC/service/serve_artifacts.py" "$INSTALL/serve_artifacts.py"
chmod 600 "$TOKEN_FILE" 2>/dev/null || true
echo "已安装 $(ls "$INSTALL" | wc -l) 项，数据目录 $DATA"

echo "=== 2/6 依赖 ==="
PY=python3
if ! "$PY" -c 'import aiohttp' 2>/dev/null; then
  if [ "$PLATFORM" = mac ]; then
    for candidate in python3.12 python3.11 python3.10; do
      if command -v "$candidate" >/dev/null && "$candidate" -c 'import aiohttp' 2>/dev/null; then PY="$candidate"; break; fi
    done
  fi
  if ! "$PY" -c 'import aiohttp' 2>/dev/null; then
    echo "  $PY 没有 aiohttp，装一份"
    "$PY" -m pip install --user --quiet aiohttp 2>&1 | tail -2 || {
      echo "  pip 装不上，试试 --break-system-packages"; "$PY" -m pip install --user --quiet --break-system-packages aiohttp 2>&1 | tail -2; }
  fi
fi
"$PY" -c 'import aiohttp,sys; print("  python", sys.version.split()[0], "aiohttp", aiohttp.__version__)'

echo "=== 3/6 先停旧进程 ==="
pkill -f "pilotv-artifacts/serve_artifacts.py" 2>/dev/null || true
sleep 1

echo "=== 4/6 装开机自启 ==="
if [ "$PLATFORM" = linux ]; then
  UNIT="$HOME/.config/systemd/user/pilotv-artifacts.service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$UNIT" <<EOF
[Unit]
Description=PilotV 成果台
After=network.target

[Service]
Type=simple
Environment=ARTIFACTS_TOKEN_FILE=$TOKEN_FILE
Environment=ARTIFACTS_DATA_DIR=$DATA
Environment=ARTIFACTS_BIND=0.0.0.0
Environment=ARTIFACTS_PORT=$PORT
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=$INSTALL
ExecStart=$PY $INSTALL/serve_artifacts.py --host 0.0.0.0 --port $PORT --token-file $TOKEN_FILE
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable --now pilotv-artifacts >/dev/null 2>&1 || true
  systemctl --user restart pilotv-artifacts >/dev/null 2>&1 || true
  echo "  systemd user unit: pilotv-artifacts"
else
  PLIST="$HOME/Library/LaunchAgents/ai.pilotdeck.artifacts.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.pilotdeck.artifacts</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$INSTALL/serve_artifacts.py</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>$PORT</string>
    <string>--token-file</string><string>$TOKEN_FILE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARTIFACTS_DATA_DIR</key><string>$DATA</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
  </dict>
  <key>WorkingDirectory</key><string>$INSTALL</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST" 2>&1 | tail -1
  echo "  launchd: ai.pilotdeck.artifacts"
fi

echo "=== 5/6 探测 ==="
ok=0
for i in $(seq 1 20); do
  sleep 2
  # 带令牌探，确认是真在服务（而不是只看端口有人听）
  if TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)" && \
     curl -fsS -m 4 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/artifacts?limit=1" -o /tmp/_probe.json 2>/dev/null; then
    if head -c 1 /tmp/_probe.json | grep -q '{'; then ok=1; break; fi
  fi
  echo "  第 $i 次：还没就绪"
done

if [ "$ok" = 1 ]; then
  echo "=== 6/6 完成：本机 $PORT 已就绪，返回真 JSON ==="
  head -c 120 /tmp/_probe.json; echo
else
  echo "=== 6/6 失败：$PORT 没起来 ==="
  if [ "$PLATFORM" = linux ]; then systemctl --user status pilotv-artifacts --no-pager 2>&1 | tail -12; fi
  exit 1
fi