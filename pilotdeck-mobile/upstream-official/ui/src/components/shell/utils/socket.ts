import { activeBackendOrigin, withDeviceParam } from '../../app-shell/pilotvRuntime';
import { readTokenFor } from '../../auth/deviceTokens';
import { IS_PLATFORM } from '../../../constants/config';
import type { ShellIncomingMessage, ShellOutgoingMessage } from '../types/types';

export function getShellWebSocketUrl(): string | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 令牌现在按设备分开存（deviceTokens.ts）。还读旧的 auth-token 会导致
  // 登录过的设备连不上终端——那个 key 在迁移后已经不存在了。
  const token = readTokenFor(activeBackendOrigin());

  // 带上当前设备，和主 WebSocket 保持一致，否则切设备后终端还连着旧后端。
  if (IS_PLATFORM || !token) {
    return withDeviceParam(`${protocol}//${window.location.host}/shell`);
  }

  return withDeviceParam(`${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`);
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}