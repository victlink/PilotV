#!/usr/bin/env bash
# 把 PilotV 成果台部署到 marc-linux-pc。
#
# 只同步 Python 服务代码，**绝不碰 data/ 目录**（里面是评审人的真实成果和
# artifacts.db）。每次同步前先备份上一版，出问题能立刻退回去。
#
# 用法：bash scripts/deploy_artifacts_marc.sh [--dry-run]
set -euo pipefail

TARGET="marc-linux-pc"
REMOTE_DIR="/home/marc/pilotv-artifacts"
SERVICE="pilotv-artifacts.service"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 服务运行需要的全部模块。少一个就是一次线上 500 —— 上次就是漏了
# pilotdeck_workspace.py，/api/artifacts/workspace 挂了整整两天。
FILES=(
  artifacts_console.py
  artifacts_store.py
  artifacts_deliver.py
  artifacts_notify.py
  artifacts_cdp.py
  pilotdeck_workspace.py
  "service/serve_artifacts.py:serve_artifacts.py"
  # CAD 预览：artifacts_console 只负责调用，转换进程活在 scripts/ 里。
  # 漏了它，/viewer 会一直 503（缺转换器），而原始 STEP 还能下载 ——
  # 正是「界面看着正常、三维点开是空白」那种难查的故障。
  artifacts_cad.py
  "scripts/cad_to_glb.py:scripts/cad_to_glb.py"
)

echo "=== 1. 本地文件齐不齐 ==="
missing=0
for entry in "${FILES[@]}"; do
  src="${entry%%:*}"
  if [[ ! -f "$ROOT/$src" ]]; then
    echo "  缺：$src"
    missing=1
  else
    printf "  ok  %-28s %s bytes\n" "$src" "$(wc -c < "$ROOT/$src")"
  fi
done
[[ $missing -eq 0 ]] || { echo "本地文件不全，中止。"; exit 1; }

echo "=== 2. 语法预检（在本地过一遍，别把坏代码推上去） ==="
python3 -m py_compile "${FILES[@]%%:*}" "$ROOT/service/serve_artifacts.py"
echo "  语法通过"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "=== --dry-run：到此为止，不动远端 ==="
  exit 0
fi

echo "=== 3. 远端备份 ==="
STAMP=$(date +%Y%m%d-%H%M%S)
ssh -o BatchMode=yes "$TARGET" "
  set -e
  mkdir -p ~/pilotv-artifacts-backups/$STAMP
  # 只备份代码，data/ 不进去
  cp -a $REMOTE_DIR/*.py ~/pilotv-artifacts-backups/$STAMP/ 2>/dev/null || true
  systemctl --user cat $SERVICE > ~/pilotv-artifacts-backups/$STAMP/$SERVICE.txt 2>/dev/null || true
  echo \"  已备份到 ~/pilotv-artifacts-backups/$STAMP\"
  ls ~/pilotv-artifacts-backups/$STAMP/
"

echo "=== 4. 同步代码 ==="
ssh -o BatchMode=yes "$TARGET" "mkdir -p $REMOTE_DIR/scripts"
for entry in "${FILES[@]}"; do
  src="${entry%%:*}"
  dst="${entry##*:}"
  [[ "$src" == "$dst" ]] || dst="$(basename "$src")"
  scp -q -o BatchMode=yes "$ROOT/$src" "$TARGET:$REMOTE_DIR/$dst"
  printf "  %s -> %s\n" "$src" "$dst"
done

echo "=== 5. 远端自检 ==="
ssh -o BatchMode=yes "$TARGET" "
  set -e
  cd $REMOTE_DIR
  # 关键：确认每个模块都能真正 import，缺依赖要在这里就暴露
  python3 -c 'import serve_artifacts; print(\"  import 正常\")'
  python3 -c 'import artifacts_console, artifacts_store, artifacts_deliver, artifacts_notify, artifacts_cdp, pilotdeck_workspace; print(\"  全部模块 import 正常\")'
  # 转换器跑在子进程里：主进程 import 得动不代表 OCP 装得上，这里查真实可用性。
  python3 -c 'import artifacts_cad; print(\"  CAD 转换器:\", artifacts_cad.converter_status())'
"

echo "=== 6. 重启服务 ==="
ssh -o BatchMode=yes "$TARGET" "
  set -e
  systemctl --user restart $SERVICE
  sleep 3
  systemctl --user is-active $SERVICE
"

echo "=== 7. 健康检查 ==="
ssh -o BatchMode=yes "$TARGET" "
  set -e
  # 从目标机本地打，绕开网络层，只验服务本身
  code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8799/api/artifacts/health || true)
  echo \"  /api/artifacts/health -> \$code\"
  # workspace 这个接口之前就是挂在这里，必须验它回来了
  tok=\$(cat ~/.config/pilotv-artifacts/token 2>/dev/null || true)
  if [ -n \"\$tok\" ]; then
    wcode=\$(curl -s -o /tmp/ws.json -w '%{http_code}' -H \"Authorization: Bearer \$tok\" http://127.0.0.1:8799/api/artifacts/workspace || true)
    echo \"  /api/artifacts/workspace -> \$wcode\"
    if [ \"\$wcode\" = \"500\" ]; then
      echo '  !! workspace 仍然 500，看日志：'
      journalctl --user -u $SERVICE --no-pager -n 15
      exit 1
    fi
  fi
  # 成果 HTML 的隔离头要真的出现在响应里
  echo '  --- raw 响应头检查 ---'
  curl -s -D - -o /dev/null -H \"Authorization: Bearer \$tok\" \
    http://127.0.0.1:8799/api/artifacts/nonexistent/raw 2>/dev/null | grep -iE 'x-content-type|content-security' || echo '  (无成果可验，属正常)'
"

echo "=== 8. 确认没有新报错 ==="
ssh -o BatchMode=yes "$TARGET" "
  journalctl --user -u $SERVICE --since '-2min' --no-pager 2>&1 | grep -iE 'traceback|error' | head -5 \
    || echo '  重启后无报错 ✓'
"

echo
echo "部署完成。回滚：把 ~/pilotv-artifacts-backups/$STAMP/*.py 拷回去再 restart。"
