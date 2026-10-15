#!/usr/bin/env bash
# 把 PilotV 部署成一台「自部署」设备。
#
# 什么叫自部署：这台机器自己跑网关、自己托管成果台、自己构建前端，
# 不依赖 NAS 上那个中央网关。装完直接访问 http://<本机>:5186/。
#
# 产生三个目录，分工不同，别搞混：
#   开发目录   ~/PilotV            完整仓库，带 git 历史，可改可提交
#   部署目录   ~/pilotv-artifacts/ 运行时真正加载的成果台代码（+ data/）
#   构建产物   ~/PilotV/pilotdeck-mobile/upstream-official/ui/dist
#
# 用法：bash scripts/deploy_pilotv_device.sh [目标主机] [开发目录]
#   不给目标主机时 = 本机（NAS 自己也得能装）
set -euo pipefail

TARGET="${1:-$(hostname)}"
DEV_DIR="${2:-\$HOME/PilotV}"          # 目标机上的开发目录
DEPLOY_SUBDIR="pilotv-artifacts"
PORT="${PILOTV_PORT:-5186}"
ART_PORT="${PILOTV_ARTIFACTS_PORT:-8799}"
UI="pilotdeck-mobile/upstream-official/ui"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "0. 目标信息"
if [[ "$TARGET" == "$(hostname)" ]]; then
  echo "  本机部署"
  REMOTE=""
else
  echo "  目标主机：$TARGET"
  REMOTE="$TARGET"
fi
echo "  网关端口：$PORT   成果台端口：$ART_PORT"

# 在远端执行一条命令。给命令则远端跑，给空串则本机跑。
#
# PATH 必须补 ~/.local/bin：npm 这类工具不少是用户级装的，
# 非交互式 ssh 的 PATH 里没有它（只在 login shell 里有），会误判成「缺 npm」。
run() {
  if [[ -n "$REMOTE" ]]; then
    ssh -o BatchMode=yes "$REMOTE" \
      'export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; bash -s'
  else
    export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
    bash -s
  fi
}

say "1. 远端依赖体检"
run <<EOF
set -e
for c in git node npm python3; do
  command -v \$c >/dev/null 2>&1 || { echo "  ✗ 缺 \$c"; exit 1; }
done
echo "  git    \$(git --version | awk '{print \$4}')"
echo "  node   \$(node -v)   (Vite 6 需要 >=18.0)"
echo "  npm    \$(npm -v)"
echo "  python \$(python3 -V | awk '{print \$2}')"
python3 -c 'import aiohttp' 2>/dev/null || echo "  ! 缺 aiohttp，成果台起不来：pip install aiohttp"
df -h \$HOME | tail -1 | awk '{print "  磁盘可用：" \$4}'
EOF

say "2. 传仓库（git bundle，带完整历史）"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$(mktemp -t pilotv-XXXXXX.bundle)"
git -C "$REPO_ROOT" bundle create "$BUNDLE" main
BUNDLE_SIZE=$(du -h "$BUNDLE" | cut -f1)
echo "  bundle：$BUNDLE_SIZE"
if [[ -n "$REMOTE" ]]; then
  scp -q -o BatchMode=yes "$BUNDLE" "$REMOTE:/tmp/pilotv.bundle"
else
  cp "$BUNDLE" /tmp/pilotv.bundle
fi
rm -f "$BUNDLE"

say "3. 建开发目录并 clone"
run <<EOF
set -e
if [ -d "$DEV_DIR/.git" ]; then
  echo "  开发目录已存在，先同步远端"
  git -C "$DEV_DIR" fetch /tmp/pilotv.bundle main
  git -C "$DEV_DIR" reset --hard FETCH_HEAD
  git -C "$DEV_DIR" checkout main 2>/dev/null || true
else
  mkdir -p "\$(dirname "$DEV_DIR")"
  # 必须指定 -b main：bundle 里只有 main 这一个 ref，默认分支名猜不对
  git clone -b main /tmp/pilotv.bundle "$DEV_DIR"
fi
rm -f /tmp/pilotv.bundle
echo "  开发目录：$DEV_DIR"
git -C "$DEV_DIR" log --oneline -1
EOF

say "4. 装依赖 + 构建前端"
run <<EOF
set -e
cd "$DEV_DIR/$UI"
# 上游 .gitignore 把 package-lock.json 排除了，所以这里多半没有 lockfile，
# npm ci 会直接报 EUSAGE。有 lockfile 才用 ci（可复现），没有就退回 install。
if [ -d node_modules ]; then
  echo "  node_modules 已存在，跳过安装"
