// 设备清单的读写。
//
// 设备清单以前只存在各浏览器的 localStorage 里，带来两个问题：在设置窗口里
// 加的设备网关不认（切换时静默回落到本机），改的名字别的浏览器也看不到。
// 现在以网关那份 service/data/devices.local.json 为准，接口就是下面三个。
//
// 网关不可用时（比如直接 vite preview 打开、没有网关），全部退回原来的
// localStorage 行为，界面不会因此不能用。

import type { Device } from './deviceRegistry';

export const DEVICE_API = '/api/pilotv/devices';

/**
 * ok=false 分两种，区别很重要：
 *   missing —— 这个网关压根没有设备管理接口，退回本地保存即可；
 *   rejected —— 网关在，但它拒绝了（比如地址不是内网），必须把原因告诉用户，
 *              悄悄存到本地只会让人以为改成功了，切过去才发现没生效。
 */
export type DeviceWriteResult =
  | { ok: true; devices: Device[] }
  | { ok: false; missing: boolean; error: string };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asDevices(value: unknown): Device[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Device => !!item && typeof item?.origin === 'string' && typeof item?.name === 'string')
    .map(item => ({ name: item.name, origin: item.origin }));
}

function describe(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === 'string' && body.error ? body.error : fallback;
}

async function write(method: string, path: string, payload?: Device): Promise<DeviceWriteResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch {
    return { ok: false, missing: true, error: '连不上网关' };
  }
  const body = await readJson(response);
  if (response.ok && Array.isArray(body.devices)) return { ok: true, devices: asDevices(body.devices) };
  // 404/405 说明这台网关没有管理接口，属于「没部署」而不是「不批准」。
  const missing = response.status === 404 || response.status === 405 || response.status === 501;
  return { ok: false, missing, error: describe(body, `服务端返回 ${response.status}`) };
}

/** 读取服务端清单。返回 null 表示这次没走服务端。 */
export async function fetchServerDevices(signal?: AbortSignal): Promise<{ devices: Device[]; writable: boolean } | null> {
  try {
    const response = await fetch(DEVICE_API, { cache: 'no-store', signal });
    if (!response.ok) return null;
    const body = await readJson(response);
    if (!Array.isArray(body.devices)) return null;
    return { devices: asDevices(body.devices), writable: body.writable !== false };
  } catch {
    return null;
  }
}

/** 新增或改名。origin 已存在就等于改名，所以这里只提供一个入口。 */
export function saveServerDevice(device: Device): Promise<DeviceWriteResult> {
  return write('POST', DEVICE_API, device);
}

export function deleteServerDevice(origin: string): Promise<DeviceWriteResult> {
  return write('DELETE', `${DEVICE_API}?origin=${encodeURIComponent(origin)}`);
}

/**
 * 把「改了哪台、改成什么」拆出来。
 * 设置窗口点保存时可能同时有新增、改名和删除，逐条发给服务端最省事，
 * 而且每条都能单独报出具体是哪台没成功。
 */
export function diffDeviceChanges(before: Device[], after: Device[]): { changed: Device[]; removed: string[] } {
  const beforeOrigins = new Set(before.map(device => device.origin));
  const afterOrigins = new Set(after.map(device => device.origin));
  return {
    changed: after.filter(device =>
      !beforeOrigins.has(device.origin) || before.find(item => item.origin === device.origin)?.name !== device.name),
    removed: [...beforeOrigins].filter(origin => !afterOrigins.has(origin)),
  };
}