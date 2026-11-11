#!/usr/bin/env bash
# PilotV Linux 一键安装（单文件，无需其它脚本）
#
# 用法：
#   ./pilotv-install.sh                     安装并启动
#   ./pilotv-install.sh --check            只体检，不写任何文件
#   ./pilotv-install.sh --update --tag v20261111.1  按 release tag 升级（推荐）
#   ./pilotv-install.sh --update           更新到最新 main 并重启（旧行为，已不推荐）
#   ./pilotv-install.sh --start-only       只起服务（systemd 单元用）
#   ./pilotv-install.sh --uninstall        停服并把安装目录改名保留
#
# 可用环境变量覆盖：PILOTV_INSTALL_DIR / PILOTV_BRANCH / PILOTV_REPO_URL /
# PILOTV_PUBLIC_ORIGIN / PILOTV_LAN_PORT / PILOTV_NODE_MIRROR / PILOTV_SKIP_DEPS
set -Eeuo pipefail

VERSION=0.1.2
PRODUCT=PilotV
REPO_URL=${PILOTV_REPO_URL:-https://github.com/VICTLINK/PilotV.git}
BRANCH=${PILOTV_BRANCH:-main}
# A floating branch is not a version. Prefer deploy/upgrade.sh <tag> or --tag.
RELEASE_TAG=${PILOTV_RELEASE_TAG:-}
INSTALL_DIR=${PILOTV_INSTALL_DIR:-"$HOME/.pilotv/app"}
PUBLIC_ORIGIN=${PILOTV_PUBLIC_ORIGIN:-}
LAN_PORT=${PILOTV_LAN_PORT:-5186}
NODE_MIRROR=${PILOTV_NODE_MIRROR:-https://nodejs.org/dist}
REPO_DIR="$INSTALL_DIR/repo"
TOOLS_DIR="$INSTALL_DIR/tools"
VENV_DIR="$INSTALL_DIR/venv"
RUN_DIR="$INSTALL_DIR/run"
NODE_DIR="$TOOLS_DIR/node"
MARKER="$INSTALL_DIR/.pilotv-installed"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME=pilotv.service

MODE=install
DO_SERVICE=0
NO_START=0

usage() {
  cat <<'USAGE'
PilotV Linux 一键安装 v0.1.2
  --check          只读体检：系统/运行时/端口/网络
  --update         更新仓库并重启服务（保留数据与配置；请配合 --tag）
  --tag <vX.Y.Z>   锁定 release tag，禁止跟随浮动 main
  --start-only     只启动服务（供 systemd 单元调用）
  --uninstall      停服并把安装目录改名为 .uninstalled-<时间戳>
  --service        安装并启用 systemd 用户单元（开机自启）
  --no-start       装完不启动
  --dir <path>     安装目录，默认 ~/.pilotv/app
  --branch <name>  分支，默认 main
  --public-origin <url> 公网入口，写进二维码备用地址（如 https://pilotv.example.com）
  --lan-port <n>   局域网直连端口，默认 5186
  -h|--help        本帮助
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --update) MODE=update ;;
    --start-only) MODE=start-only ;;
    --uninstall) MODE=uninstall ;;
    --service) DO_SERVICE=1 ;;
    --no-start) NO_START=1 ;;
    --dir) INSTALL_DIR=$2; REPO_DIR="$INSTALL_DIR/repo"; TOOLS_DIR="$INSTALL_DIR/tools"; VENV_DIR="$INSTALL_DIR/venv"; RUN_DIR="$INSTALL_DIR/run"; NODE_DIR="$TOOLS_DIR/node"; MARKER="$INSTALL_DIR/.pilotv-installed"; shift ;;
    --branch) BRANCH=$2; shift ;;
    --tag) RELEASE_TAG=$2; shift ;;
    --public-origin) PUBLIC_ORIGIN=$2; shift ;;
    --lan-port) LAN_PORT=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    -v|--version) echo "$PRODUCT $VERSION"; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mOK\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

