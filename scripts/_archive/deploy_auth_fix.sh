#!/usr/bin/env bash
# 把 auth-token 修复同步到各设备的 PilotV 仓库：先改源文件，再换掉整份 dist。
#
# 只同步源码是不行的：网关直接读 dist/index.html，跑的是上一次 vite build 的产物，
# 不重新构建的话每台设备还是会拿旧 bundle 去登录。dist 是纯静态产物，跟平台无关，
# 所以在这里构建一次、各设备直接接收，不用让每台机器各跑一遍 vite。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_REL="pilotdeck-mobile/upstream-official/ui"

CHANGED_SOURCES=(
  "$UI_REL/src/utils/api.js"
  "$UI_REL/src/utils/uploadFormData.ts"
  "$UI_REL/src/utils/uploadFormData.spec.ts"
  "$UI_REL/src/components/project-creation-wizard/data/workspaceApi.ts"
)

HOSTS=("${@:-}")
if [ ${#HOSTS[@]} -eq 0 ] || [ "${HOSTS[0]}" = "" ]; then
  HOSTS=(leo-mac ai-jx88)
fi

for host in "${HOSTS[@]}"; do
  echo "==> $host"
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$host" "mkdir -p ~/PilotV/$UI_REL/src/utils ~/PilotV/$UI_REL/src/components/project-creation-wizard/data"
  for rel in "${CHANGED_SOURCES[@]}"; do
    scp -q "$REPO_ROOT/$rel" "$host:~/PilotV/$rel"
    echo "    src  $rel"
  done
  rsync -az --delete "$REPO_ROOT/$UI_REL/dist/" "$host:~/PilotV/$UI_REL/dist/"
  echo "    dist synced"
done

echo "done"
