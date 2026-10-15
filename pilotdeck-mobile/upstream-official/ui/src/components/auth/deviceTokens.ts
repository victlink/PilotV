// 每台设备一份登录令牌。
//
// 官方 UI 原本只用一个 localStorage['auth-token']。PilotV 把多个后端聚到同一个
// 页面来源下之后，这个 key 会被所有设备共用：A 机器的令牌发到 B 机器只会得到 401，
// 用户被迫反复登录。改成按后端 origin 分开存，来回切换就不用重登。
//
// 旧的 auth-token 会在第一次读取时迁到当前设备名下，不丢已有登录态。

const MAP_KEY = 'pilotdeck-tokens';
const LEGACY_KEY = 'auth-token';

function safeRead(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeWrite(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 存储不可用则忽略 */ }
}

function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* 存储不可用则忽略 */ }
}

function readMap(): Record<string, string> {
  const raw = safeRead(MAP_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') map[key] = value;
      return map;
    }
  } catch { /* 坏数据当空表处理，下一次写入会覆盖 */ }
  return {};
}

function writeMap(map: Record<string, string>): void {
  safeWrite(MAP_KEY, JSON.stringify(map));
}

/** 读当前设备的令牌；顺带把历史遗留的 auth-token 认到这台设备名下。 */
export function readTokenFor(origin: string): string | null {
  const map = readMap();
  const existing = map[origin];
  if (typeof existing === 'string' && existing) return existing;
  const legacy = safeRead(LEGACY_KEY);
  if (!legacy) return null;
  map[origin] = legacy;
  writeMap(map);
  return legacy;
}

export function writeTokenFor(origin: string, token: string): void {
  const map = readMap();
  map[origin] = token;
  writeMap(map);
}

export function clearTokenFor(origin: string): void {
  const map = readMap();
  delete map[origin];
  writeMap(map);
  if (Object.keys(map).length === 0) safeRemove(LEGACY_KEY);
}