// 设备清单的单一来源与同步。
//
// 之前的形状（HANDOFF-Windows §3.5 + 计划 P1.6）：
//   - ui/public/devices.json 是**网关**读的（决定允许转发到哪些后端）；
//   - ui/dist/devices.json 是**浏览器**读的（设备切换器的预置列表，
//     网关按 distDir 提供静态文件，所以前端拿到的永远是 dist 那份）；
//   - 两份都得手工改、手工拷。漏一次的结果不是报错，而是「网关不认识这台设备」，
//     于是 ?d= 被静默忽略、页面回落到本机 —— 用户看到的是「切不过去」，
//     排障的人看到的是「前端没问题啊」。verify_windows.ps1 第 4 节已经在比对
//     两份的 SHA256，但同样没有任何东西自动跑它。
//
// 现在：public/ 是唯一的真相来源，网关启动时把它同步到 dist/。
// 同步失败要么如实报错，要么原样保留上一份可用清单 —— 绝不静默改成第三态。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 模板占位符。带着它上线就等于把「还没配」伪装成「配好了」。 */
const PLACEHOLDER = /REPLACE_[A-Z_]+/;

/**
 * 解析并校验设备清单文本。返回 { devices, problems }。
 *
 * 这里刻意区分三种失败：JSON 语法错、结构不对、带占位符。
 * 之前 readDevices 对这三种都「跳过坏条目」，于是配置写错和没配置长得一样。
 */
export function parseDeviceManifest(text, options = {}) {
  const problems = [];
  const source = options.source || '(内存文本)';
  if (typeof text !== 'string' || !text.trim()) {
    return { devices: [], problems: [`${source}: 内容为空`] };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { devices: [], problems: [`${source}: JSON 语法错误 - ${error.message}`] };
  }
  const list = Array.isArray(payload) ? payload : payload?.devices;
  if (!Array.isArray(list)) {
    return { devices: [], problems: [`${source}: 既不是数组也没有 devices 字段`] };
  }
  if (Array.isArray(payload?._comment ?? undefined)) {
    problems.push(`${source}: _comment 应为字符串`);
  }

  const devices = [];
  const seen = new Set();
  list.forEach((item, index) => {
    const label = `${source} devices[${index}]`;
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const rawOrigin = typeof item?.origin === 'string' ? item.origin.trim()
      : typeof item?.url === 'string' ? item.url.trim() : '';
    if (!name || !rawOrigin) {
      problems.push(`${label}: 缺少 name 或 origin`);
      return;
    }
    let url;
    try {
      url = new URL(rawOrigin);
    } catch {
      problems.push(`${label}: origin 不是合法 URL - ${rawOrigin}`);
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`${label}: 协议必须是 http/https - ${url.protocol}`);
      return;
    }
    if (PLACEHOLDER.test(name) || PLACEHOLDER.test(rawOrigin)) {
      problems.push(`${label}: 仍是模板占位符，需要填真实地址 - ${rawOrigin}`);
      return;
    }
    const origin = url.origin;
    if (seen.has(origin)) {
      problems.push(`${label}: origin 重复 - ${origin}`);
      return;
    }
    seen.add(origin);
    const device = { name, origin, backend: origin };
    const port = Number(item?.artifactsPort);
    if (Number.isInteger(port) && port > 0 && port <= 65535) device.artifactsPort = port;
    else if (item?.artifactsPort !== undefined) {
      problems.push(`${label}: artifactsPort 不是有效端口 - ${item.artifactsPort}`);
    }
    devices.push(device);
  });

  if (devices.length === 0 && problems.length === 0) {
    problems.push(`${source}: 清单是空的`);
  }
  return { devices, problems };
}

/** 读文件并解析。读不到 = 明确的问题清单，不是空清单。 */
export function readDeviceManifest(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return { devices: [], problems: [`${file}: 读不到 - ${error.code || error.message}`] };
  }
  return parseDeviceManifest(text, { source: file });
}

/**
 * 把真相来源同步到 dist/。只在内容真的不同时写，写的是规范化后的 JSON。
 *
 * 原子写（临时文件 + rename）：前端随时可能在读这份文件，
 * 半个 JSON 落盘会让设备切换器整个消失，而那看起来像「前端 bug」。
 */