elif [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  echo "  无 lockfile（上游 .gitignore 排除了它），用 npm install"
  npm install --no-audit --no-fund
fi
npm run build
echo "  dist 体积：\$(du -sh dist | cut -f1)"
[ -f dist/index.html ] || { echo "  ✗ 没产出 index.html"; exit 1; }
EOF

say "5. 部署成果台（运行时目录，带备份）"
run <<EOF
set -e
cd "$DEV_DIR"
STAMP=\$(date +%Y%m%d-%H%M%S)
mkdir -p ~/$DEPLOY_SUBDIR
if [ -d ~/$DEPLOY_SUBDIR/data ]; then
  mkdir -p ~/$DEPLOY_SUBDIR-backups/\$STAMP
  cp -a ~/$DEPLOY_SUBDIR/*.py ~/$DEPLOY_SUBDIR-backups/\$STAMP/ 2>/dev/null || true
  echo "  旧代码已备份到 ~/$DEPLOY_SUBDIR-backups/\$STAMP"
fi
# data/ 是评审人的真实成果，只在建目录时碰，绝不覆盖
mkdir -p ~/$DEPLOY_SUBDIR/data
for f in artifacts_console.py artifacts_store.py artifacts_deliver.py \\
         artifacts_notify.py artifacts_cdp.py pilotdeck_workspace.py; do
  cp -f "\$f" ~/$DEPLOY_SUBDIR/
done
cp -f service/serve_artifacts.py ~/$DEPLOY_SUBDIR/
cd ~/$DEPLOY_SUBDIR
python3 -c 'import serve_artifacts; print("  import 自检通过")'
echo "  部署目录：~/$DEPLOY_SUBDIR"
EOF

say "6. 装 PilotDeck 插件清单"
run <<EOF
set -e
cd "$DEV_DIR"
python3 scripts/install_device.py --port $ART_PORT 2>&1 | tail -6
EOF

say "7. 装网关常驻服务并启动"
run <<EOF
set -e
cd "$DEV_DIR"
OS=\$(uname -s)

if [ "\$OS" = "Darwin" ]; then
  # macOS 没有 systemd，用 launchd。plist 放 ~/Library/LaunchAgents，
  # 用户登录（或 enable-linger 后）由 launchd 接管，崩溃自动重启。
  NODE=\$(command -v node)
  mkdir -p ~/Library/LaunchAgents ~/.pilotdeck/logs
  cat > ~/Library/LaunchAgents/com.pilotv.gateway.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pilotv.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DEV_DIR/service/pilotv_gateway.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DEV_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>\$HOME</string>
    <key>PATH</key><string>\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>UI_PORT</key><string>$PORT</string>
    <key>PILOTV_BIND</key><string>0.0.0.0</string>
    <key>PILOTDECK_BACKEND</key><string>127.0.0.1:3001</string>
    <key>PILOTV_DIST</key><string>$DEV_DIR/pilotdeck-mobile/upstream-official/ui/dist</string>
    <key>PILOTV_DEVICES</key><string>$DEV_DIR/pilotdeck-mobile/upstream-official/ui/public/devices.json</string>
    <key>PILOTV_ARTIFACTS_PER_DEVICE</key><string>1</string>
    <key>PILOTV_ARTIFACTS_TARGET</key><string>http://127.0.0.1:$ART_PORT</string>
    <key>PILOTV_ALLOW_DEVICE_WRITES</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>\$HOME/.pilotdeck/logs/pilotv-gateway.log</string>
  <key>StandardErrorPath</key><string>\$HOME/.pilotdeck/logs/pilotv-gateway.log</string>
</dict>
</plist>
PLIST
  launchctl unload ~/Library/LaunchAgents/com.pilotv.gateway.plist 2>/dev/null || true
  launchctl load ~/Library/LaunchAgents/com.pilotv.gateway.plist
  sleep 3
  launchctl list | grep com.pilotv.gateway >/dev/null && echo "  launchd 已加载"
else
  sudo -n mkdir -p /etc/systemd/system ~/.pilotdeck/logs
  # service/pilotv-gateway.service 是模板，__XXX__ 由本机实际路径/用户/端口替换。
  # 不改模板 —— NAS 自己也是从同一个模板生成 unit 的，改了会两边跑偏。
  sudo -n tee /etc/systemd/system/pilotv-gateway.service >/dev/null <<UNIT
\$(sed -e "s#__REPO_ROOT__#$DEV_DIR#g" \\
       -e "s#__HOME__#\$HOME#g" \\
       -e "s#__USER__#\$(id -un)#g" \\
       -e "s#__GROUP__#\$(id -gn)#g" \\
       -e "s#__NODE__#\$(command -v node)#g" \\
       -e "s#__PORT__#$PORT#g" \\
       -e "s#__ARTIFACTS_PORT__#$ART_PORT#g" \\
       service/pilotv-gateway.service)
UNIT
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable --now pilotv-gateway.service
  sleep 3
  sudo -n systemctl is-active pilotv-gateway.service
fi
EOF

say "8. 验证"
run <<EOF
set -e
code=\$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 8 http://127.0.0.1:$PORT/ || true)
echo "  网关首页 http://127.0.0.1:$PORT/ -> \$code"
[ "\$code" = "200" ] || { echo "  ✗ 网关没起来"; LOG="sudo -n journalctl -u pilotv-gateway -n 20 --no-pager"; [ "\$(uname -s)" = "Darwin" ] && LOG="tail -20 ~/.pilotdeck/logs/pilotv-gateway.log"; eval "\$LOG"; exit 1; }
if [ "\$(uname -s)" = "Darwin" ]; then
  tail -50 ~/.pilotdeck/logs/pilotv-gateway.log 2>/dev/null | grep -iE 'traceback|uncaught|fatal' | head -5 \
    || echo "  启动日志无报错 ✓"
else
  sudo -n journalctl -u pilotv-gateway --since '-1min' --no-pager 2>&1 | grep -iE 'traceback|error' | head -5 \
    || echo "  启动日志无报错 ✓"
fi
# hostname -I 是 GNU coreutils 的，macOS 上没有；ifconfig 的输出格式也不同。
IP=\$(hostname -I 2>/dev/null | awk '{print \$1}' | head -1)
[ -n "\$IP" ] || IP=\$(ipconfig getifaddr en0 2>/dev/null || ifconfig 2>/dev/null | awk '/inet /{print \$2}' | grep -v '^127\.' | head -1)
echo
echo "  ── 这台设备的 PilotV 访问地址 ──"
echo "    http://\$IP:$PORT/"
echo "    http://127.0.0.1:$PORT/  （本机自测）"
EOF

say "完成"
echo "  开发目录  $DEV_DIR"
echo "  部署目录  ~/$DEPLOY_SUBDIR"
echo "  访问地址  见上一步"