port_busy() { (exec 3<>/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1 && return 0 || return 1; }

# ------------------------------ 只读体检 ------------------------------
if [ "$MODE" = check ]; then
  log "系统：$(uname -srm)"; [ "$(uname -s)" = Linux ] || die "仅支持 Linux"
  for c in bash curl tar python3 git node npm; do
    if command -v "$c" >/dev/null 2>&1; then ok "$c -> $(command -v "$c")"; else warn "$c 未安装（安装器会自动补 Node / venv / pnpm）"; fi
  done
  if command -v node >/dev/null 2>&1; then ok "node $(node -v)"; fi
  if command -v python3 >/dev/null 2>&1; then ok "python3 $(python3 -V 2>&1)"; fi
  for p in 5186 3001 8799 18789 8801; do
    if port_busy "$p"; then warn "端口 $p 已被占用（若已是 PilotV 会复用，否则需先腾出）"; else ok "端口 $p 空闲"; fi
  done
  if curl -fsSIL --max-time 8 "$REPO_URL" >/dev/null 2>&1; then ok "GitHub 仓库可达"; else warn "GitHub 仓库暂不可达（离线安装需预置 repo 目录）"; fi
  log "安装目录将是：$INSTALL_DIR"
  log "体检结束（未做任何修改）"
  exit 0
fi

# ------------------------------ 卸载 ------------------------------
if [ "$MODE" = uninstall ]; then
  log "停止服务"
  if [ -f "$REPO_DIR/start.sh" ]; then (cd "$REPO_DIR" && PATH="$VENV_DIR/bin:$NODE_DIR/bin:$PATH" ./start.sh --stop) >/dev/null 2>&1 || true; fi
  systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$UNIT_NAME" 2>/dev/null || true
  if [ -f "$MARKER" ]; then
    backup="${INSTALL_DIR}.uninstalled-$(date +%Y%m%d-%H%M%S)"
    mv "$INSTALL_DIR" "$backup"
    ok "已卸载，原目录完整保留在：$backup"
  else
    warn "未找到安装标记 $MARKER，为安全起见不移动目录"
  fi
  exit 0
fi

# ------------------------------ 前置 ------------------------------
[ "$(uname -s)" = Linux ] || die "仅支持 Linux"
need curl
need tar
log "$PRODUCT $VERSION / 安装目录 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$TOOLS_DIR" "$RUN_DIR"

# Node 22.13 ~ 22.x：满足就复用，否则下载官方便携版到安装目录，不污染系统。
ensure_node() {
  local v=""
  if command -v node >/dev/null 2>&1; then v=$(node -v 2>/dev/null | tr -d 'v'); fi
  if [ -n "$v" ]; then
    local major=${v%%.*}
    if [ "$major" = 22 ]; then ok "复用系统 Node v$v"; NODE_DIR=""; return; fi
  fi
  if [ -x "$NODE_DIR/bin/node" ]; then ok "复用便携 Node $("$NODE_DIR/bin/node" -v)"; return; fi
  log "下载 Node 22 LTS 便携版"
  local sums="$TOOLS_DIR/SHASUMS256.txt"
  curl -fsSL --max-time 30 "$NODE_MIRROR/latest-v22.x/SHASUMS256.txt" -o "$sums" || die "取 Node 版本清单失败（可用 PILOTV_NODE_MIRROR 换镜像）"
  local fname
  fname=$(awk '/node-v22.*-linux-x64.tar.xz$/ {print $2; exit}' "$sums")
  [ -n "$fname" ] || die "清单里找不到 linux-x64 的 Node 22 包"
  curl -fL --max-time 300 "$NODE_MIRROR/latest-v22.x/$fname" -o "$TOOLS_DIR/$fname" || die "下载 Node 失败"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$TOOLS_DIR/$fname" -C "$NODE_DIR" --strip-components=1 || die "解压 Node 失败"
  rm -f "$TOOLS_DIR/$fname" "$sums"
  ok "便携 Node 就位：$("$NODE_DIR/bin/node" -v)"
}

# 把便携 Node / venv 放到 PATH 最前面，后续所有命令都用这套运行时。
refresh_path() {
  if [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ]; then PATH="$NODE_DIR/bin:$PATH"; fi
  if [ -x "$VENV_DIR/bin/python3" ]; then PATH="$VENV_DIR/bin:$PATH"; fi
  export PATH
}

ensure_python() {
  need python3
  if [ ! -x "$VENV_DIR/bin/python3" ]; then
    log "创建 Python 虚拟环境"
    python3 -m venv "$VENV_DIR" || die "python3 -m venv 失败（Debian 系可能需 python3-venv）"
  fi
  "$VENV_DIR/bin/python" -m pip install -q --disable-pip-version-check -r "$REPO_DIR/requirements.txt" || die "安装 aiohttp 失败"
  ok "Python 依赖（aiohttp）就位"
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then ok "复用 pnpm $(pnpm -v)"; return; fi
  log "启用 pnpm（corepack）"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@9 --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    npm install -g --no-audit --no-fund pnpm@9 >/dev/null 2>&1 || die "安装 pnpm 失败"
  fi
  ok "pnpm $(pnpm -v)"
}

fetch_repo() {
  local upstream="$REPO_DIR/pilotdeck-mobile/upstream-official"
  if [ -d "$REPO_DIR/.git" ]; then
    if [ -n "$RELEASE_TAG" ]; then
      log "锁定 release tag $RELEASE_TAG"
      (cd "$REPO_DIR" && git fetch --depth 1 origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG" \
        && git checkout --detach "$RELEASE_TAG") || die "按 tag 更新失败"
      local declared declared_status
      declared=$(cd "$REPO_DIR" && node -e 'const d=require("./deploy/release.json");process.stdout.write(String(d.releaseTag||""))' 2>/dev/null || true)
      declared_status=$(cd "$REPO_DIR" && node -e 'const d=require("./deploy/release.json");process.stdout.write(String(d.status||""))' 2>/dev/null || true)
      [ "$declared" = "$RELEASE_TAG" ] || die "release.json 声明的是 $declared，却要求 $RELEASE_TAG"
      [ "$declared_status" = "released" ] || die "release.json 状态为 $declared_status，未发布的 tag 禁止装到设备"
    else
      warn "跟随浮动 main 不是版本化升级；建议改用 deploy/upgrade.sh <tag>"
      log "更新仓库到 origin/$BRANCH"
      (cd "$REPO_DIR" && git fetch --depth 1 origin "$BRANCH" && git reset --hard "origin/$BRANCH") || die "git 更新失败"
    fi
  elif [ -f "$upstream/package.json" ]; then
    ok "复用已有 repo 目录（非 git，跳过更新）"
  else
    log "克隆 $PRODUCT 仓库"
    rm -rf "$REPO_DIR"
    if command -v git >/dev/null 2>&1; then
      if [ -n "$RELEASE_TAG" ]; then
        git clone --depth 1 --branch "$RELEASE_TAG" "$REPO_URL" "$REPO_DIR" || die "git clone 失败"
      else
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR" || die "git clone 失败"
      fi
    else
      need python3   # 无 git 时用 tarball
      local tar="$TOOLS_DIR/pilotv.tar.gz"
      curl -fL --max-time 300 "https://github.com/VICTLINK/PilotV/archive/refs/heads/$BRANCH.tar.gz" -o "$tar" || die "下载仓库压缩包失败"
      mkdir -p "$REPO_DIR"
      tar -xzf "$tar" -C "$REPO_DIR" --strip-components=1 || die "解压仓库失败"
      rm -f "$tar"
    fi
  fi
  [ -f "$upstream/package.json" ] || die "仓库结构不对：缺 $upstream/package.json"
  ok "仓库就位：$REPO_DIR"
}

write_env() {
  cat > "$REPO_DIR/.env.local" <<EOF
# 由 pilotv-install.sh 生成；本机专属配置，不进版本库。
# 用 \${VAR:-默认值} 写法，命令行显式传入的值仍然优先。
PILOTV_PUBLIC_ORIGINS="\${PILOTV_PUBLIC_ORIGINS:-$PUBLIC_ORIGIN}"
PILOTV_LAN_PORT="\${PILOTV_LAN_PORT:-$LAN_PORT}"
EOF
  chmod 600 "$REPO_DIR/.env.local"
  ok "已写入 .env.local（公网入口=${PUBLIC_ORIGIN:-未设置}，局域网端口=$LAN_PORT）"
}

install_deps() {
  local upstream="$REPO_DIR/pilotdeck-mobile/upstream-official"
  [ "${PILOTV_SKIP_DEPS:-0}" = 1 ] && { warn "跳过依赖安装（PILOTV_SKIP_DEPS=1）"; return; }
  log "安装前端/后端依赖（pnpm workspace，首次约需数分钟）"
  (cd "$upstream" && pnpm install --no-frozen-lockfile --ignore-scripts=false) || die "pnpm install 失败"
  log "构建前端 dist"
  (cd "$upstream/ui" && pnpm run build) || die "前端构建失败"
  ok "依赖与前端产物就位"
}

# ------------------------------ 服务 ------------------------------
start_backends() {
  local upstream="$REPO_DIR/pilotdeck-mobile/upstream-official"
  local token_file="$HOME/.config/pilotv/artifacts-token"
  mkdir -p "$(dirname "$token_file")"
  if [ ! -s "$token_file" ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$token_file"
    chmod 600 "$token_file"
  fi
  export PILOTV_ARTIFACTS_TOKEN="$(tr -d '\r\n' < "$token_file")"

  if port_busy 18789; then ok "Agent 网关 18789 已在运行，复用"; else
    log "启动 Agent 网关 18789"
    (cd "$upstream" && setsid nohup node --import tsx src/cli/pilotdeck.ts server --port 18789 \
      </dev/null >"$RUN_DIR/agent.log" 2>&1 & echo $! > "$RUN_DIR/agent.pid")
  fi
  if port_busy 3001; then ok "Web/API 3001 已在运行，复用"; else
    log "启动 Web/API 3001"
    (cd "$upstream/ui" && setsid nohup env SERVER_PORT=3001 HOST=0.0.0.0 \
      PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18789/ws \
      node --import tsx server/index.js \
      </dev/null >"$RUN_DIR/web.log" 2>&1 & echo $! > "$RUN_DIR/web.pid")
  fi
  # start.sh 起成果台 8799 与前端网关 5186，并自动构建 dist。
  log "启动成果台 8799 与前端网关 5186"
  (cd "$REPO_DIR" && ./start.sh) || die "start.sh 启动失败，见 $RUN_DIR 与 /tmp/pilotv-run/ui.log"
}

wait_ready() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:5186/pair" >/dev/null 2>&1; then
      ok "配对页就绪：http://127.0.0.1:5186/pair"; return 0
    fi
    sleep 1
  done
  warn "配对页 30 秒内未就绪，请查看 $RUN_DIR/*.log 与 /tmp/pilotv-run/ui.log"
  return 1
}

install_systemd() {
  command -v systemctl >/dev/null 2>&1 || { warn "无 systemd，跳过开机自启"; return; }
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$UNIT_NAME" <<EOF
[Unit]
Description=PilotV (paired mobile host)
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PATH=$VENV_DIR/bin:${NODE_DIR:-/usr}/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$INSTALL_DIR/pilotv-install.sh --start-only
ExecStop=$REPO_DIR/start.sh --stop
WorkingDirectory=$REPO_DIR

[Install]
WantedBy=default.target
EOF
  cp "$0" "$INSTALL_DIR/pilotv-install.sh" 2>/dev/null || true
  chmod +x "$INSTALL_DIR/pilotv-install.sh"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 || true
  ok "已安装 systemd 用户单元 $UNIT_NAME（如未生效可执行 loginctl enable-linger $USER）"
}

print_summary() {
  local lan_ip
  lan_ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[01])\.' | head -1)
  echo
  log "安装完成。用电脑浏览器打开下面任一地址，登录后用安卓客户端「扫码连接」："
  [ -n "$lan_ip" ] && echo "    http://$lan_ip:$LAN_PORT/pair      <- 手机与电脑同一 Wi-Fi 时最快"
  echo "    http://127.0.0.1:$LAN_PORT/pair        <- 只在本机看"
  [ -n "$PUBLIC_ORIGIN" ] && echo "    $PUBLIC_ORIGIN/pair                  <- 公网入口（无需 Tailscale）"
  echo
  echo "  更新：$INSTALL_DIR/pilotv-install.sh --update"
  echo "  状态：(cd $REPO_DIR && ./start.sh --status)"
  echo "  日志：$RUN_DIR/ 与 /tmp/pilotv-run/"
}

# ------------------------------ 主流程 ------------------------------
case "$MODE" in
  start-only)
    refresh_path
    start_backends
    wait_ready || true
    ;;
  update)
    refresh_path
    log "停止前端/成果台"
    (cd "$REPO_DIR" && ./start.sh --stop) >/dev/null 2>&1 || true
    fetch_repo
    ensure_python
    ensure_pnpm
    install_deps
    write_env
    [ "$NO_START" = 1 ] || { start_backends; wait_ready || true; }
    [ "$DO_SERVICE" = 1 ] && install_systemd
    print_summary
    ;;
  install)
    ensure_node
    refresh_path
    fetch_repo
    ensure_python
    ensure_pnpm
    install_deps
    write_env
    date -u '+%FT%TZ' > "$MARKER"
    [ "$DO_SERVICE" = 1 ] && install_systemd
    [ "$NO_START" = 1 ] || { start_backends; wait_ready || true; }
    print_summary
    ;;
esac
