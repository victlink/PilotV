#!/usr/bin/env bash
# 给 PilotV 网关生成 TLS 证书。
#
# 为什么必须有这一步：安卓 Chrome 只在「安全上下文」里注册 Service Worker、
# 才给「安装桌面应用」入口。局域网 http://192.168.x.x:5186 不是安全上下文，
# SW 注册直接失败，浏览器永远不给安装 —— 这跟 manifest 写得对不对无关。
#
# 三条路径，按「安卓手机能不能不折腾就认」排序：
#   1. tailscale cert   真正受信任的证书，手机只要装了 Tailscale 就能直接装
#   2. mkcert           本地 CA，手机要手动导入一次 CA 才能信
#   3. openssl 自签     只在本机自测用，安卓会直接拒绝
#
# 用法：
#   bash scripts/make_tls_cert.sh                    # 自动挑路径
#   bash scripts/make_tls_cert.sh <主机名>            # 指定证书要覆盖的主机名
#   PILOTV_TLS_OUT=/path bash scripts/make_tls_cert.sh
set -euo pipefail

HOST="${1:-}"
OUT_DIR="${PILOTV_TLS_OUT:-$HOME/.pilotdeck/tls}"
mkdir -p "$OUT_DIR"
CERT="$OUT_DIR/pilotv-fullchain.pem"
KEY="$OUT_DIR/pilotv-key.pem"

# tailscale cert 需要一个 *.ts.net 名字，且目标机自身在 tailnet 里。
ts_hostname() {
  command -v tailscale >/dev/null 2>&1 || return 1
  # tailscale status --json 里自己的 DNSName，形如 jx88.tail1234.ts.net
  local name
  name="$(tailscale status --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.Self?.DNSName?.replace(/\.$/,"")||"")}catch{}})' \
    2>/dev/null || true)"
  [ -n "$name" ] || return 1
  printf '%s' "$name"
}

if [ -z "$HOST" ] && command -v tailscale >/dev/null 2>&1; then
  HOST="$(ts_hostname || true)"
fi

echo "证书输出目录：$OUT_DIR"
echo "证书覆盖主机名：${HOST:-（未指定）}"

# --- 1. Tailscale：受信任，安卓装 Tailscale 后可直接安装 -------------------------
if [ -n "$HOST" ] && [[ "$HOST" == *.ts.net ]] && command -v tailscale >/dev/null 2>&1; then
  echo "→ 尝试 tailscale cert（受信任，推荐）"
  tmp="$(mktemp -d)"
  # tailscale cert 默认要 root。失败不是致命错：落到 mkcert / 自签，
  # 但要把「怎么才能用上受信任证书」讲清楚，否则安卓那边还是装不上。
  if tailscale cert --cert-file "$tmp/cert.pem" --key-file "$tmp/key.pem" "$HOST" 2>/tmp/pilotv-ts-cert.err; then
    cp "$tmp/cert.pem" "$CERT"; cp "$tmp/key.pem" "$KEY"; chmod 600 "$KEY"
    rm -rf "$tmp"; ok=1
  else
    echo "  跳过：$(tr '\n' ' ' </tmp/pilotv-ts-cert.err | cut -c1-160)"
    echo "  想用受信任证书，执行一次：sudo tailscale set --operator=\$(id -un)"
    rm -rf "$tmp"
  fi
fi

# --- 2. mkcert：需要把 CA 导入手机一次 -----------------------------------------
if [ "${ok:-0}" != "1" ] && command -v mkcert >/dev/null 2>&1; then
  echo "→ 使用 mkcert（需要把 CA 导入手机信任库）"
  hosts="$HOST"
  [ -n "$hosts" ] || hosts="localhost"
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' | head -1 || true)"
  [ -n "$ip" ] || ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [ -n "$ip" ] && hosts="$hosts,$ip,127.0.0.1"
  mkcert -install >/dev/null 2>&1 || true
  mkcert -cert-file "$CERT" -key-file "$KEY" $hosts
  ok=1
fi

# --- 3. 自签：只够本机自测 ------------------------------------------------------
if [ "${ok:-0}" != "1" ]; then
  echo "→ 回落 openssl 自签（安卓 Chrome 会拒绝，仅供本机自测）"
  hosts="$HOST"
  [ -n "$hosts" ] || hosts="localhost"
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' | head -1 || true)"
  [ -n "$ip" ] || ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [ -n "$ip" ] && hosts="$hosts,$ip,127.0.0.1"
  san="DNS:localhost,IP:127.0.0.1"
  IFS=',' read -ra parts <<<"$hosts"
  for h in "${parts[@]}"; do
    case "$h" in
      localhost) continue ;;
      *[!0-9.]*) san="$san,DNS:$h" ;;   # 看起来是 IP 的走 IP:，否则走 DNS:
      *) san="$san,IP:$h" ;;
    esac
  done
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$KEY" -out "$CERT" -subj "/CN=PilotV" \
    -addext "subjectAltName=$san" >/dev/null 2>&1
  chmod 600 "$KEY"
fi

# --- 自检：证书必须能被 TLS 握手读出来，否则网关启动就报文件坏了 -------------------
if ! openssl x509 -in "$CERT" -noout >/dev/null 2>&1; then
  echo "✗ 生成出来的证书读不出来：$CERT" >&2; exit 1
fi
if ! openssl x509 -in "$CERT" -noout -checkend 86400 >/dev/null 2>&1; then
  echo "✗ 证书 24 小时内就过期（或已过期）：$CERT" >&2; exit 1
fi
echo "✓ 证书可用"
echo
echo "把这两行配进网关环境变量："
echo "  PILOTV_TLS_CERT=$CERT"
echo "  PILOTV_TLS_KEY=$KEY"
