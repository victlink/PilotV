#!/usr/bin/env bash
# 检查 deploy_pilotv_device.sh 里未加引号的 heredoc（run <<EOF ... EOF）。
#
# 为什么要有这个检查：heredoc 不加引号时，写在里面的 $VAR 会被**本机** shell
# 先展开，而不是目标机。踩过的坑：
#   - $NODE 被本机抢先展开 → 把 NAS 的 /usr/bin/node 写进了 Mac 的 plist，
#     launchd 起不来且日志一字不留；
#   - $HOME/$PATH 被本机抢先展开 → 远端导出的是 NAS 的 PATH，npm 找不到。
# 这类错误在语法检查（bash -n）里完全看不出来，只能靠逐条核对变量清单。
#
# 规则：heredoc 内出现的 $XXX / ${XXX}，除非在白名单里（本来就是本机要展开的），
# 否则必须写成 \$XXX。
set -uo pipefail
SCRIPT="${1:-scripts/deploy_pilotv_device.sh}"

# 这些是本机 bash 真有、且本就该在写 heredoc 时展开的变量
ALLOW='DEV_DIR|PORT|ART_PORT|DEPLOY_SUBDIR|TARGET|BUNDLE_SIZE|REPO_ROOT|UI'
# 远端要用的，不能提前展开
REMOTE='HOME|PATH|USER|GROUP|c|NODE|OS|IP|GOT|UID_|STAMP|TARGET_ORIG'

fail=0
in_block=0
line_no=0
while IFS= read -r line; do
  line_no=$((line_no + 1))

  if [[ $in_block -eq 0 ]]; then
    # 进入未加引号的 heredoc
    if [[ $line == 'run <<EOF' ]]; then in_block=1; fi
    continue
  fi

  if [[ $line == 'EOF' ]]; then in_block=0; continue; fi

  # 剥掉注释行
  stripped="${line%%#*}"
  [[ -z ${stripped// /} ]] && continue

  # 找未转义的 $VAR / ${VAR}
  # 用正则逐个匹配；已转义的 \$ 会被前面的反斜杠吃掉
  bad=$(printf '%s\n' "$line" |
    perl -ne 'while (/(?<!\\)\$\{?([A-Za-z_][A-Za-z0-9_]*)/g) { print "$1\n" }')
  [[ -z $bad ]] && continue

  while read -r var; do
    [[ -z $var ]] && continue
    if [[ $var =~ ^($ALLOW)$ ]]; then continue; fi
    printf '  ✗ 第 %s 行：\$${var} 会被本机提前展开（应写成 \\$%s）\n' "$line_no" "$var"
    printf '      %s\n' "$line"
    fail=$((fail + 1))
  done <<< "$bad"
done < "$SCRIPT"

echo
if [[ $fail -eq 0 ]]; then
  echo "heredoc 变量转义检查通过 ✓（$SCRIPT）"
  exit 0
fi
echo "发现 $fail 处未转义的变量。"
exit 1
