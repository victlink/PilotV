// PilotV 服务端设备注册表。
//
// 背景：以前设备清单只有两处来源——随构建发布的 public/devices.json，和每台
// 浏览器各自的 localStorage。后果有三个：
//   1. 在悬浮窗里新增的设备，网关白名单不认，切换时会静默回落到本机；
//   2. 改名只存在浏览器本地，别人的浏览器看不到；
//   3. 清单是部署时决定的，没法在不重新构建的前提下增删。
//
// 这里把「用户可改的那部分」搬到网关自己的一份 JSON 里，前端新增/改名/隐藏都
// 写到这里。它是这些操作的唯一真相来源，前端只留一份缓存用于离线兜底。
//
// 安全边界：让浏览器能指定代理目标，本质上是开放代理。所以目标地址必须是
// 内网 IP 或 localhost、必须写明端口，且写操作要同源。这些限制挡住的是
// 「访问 169.254.169.254 拿云元数据」和「借网关打任意外网站点」。

import fs from 'node:fs';
import path from 'node:path';

const MAX_NAME_LENGTH = 64;

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.origin;
}

function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * 只放行内网地址。169.254.0.0/16 是 link-local，云厂商的元数据服务就在里面，
 * 必须显式排除——它是这类「浏览器指定代理目标」最经典的滥用目标。
 */
export function isPrivateHost(host) {
  const bare = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost') return true;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  // Tailscale 用的 100.64.0.0/10，和 192.168/10 同为 RFC1918/CGNAT 的内网段。
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;

  const octets = parseIPv4(bare);
  if (!octets) return false;
  if (octets[0] === 169 && octets[1] === 254) return false; // link-local / 元数据
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  if (octets[0] === 127) return true;
  return false;
}

/**
 * 校验一个可被代理的目标。返回 {ok, origin} 或 {ok:false, reason}，
 * reason 直接给用户看，所以写成人话。
 */
export function validateDeviceTarget(value) {
  const origin = normalizeOrigin(value);
  if (!origin) return { ok: false, reason: '地址格式不对，需要 http:// 开头的完整地址' };
  const url = new URL(origin);
  // 先查网段再查端口：URL 会把 80/443 这类默认端口抹掉，先查端口的话
  // 公网地址会先报「没写端口」，把更该说清楚的问题盖掉。
  if (!isPrivateHost(url.hostname)) {
    return { ok: false, reason: `${url.hostname} 不是内网地址，网关只代理内网里的 PilotDeck` };
  }
  if (!url.port) return { ok: false, reason: '要写明端口，例如 http://192.168.1.5:3001' };
  return { ok: true, origin };
}

export function normalizeDeviceName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { ok: false, reason: '设备名不能为空' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: `设备名最多 ${MAX_NAME_LENGTH} 个字符` };
  return { ok: true, name };
}

function emptyRegistry() {
  return { added: [], renamed: {}, hidden: [] };
}

/**
 * 改名记录只有挂在清单里真实存在的地址上才有意义。
 *
 * 早期版本把所有改名都写进 renamed，而 mergeRegistry 只会把 renamed 应用到
 * 预置设备上：给一个不在清单里的地址改名，记录写进去了，却永远不会被读到，
 * 而且没有任何提示。现在新增设备走 added、改预置设备走 renamed，这条分界才成立，
 * 但历史数据里仍留着这类死条目（比如 devices.json 里端口从 3001 改成 3002 之前
 * 留下的那条）。保存时清掉，免得以后有人把那个地址加回来时冒出一个早就改废的名字。
 */
export function pruneDeadRenames(registry, baseDevices) {
  const known = new Set((baseDevices || []).map(device => device.origin));
  for (const entry of registry.added || []) known.add(entry.origin);
  const renamed = {};
  for (const [origin, name] of Object.entries(registry.renamed || {})) {
    if (known.has(origin)) renamed[origin] = name;
  }
  return renamed;
}

/** 读注册表。文件不存在或损坏都当作空，不让一次手滑把整份清单废掉。 */
export function readRegistryFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const added = [];
    for (const item of Array.isArray(parsed?.added) ? parsed.added : []) {
      const target = validateDeviceTarget(item?.origin);
      const label = normalizeDeviceName(item?.name);
      if (target.ok && label.ok && !added.some(entry => entry.origin === target.origin)) {
        added.push({ name: label.name, origin: target.origin });
      }
    }
    const renamed = {};
    for (const [origin, name] of Object.entries(parsed?.renamed || {})) {
      const target = normalizeOrigin(origin);
      const label = normalizeDeviceName(name);
      if (target && label.ok) renamed[target] = label.name;
    }
    const hidden = [];
    for (const origin of Array.isArray(parsed?.hidden) ? parsed.hidden : []) {
      const target = normalizeOrigin(origin);
      if (target && !hidden.includes(target)) hidden.push(target);
    }
    return { added, renamed, hidden };
  } catch {
    return emptyRegistry();
  }
}

export function writeRegistryFile(file, registry) {
  const body = {
    added: registry.added || [],
    renamed: registry.renamed || {},
    hidden: registry.hidden || [],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先写临时文件再改名：中途断电不会留下半个文件。
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
  fs.renameSync(temporary, file);
  return body;
}

/**
 * 把「随构建发布的清单」和「用户改过的部分」合成最终设备列表。
 * 用户改过的部分优先，但隐藏项要真的消失，而不是换个名字继续出现。
 */
export function mergeRegistry(baseDevices, registry) {
  const hidden = new Set(registry.hidden || []);
  const renamed = registry.renamed || {};
  const devices = [];
  for (const device of baseDevices) {
    if (hidden.has(device.origin)) continue;
    devices.push({ ...device, name: renamed[device.origin] || device.name });
  }
  for (const entry of registry.added || []) {
    if (hidden.has(entry.origin)) continue;
    const existing = devices.find(device => device.origin === entry.origin);
    if (existing) { existing.name = entry.name; continue; }
    devices.push({ name: entry.name, origin: entry.origin, backend: entry.origin });
  }
  return devices;
}

/**
 * 注册表的内存缓存。文件很小，但 API 请求很密，每次 stat 都嫌浪费，
 * 所以最多一秒检查一次 mtime。
 */
export class DeviceRegistry {
  constructor(file, baseDevices) {
    this.file = file;
    this.baseDevices = baseDevices;
    this.cache = null;
    this.checkedAt = 0;
  }

  read() {
    const now = Date.now();
    if (this.cache && now - this.checkedAt < 1000) return this.cache;
    this.checkedAt = now;
    this.cache = readRegistryFile(this.file);
    return this.cache;
  }

  devices() {
    return mergeRegistry(this.baseDevices, this.read());
  }

  save(next) {
    const body = writeRegistryFile(this.file, { ...next, renamed: pruneDeadRenames(next, this.baseDevices) });
    this.cache = readRegistryFile(this.file);
    this.checkedAt = Date.now();
    return body;
  }

  /** 浏览器删掉一台设备时，要能确定它原本叫什么，否则清单里会留个残影。 */
  displayName(origin) {
    return this.devices().find(device => device.origin === origin)?.name || origin;
  }
}

/**
 * 同源校验。带 Origin 的跨站请求直接拒掉——浏览器发起的写操作都会带 Origin，
 * 所以这一条就足以挡住别的网站拿这个网关当跳板。没有 Origin 的是 curl 之类，
 * 放行，让部署侧仍然可以直接改。
 */
export function isSameOrigin(request, config) {
  const origin = request.headers?.origin;
  if (!origin) return true;
  const host = request.headers?.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}