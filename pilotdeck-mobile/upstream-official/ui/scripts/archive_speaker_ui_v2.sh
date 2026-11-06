#!/usr/bin/env bash
# 归档本轮 UI 四项改动（说话人筛选 / 角色标签 / 回复折叠 / 抽屉去改动）
# 产物目录：/vol4/1000/00/产物/PilotV_UI_说话人筛选_v2_20261106
set -euo pipefail

REPO=/vol3/1000/Work/00/PilotV
UI=$REPO/pilotdeck-mobile/upstream-official/ui
OUT=/vol4/1000/00/产物/PilotV_UI_说话人筛选_v2_20261106

rm -rf "$OUT"
mkdir -p "$OUT/src/components/chat-v2" "$OUT/src/components/app-shell" \
         "$OUT/src/i18n/locales/zh-CN" "$OUT/src/i18n/locales/en" \
         "$OUT/src/scripts" "$OUT/qa"

# --- 源码快照 ---
for f in \
  src/components/chat-v2/agentIdentity.ts \
  src/components/chat-v2/agentIdentity.spec.ts \
  src/components/chat-v2/ProjectTeamStrip.tsx \
  src/components/chat-v2/ProjectTeamStrip.test.tsx \
  src/components/chat-v2/MessageRowV2.tsx \
  src/components/chat-v2/MessageRowV2.speaker.test.tsx \
  src/components/chat-v2/MessagesPaneV2.tsx \
  src/components/chat-v2/MessagesPaneV2.speaker.test.tsx \
  src/components/chat-v2/ChatInterfaceV2.tsx \
  src/components/chat-v2/ChatInterfaceV2.agent.test.tsx \
  src/components/app-shell/MainAreaV2.tsx \
  src/components/app-shell/MainAreaV2.test.tsx \
  src/i18n/locales/zh-CN/chat.json \
  src/i18n/locales/en/chat.json ; do
  cp "$UI/$f" "$OUT/$f"
done

cp "$UI"/scripts/smoke_*.mjs "$OUT/src/scripts/"
cp "$UI/scripts/archive_speaker_ui_v2.sh" "$OUT/src/scripts/"

# --- 发布补丁 ---
cd "$REPO"
git format-patch -1 2047124 --stdout > "$OUT/release-2047124.patch"
git format-patch -1 e008136 --stdout > "$OUT/release-e008136.patch"

# --- 校验记录 ---
cp /tmp/tsc.log            "$OUT/qa/tsc-noEmit.log"      2>/dev/null || true
cp /tmp/vitest.log         "$OUT/qa/vitest-chat-v2.log"  2>/dev/null || true
cp /tmp/eslint.log         "$OUT/qa/eslint-touched.log"  2>/dev/null || true
cp /tmp/qa-speaker/result.json "$OUT/qa/smoke-speaker-ui.json" 2>/dev/null || true
cp /tmp/qa-speaker/smoke.png   "$OUT/qa/smoke-speaker-ui.png"  2>/dev/null || true
cp /tmp/smoke-multi4.json "$OUT/qa/smoke-multi-speaker.json" 2>/dev/null || true
cp /tmp/smoke-collapse.json "$OUT/qa/smoke-collapse.json" 2>/dev/null || true

echo "OUT=$OUT"
find "$OUT" -type f | sort
