export interface Device { name: string; origin: string }
export const DEVICE_KEY = 'pilotdeck-device-directory-v1';
export function validateDevice(name: string, address: string): Device {
  if (!name.trim() || name.trim().length > 80) throw Error('设备名称需为 1–80 个字符');
  let url: URL;
  try { url = new URL(address.trim()); } catch { throw Error('请输入完整 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('只允许官方 UI 根地址，不可包含密码、路径或查询参数');
  return { name: name.trim(), origin: url.origin };
}
export function decodeDevices(raw: string | null): Device[] {
  try {
    const list: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    const unique = new Map<string, Device>();
    for (const value of list) {
      if (!value || typeof value.name !== 'string' || typeof value.origin !== 'string') continue;
      try { const device = validateDevice(value.name, value.origin); unique.set(device.origin, device); } catch { /* skip corrupt entries */ }
    }
    return [...unique.values()];
  } catch { return []; }
}

/** 一次性导入：`?addDevice=` 的解析。
 *  支持两种写法，便于手写链接与分享：
 *    addDevice=名称|http://host:3001;名称2|http://host:3002
 *    addDevice=<encodeURIComponent(JSON)>
 *  逐条走 validateDevice，非法项直接丢掉，绝不把整批导入变成静默失败。 */
export function parseDeviceImport(raw: string | null): Device[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];
  const candidates = text.startsWith('[')
    ? (() => { try { const parsed: unknown = JSON.parse(text); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })()
    : text.split(';').map(part => {
        const [name, origin] = part.split('|');
        return { name: (name ?? '').trim(), origin: (origin ?? '').trim() };
      });
  const devices: Device[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const { name, origin } = candidate as { name?: unknown; origin?: unknown };
    if (typeof name !== 'string' || typeof origin !== 'string') continue;
    try { devices.push(validateDevice(name, origin)); } catch { /* 跳过非法项 */ }
  }
  return devices;
}

/** 合并导入项：按 origin 去重，保留原有顺序，新设备追加在后。 */
export function mergeDevices(current: Device[], incoming: Device[]): Device[] {
  const byOrigin = new Map<string, Device>();
  for (const device of [...current, ...incoming]) if (!byOrigin.has(device.origin)) byOrigin.set(device.origin, device);
  return [...byOrigin.values()];
}
