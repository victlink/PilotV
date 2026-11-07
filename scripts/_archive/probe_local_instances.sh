#!/usr/bin/env bash
# 只读诊断：本地 PilotDeck UI/gateway 实例、其 cwd/启动时间、served bundle 是否含新实现、team 配置
set -u
echo "=== 监听端口 ==="
ss -ltnp 2>/dev/null | grep -E ':(3001|5187|8080|5173|3000)\b' || echo "(none)"

echo
echo "=== node 进程 (pid / cwd / start / cmd) ==="
for p in $(pgrep -f 'node' 2>/dev/null); do
  cwd=$(readlink -f /proc/$p/cwd 2>/dev/null) || continue
  case "$cwd" in
    *PilotV*|*PilotDeck*) ;;
    *) continue ;;
  esac
  st=$(ps -o lstart= -p $p 2>/dev/null | sed 's/^ *//')
  cmd=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-160)
  echo "[$p] cwd=$cwd"
  echo "     start=$st"
  echo "     cmd=$cmd"
done

echo
echo "=== 仓库 dist 是否含新实现 (speaker-filter-team) ==="
for d in /vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/dist \
         /home/Marc/PilotDeck-src/ui/dist \
         /vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/ui/dist ; do
  if [ -d "$d" ]; then
    n=$(grep -rl 'speaker-filter-team' "$d" 2>/dev/null | head -3 | tr '\n' ' ')
    t=$(stat -c '%y' "$d" 2>/dev/null)
    echo "$d  mtime=$t  hit=${n:-NONE}"
  else
    echo "$d  (missing)"
  fi
done

echo
echo "=== project-team.json 存在情况 ==="
for base in /home/Marc/general /home/Marc/pilotv-accept-20261104 /vol3/1000/Work/00/PilotV ; do
  f="$base/.pilotdeck/project-team.json"
  if [ -f "$f" ]; then echo "FOUND $f"; head -c 600 "$f"; echo; else echo "none  $f"; fi
done

echo
echo "=== 仓库 server 侧 agentName 补丁是否存在 ==="
grep -n 'agentName' /vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/server/pilotdeck-bridge.js 2>/dev/null | head -20 || echo "(file missing)"
