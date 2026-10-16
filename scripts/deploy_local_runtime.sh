#!/usr/bin/env bash
# 把当前仓库的成果台代码与前端产物落到本机运行时，并重启服务。
#
# 和 deploy_pilotv_device.sh 的区别：那台脚本是「装到一台设备上」，会
# bundle + reset --hard 开发目录 + 装依赖；本机开发目录就是这台机器自己，
# reset --hard 会把**别的对话**还没提交的改动一起抹掉。所以这里只做三件事：
#   1. 同步运行时代码到 ~/pilotv-artifacts（先备份，data/ 永不覆盖）
#   2. 重建前端 dist（网关直接伺服这个目录）
#   3. 重启 pilotv-artifacts 与 pilotv-gateway
#
# 用法：bash scripts/deploy_local_runtime.sh [--no-build] [--no-restart]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="${PILOTV_ARTIFACTS_DIR:-$HOME/pilotv-artifacts}"
UI="$REPO/pilotdeck-mobile/upstream-official/ui"
ARTIFACTS_SERVICE="${ARTIFACTS_SERVICE:-pilotv-artifacts.service}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-pilotv-gateway.service}"
BUILD=1
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-restart) RESTART=0 ;;
    *) echo "不认识的参数：$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# 运行时真正加载的成果台文件。少了任何一个，成果台会以「接口 404」的形式
# 报错，而不是启动失败 —— 所以这份清单要跟着 artifacts_console.py 一起改。
RUNTIME_FILES=(
  artifacts_console.py
  artifacts_store.py
  artifacts_deliver.py
  artifacts_notify.py
  artifacts_cdp.py
  artifacts_cad.py
  pilotdeck_workspace.py
)

say "1/4 同步成果台代码到 $DEPLOY"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEPLOY"
if [ -d "$DEPLOY/data" ]; then
  BACKUP="$HOME/pilotv-artifacts-backups/$STAMP"
  mkdir -p "$BACKUP"
  # 只备份代码：data/ 是评审人的真实成果，备份一份就是多一份会丢的东西。
  cp -a "$DEPLOY"/*.py "$BACKUP"/ 2>/dev/null || true
  [ -d "$DEPLOY/scripts" ] && cp -a "$DEPLOY/scripts" "$BACKUP"/ 2>/dev/null || true
  echo "  旧代码已备份到 $BACKUP"
fi
mkdir -p "$DEPLOY/data" "$DEPLOY/scripts"
for f in "${RUNTIME_FILES[@]}"; do
  [ -f "$REPO/$f" ] || { echo "  ✗ 仓库里没有 $f" >&2; exit 1; }
  cp -f "$REPO/$f" "$DEPLOY/"
  echo "  已同步 $f"
done
cp -f "$REPO/service/serve_artifacts.py" "$DEPLOY/"
# cad_to_glb.py 跑在隔离 venv 里，artifacts_cad 按自己的目录找它，位置不能变。
cp -f "$REPO/scripts/cad_to_glb.py" "$DEPLOY/scripts/"
echo "  已同步 scripts/cad_to_glb.py"

( cd "$DEPLOY" && python3 -c 'import serve_artifacts; print("  import 自检通过")' )
# CAD 转换器缺了不是启动失败，是 /viewer 现场炸：这里提前问一句。
# 关键是要用**服务那套环境变量**去问：转换器在 $ARTIFACTS_DATA_DIR/venvs/cad，
# 而单元里把 ARTIFACTS_DATA_DIR 指到部署目录的 data/（不是模块旁边的
# .artifacts-data/）。不带上这个变量就会误报「没装转换器」。
( cd "$DEPLOY" && ARTIFACTS_DATA_DIR="$DEPLOY/data" python3 -c '
import artifacts_cad
status = artifacts_cad.converter_status()
print("  三维转换器：", "可用 " + status.get("python", "") if status.get("ok")
      else "不可用 —— /viewer 会如实报「这台机器没装三维转换器」")
' )

say "2/4 重建前端"
if [ "$BUILD" = 1 ]; then
  ( cd "$UI" && npm run build )
  [ -f "$UI/dist/index.html" ] || { echo "  ✗ 没产出 index.html" >&2; exit 1; }
  echo "  dist 体积：$(du -sh "$UI/dist" | cut -f1)"
else
  echo "  跳过（--no-build）"
fi

say "3/4 重启服务"
# 两个服务不一定在同一个 systemd 作用域里（网关可能是系统级、成果台是用户级），
# 而且 `systemctl --user` 在非交互式 shell 里常常直接连不上总线 —— 所以哪个能用
# 用哪个，失败只记一笔，不让脚本在这里就断掉：断掉的话，第 4 步的自检就没人跑了，
# 而「服务没起来」正是最需要自检说清楚的情况。
restart_one() {
  local unit="$1"
  systemctl --user restart "$unit" 2>/dev/null \
    || systemctl restart "$unit" 2>/dev/null \
    || { echo "  ! $unit 重启失败（继续往下走，第 4 步会告诉你还活着没有）"; return 1; }
  echo "  $unit 已重启"
}
if [ "$RESTART" = 1 ]; then
  restart_one "$ARTIFACTS_SERVICE" || true
  # 网关是按请求从磁盘读 dist 的，静态产物已经换了；重启只是为了让长连接也干净。
  restart_one "$GATEWAY_SERVICE" || true
  sleep 2
else
  echo "  跳过（--no-restart）"
fi

say "4/4 自检"
BASE=http://127.0.0.1:8799
GATEWAY="https://127.0.0.1:${PILOTV_PORT:-5186}"
console_code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts/workspace" || echo 000)"
gateway_code="$(curl -sk -o /dev/null -w '%{http_code}' "$GATEWAY/" || echo 000)"
echo "  成果台：$BASE/api/artifacts/workspace → $console_code"
echo "  网关  ：$GATEWAY/ → $gateway_code"
# 网关吐出的主包文件名要和本地 dist 对得上：对不上说明在伺服另一份构建目录。
served="$(curl -sk "$GATEWAY/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)"
built="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$UI/dist/index.html" | head -1)"
echo "  线上主包：${served:-没找到}"
echo "  本地主包：${built:-没找到}"
if [ "$RESTART" = 1 ] && { [ "$console_code" != 200 ] || [ -n "$served" ] && [ "$served" != "$built" ]; }; then
  echo "  ✗ 部署没落到线上，先别走：要么服务没起来，要么网关伺服的不是这份 dist" >&2
  exit 1
fi
echo "  部署完成"