export async function syncDeviceManifest(sourceFile, targetFile) {
  const parsed = readDeviceManifest(sourceFile);
  if (parsed.problems.length > 0) {
    return { synced: false, reason: 'source-invalid', problems: parsed.problems, devices: parsed.devices };
  }
  const payload = JSON.stringify({
    devices: parsed.devices.map(device => ({
      name: device.name,
      origin: device.origin,
      ...(device.artifactsPort ? { artifactsPort: device.artifactsPort } : {}),
    })),
  }, null, 2) + '\n';

  let current = null;
  try {
    current = await fsp.readFile(targetFile, 'utf-8');
  } catch { /* dist 还没构建出来，正常情况 */ }
  if (current !== null && normalizeJsonForCompare(current) === normalizeJsonForCompare(payload)) {
    return { synced: false, reason: 'already-in-sync', devices: parsed.devices };
  }

  try {
    await fsp.mkdir(path.dirname(targetFile), { recursive: true });
    const temp = `${targetFile}.tmp-${process.pid}`;
    await fsp.writeFile(temp, payload);
    await fsp.rename(temp, targetFile);
    return { synced: true, devices: parsed.devices, from: sourceFile, to: targetFile };
  } catch (error) {
    return { synced: false, reason: `write-failed:${error.code || error.message}`, devices: parsed.devices };
  }
}

function normalizeJsonForCompare(text) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    // 目标文件是坏 JSON：视为「不同」，让同步把它覆盖掉。这正是我们要修的坏状态。
    return `\u0000corrupt\u0000${text}`;
  }
}

/**
 * 用户在 ?d= 里点了网关不认识的地址时该怎么办。
 *
 * 老行为是静默回落到本机，代价是把「配置漂移」变成了「切不过去但没原因」。
 * 这里的原则：
 *   - 显式意图（?d= 导航、显式的设备头）要如实报错，绝不假装成功；
 *   - 但绝不能因此变成开放代理 —— 未知地址一律不转发，这是安全边界，
 *     报错的方式也不能把用户带来的地址原样回显成可执行内容。
 *
 * @returns {{ mode: "resolve"|"error", origin?: string, problem?: string, known?: string[] }}
 */
export function decideUnknownDevice(rawParam, devices, options = {}) {
  const known = (devices || []).map(device => device.origin);
  if (options.source !== 'query') {
    // 头/Cookie 里的陌生地址：多半是设备改名或下线后残留的旧选择。
    // 回落到本机是对的（否则人会被自己的 Cookie 锁死），但必须带着原因回落。
    return { mode: 'resolve', origin: options.defaultOrigin, problem: rawParam ? `stale-selection:${rawParam}` : undefined, known };
  }
  return {
    mode: 'error',
    problem: `清单里没有这台设备：${rawParam || '(空)'}。当前可用：${known.join(', ') || '(空清单)'}`,
    known,
  };
}
/**
 * 同步的同步版本，给网关启动路径用（loadConfigFromEnv 本身是同步的）。
 *
 * 默认不在 dist 目录不存在时创建它：dist 是构建产物，网关没资格替 vite 决定
 * 「现在该有一个 dist 了」。真没构建出来就如实报告，让 doctor/启动器去说这件事。
 */
export function syncDeviceManifestSync(sourceFile, targetFile, options = {}) {
  const parsed = readDeviceManifest(sourceFile);
  if (parsed.problems.length > 0) {
    return { synced: false, reason: 'source-invalid', problems: parsed.problems, devices: parsed.devices };
  }
  const payload = JSON.stringify({
    devices: parsed.devices.map(device => ({
      name: device.name,
      origin: device.origin,
      ...(device.artifactsPort ? { artifactsPort: device.artifactsPort } : {}),
    })),
  }, null, 2) + '\n';

  const targetDir = path.dirname(targetFile);
  let targetDirExists = true;
  try {
    targetDirExists = fs.statSync(targetDir).isDirectory();
  } catch { targetDirExists = false; }
  if (!targetDirExists && !options.createTargetDir) {
    return { synced: false, reason: 'dist-missing', devices: parsed.devices, problems: [] };
  }

  let current = null;
  try {
    current = fs.readFileSync(targetFile, 'utf-8');
  } catch { /* 还没同步过 */ }
  if (current !== null && normalizeJsonForCompare(current) === normalizeJsonForCompare(payload)) {
    return { synced: false, reason: 'already-in-sync', devices: parsed.devices, problems: [] };
  }

  try {
    if (options.createTargetDir) fs.mkdirSync(targetDir, { recursive: true });
    const temp = `${targetFile}.tmp-${process.pid}`;
    fs.writeFileSync(temp, payload);
    fs.renameSync(temp, targetFile);
    return { synced: true, devices: parsed.devices, from: sourceFile, to: targetFile, problems: [] };
  } catch (error) {
    return { synced: false, reason: `write-failed:${error.code || error.message}`, devices: parsed.devices, problems: [] };
  }
}