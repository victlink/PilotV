#!/usr/bin/env python3
"""Restore NAS gateway from its pre-room backup and add only room routing."""
from pathlib import Path
import shutil

repo = Path('/vol3/1000/Work/00/PilotV')
backup = Path('/vol3/1000/Work/00/PilotV-backups/rooms-20261031T200038/pilotv_gateway.mjs')
target = repo / 'service/pilotv_gateway.mjs'
source = backup.read_text(encoding='utf-8')
if "pathname === '/api/artifacts/rooms'" in source:
    raise SystemExit('backup already contains room route; refusing ambiguous merge')
if "roomTarget:" in source:
    raise SystemExit('backup already contains roomTarget; refusing ambiguous merge')
text = source
old = """export function classifyPath(pathname) {
  // 独立成果台页面已删除，只剩成果页要用的静态资源（vendor 三维渲染器、图标）和 API。
  if (pathname.startsWith('/artifacts-static/') || pathname.startsWith('/artifacts/')
    || pathname === '/api/artifacts' || pathname.startsWith('/api/artifacts/')) {
    return 'artifacts';
  }
"""
new = """export function classifyPath(pathname) {
  // 项目室 API 在 NAS 本机部署；普通成果继续按原有目标转发。
  if (pathname === '/api/artifacts/rooms' || pathname.startsWith('/api/artifacts/rooms/')) {
    return 'room';
  }
  // 独立成果台页面已删除，只剩成果页要用的静态资源（vendor 三维渲染器、图标）和 API。
  if (pathname.startsWith('/artifacts-static/') || pathname.startsWith('/artifacts/')
    || pathname === '/api/artifacts' || pathname.startsWith('/api/artifacts/')) {
    return 'artifacts';
  }
"""
if old not in text:
    raise SystemExit('classifyPath anchor not found in NAS backup')
text = text.replace(old, new, 1)
old = """    if (route === 'artifacts' || route === 'backend') {
      const backend = resolveBackend(request, config, devices);
"""
new = """    if (route === 'room') {
      // 房间服务只绑定 NAS loopback；不复用远端成果令牌。
      return forward(request, response, config.roomTarget,
        url.pathname + url.search, null, true);
    }

    if (route === 'artifacts' || route === 'backend') {
      const backend = resolveBackend(request, config, devices);
"""
if old not in text:
    raise SystemExit('handler anchor not found in NAS backup')
text = text.replace(old, new, 1)
old = """    artifactsTarget: normalizeOrigin(env.ARTIFACTS_TARGET || env.PILOTV_ARTIFACTS_TARGET || 'http://127.0.0.1:8799') || 'http://127.0.0.1:8799',
    artifactsPerDevice: env.PILOTV_ARTIFACTS_PER_DEVICE !== '0',
"""
new = """    artifactsTarget: normalizeOrigin(env.ARTIFACTS_TARGET || env.PILOTV_ARTIFACTS_TARGET || 'http://127.0.0.1:8799') || 'http://127.0.0.1:8799',
    roomTarget: normalizeOrigin(env.PILOTV_ROOM_TARGET || 'http://127.0.0.1:8799') || 'http://127.0.0.1:8799',
    artifactsPerDevice: env.PILOTV_ARTIFACTS_PER_DEVICE !== '0',
"""
if old not in text:
    raise SystemExit('config anchor not found in NAS backup')
text = text.replace(old, new, 1)
shutil.copy2(target, target.with_suffix('.mjs.pre-room-merge'))
target.write_text(text, encoding='utf-8')
print('merged room route into NAS gateway from backup; original target saved as .pre-room-merge')
