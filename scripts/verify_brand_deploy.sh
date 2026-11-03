#!/usr/bin/env bash
# 部署后实况校验：网关(HTTPS 5186) 与 artifacts(8799) 实际吐出的品牌资源
set -uo pipefail
# 品牌素材已于 2026-10-17 迁至推广项目目录，此处仅用于比对哈希，故只读引用新路径
BRAND="/home/marc/项目/VICTLINK 推广/brand"
DIST=/home/marc/PilotV/pilotdeck-mobile/upstream-official/ui/dist
GW="https://127.0.0.1:5186"
AR="http://127.0.0.1:8799"

echo "=== 1) 网关 $GW ==="
for f in brand/pilotv-mark.svg brand/pilotv-lockup.svg brand/pilotv-logo-animated.svg \
         brand/pilotv-logo-animated-light.svg brand/pilotv-logo-animated-dark.svg \
         brand/pilotv-logo-static-light.svg brand/pilotv-logo-static-dark.svg favicon.svg logo.svg; do
  code=$(curl -sk -o /tmp/live.bin -w '%{http_code}' --max-time 10 "$GW/$f")
  live=$(sha256sum /tmp/live.bin | cut -c1-16); src=$(sha256sum "$DIST/$f" 2>/dev/null | cut -c1-16)
  bytes=$(stat -c%s /tmp/live.bin)
  [ "$live" = "$src" ] && v="与 dist 一致 ✓" || v="!! 与 dist 不一致 (HTTP $code)"
  printf '  %-38s HTTP %s %7sB  %s\n' "$f" "$code" "$bytes" "$v"
done

echo; echo "=== 2) 缓存头 ==="
curl -skI "$GW/favicon.svg" | grep -iE '^(cache-control|content-type)' | sed 's/^/  favicon  /'
curl -skI "$GW/brand/pilotv-mark.svg" | grep -iE '^(cache-control|content-type)' | sed 's/^/  mark     /'

echo; echo "=== 3) 首页品牌引用 ==="
curl -sk "$GW/" | grep -oE '(href|src)="[^"]*(favicon|logo|icon|manifest)[^"]*"' | sort -u | sed 's/^/  /'

echo; echo "=== 4) artifacts $AR/artifacts-static/ ==="
for f in brand/pilotv-mark.svg brand/pilotv-lockup.svg icon.svg manifest.webmanifest; do
  code=$(curl -s -o /tmp/art.bin -w '%{http_code}' --max-time 10 "$AR/artifacts-static/$f")
  bytes=$(stat -c%s /tmp/art.bin)
  printf '  %-30s HTTP %s %7sB\n' "$f" "$code" "$bytes"
done
code=$(curl -s -o /tmp/art.bin -w '%{http_code}' --max-time 10 "$AR/artifacts-static/brand/pilotv-mark.svg")
live=$(sha256sum /tmp/art.bin | cut -c1-16); src=$(sha256sum "$BRAND/pilotv-mark.svg" | cut -c1-16)
[ "$live" = "$src" ] && echo "  mark.svg 与 brand 源一致 ✓" || echo "  !! mark.svg 不一致"

echo; echo "=== 5) 在线动画 logo 特征抽查 ==="
curl -sk "$GW/brand/pilotv-logo-animated.svg" -o /tmp/anim.svg
for k in '#297cc0' '#e55a09' '16s' 'v-spin' 'v-reveal'; do
  printf '  %-9s 出现 %s 次\n' "$k" "$(grep -o "$k" /tmp/anim.svg | wc -l)"
done
