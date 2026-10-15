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

/** 重命名：只改显示名称，地址不变。名称为空或过长时抛出，不产生半成品列表。 */
export function renameDevice(devices: Device[], origin: string, name: string): Device[] {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw Error('设备名称需为 1–80 个字符');
  return devices.map(device => (device.origin === origin ? { ...device, name: trimmed } : device));
}

/** 部署侧预置设备：随构建一起发布的 devices.json。
 *  作用是「换台机器打开也能看到同一批设备」，不再依赖每台浏览器手工录入。 */
/** 必须是站点根路径：写成相对路径的话，停在 /p/xxx 这类深链上会去请求 /p/devices.json。 */
export const DEVICE_DEFAULTS_URL = '/devices.json';
export const DEVICE_HIDDEN_KEY = 'pilotdeck-device-directory-hidden-v1';

export function decodeDeviceDefaults(raw: unknown): Device[] {
  const list = Array.isArray(raw) ? raw : (raw as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) return [];
  const devices: Device[] = [];
  for (const value of list) {
    if (!value || typeof value !== 'object') continue;
    const { name, origin } = value as { name?: unknown; origin?: unknown };
    if (typeof name !== 'string' || typeof origin !== 'string') continue;
    try { devices.push(validateDevice(name, origin)); } catch { /* 跳过非法项 */ }
  }
  return devices;
}

/** 本机已删除的预置设备 origin，避免每次加载又冒出来。 */
export function decodeHiddenOrigins(raw: string | null): string[] {
  try {
    const list: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((value): value is string => typeof value === 'string' && value.startsWith('http'));
  } catch { return []; }
}

/** 合并规则：预置设备在前（保证各机器看到同一顺序），本机新增的追加在后；
 *  同 origin 只留一个，但**名称以本机为准**——用户改过的名字不会被
 *  devices.json 的原始名称覆盖；hidden 里的预置设备不显示。 */
export function mergeDeviceDefaults(stored: Device[], defaults: Device[], hidden: string[] = []): Device[] {
  const blocked = new Set(hidden);
  const storedByOrigin = new Map(stored.map(device => [device.origin, device]));
  const merged: Device[] = [];
  const seen = new Set<string>();
  for (const preset of defaults) {
    if (blocked.has(preset.origin) || seen.has(preset.origin)) continue;
    seen.add(preset.origin);
    merged.push(storedByOrigin.get(preset.origin) ?? preset);
  }
  for (const device of stored) {
    if (seen.has(device.origin)) continue;
    seen.add(device.origin);
    merged.push(device);
  }
  return merged;
}
