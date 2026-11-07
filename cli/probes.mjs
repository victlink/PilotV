// doctor 的采集层：只读。它绝不重启、绝不杀进程、绝不改配置 ——
// 一个「自检」工具把自己检查的服务弄坏，是最糟糕的失败方式。

import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

/** 一次 TCP 连接能不能建立。带超时，绝不无限等。 */
export function probeTcp({ host, port, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.once('error', (error) => done(false, error));
  });
}

/** HTTP(S) GET，返回状态码 + 解析后的 JSON + 原始错误。自签证书按本机信任处理。 */
export function probeHttp(url, { timeoutMs = 6000, headers = {} } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      resolve({ ok: false, error: Object.assign(error, { code: 'BAD_URL' }) });
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const request = client.get(target, {
      timeout: timeoutMs,
      rejectUnauthorized: false, // 本机自签证书：doctor 要能读出状态，不能被握手挡在门外
      headers,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* 非 JSON 也照常回报状态码 */ }
        resolve({ ok: (response.statusCode || 0) > 0, status: response.statusCode || 0, body, headers: response.headers, text });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => resolve({ ok: false, error }));
  });
}

const run = (command, args, timeoutMs = 8000) => new Promise((resolve) => {
  execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout) => resolve(error ? '' : stdout));
});

/**
 * 「谁在听这个端口」——按端口反查，不读 pids.json。
 *
 * pids.json 记录的是「我以为我起了什么」；进程被 kill -9、被 supervisor 换过、
 * 或者换了机器之后它就永远是错的，而据此做的判断看起来完全正常。
 * 拿不到 owner 不报错：那是锦上添花，端口通不通才是硬事实。
 */
export async function listListeners(ports) {
  const found = [];
  if (process.platform === 'win32') {
    const out = await run('netstat.exe', ['-ano', '-p', 'TCP']);
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (match) found.push({ port: Number(match[1]), pid: Number(match[2]), command: '' });
    }
  } else {
    const out = (await run('ss', ['-ltnp'])) || (await run('netstat', ['-ltnp']));
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/:(\d+)\s.*pid=(\d+)/);
      if (match) found.push({ port: Number(match[1]), pid: Number(match[2]), command: '' });
    }
  }
  const wanted = new Set(ports);
  const unique = new Map();
  for (const entry of found) {
    if (!wanted.has(entry.port)) continue;
    if (entry.pid <= 0) continue;
    const key = `${entry.port}:${entry.pid}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  const list = [...unique.values()];
  for (const entry of list) {
    entry.command = await commandFor(entry.pid);
  }
  return list;
}

const COMMANDS = new Map();
async function commandFor(pid) {
  if (COMMANDS.has(pid)) return COMMANDS.get(pid);
  let command = '';
  if (process.platform === 'win32') {
    const out = await run('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    command = (out.match(/^"([^"]+)"/) || [])[1] || '';
  } else {
    const out = await run('ps', ['-p', String(pid), '-o', 'comm=']);
    command = out.trim();
  }
  COMMANDS.set(pid, command);
  return command;
}

/** 证书剩余天数。用 node:crypto 读，不依赖 openssl（本机就没装）。 */
export function certExpiry(file) {
  try {
    const pem = fs.readFileSync(file, 'utf8');
    const der = pemToDer(pem);
    if (!der) return { daysRemaining: null, notBeforeDays: null, error: 'no-pem-block' };
    const cert = new X509Certificate(der);
    const now = Date.now();
    return {
      daysRemaining: Math.floor((Date.parse(cert.validTo) - now) / 86400000),
      notBeforeDays: Math.floor((now - Date.parse(cert.validFrom)) / 86400000) / 1,
      subject: cert.subject,
    };
  } catch (error) {
    // 区分「没有这个文件」和「有文件但读不出有效期」：前者是正常的
    // （还没启用 TLS），后者说明格式变了，值得说一句。
    return { daysRemaining: null, notBeforeDays: null, error: error.code || error.message };
  }
}

function pemToDer(pem) {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  return match ? Buffer.from(match[1].replace(/\s+/g, ''), 'base64') : null;
}

/** 日志体积。目录里所有 .log 都要看：1.82 GB 那次恰恰不是被盯着的那个文件。 */
export function logSizes(dir, { limit = 40 } = {}) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在交给上层判定，这里不猜
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.log(\.prev)?$/.test(entry.name)) continue;
    try {
      out.push({ name: entry.name, bytes: fs.statSync(path.join(dir, entry.name)).size });
    } catch (error) {
      // 不静默丢：吞掉的采集错误会让「一切正常」变成假话（我自己写的
      // docs/DEGRADATION.md 第 4 节就是这个）。数不出来就报数不出来。
      out.push({ name: entry.name, bytes: null, error: error.code || error.message });
    }
    if (out.length >= limit) break;
  }
  // 读不出体积的排到最前：它们是需要人看的东西，不是「反正不超标」
  return out.sort((a, b) => (b.bytes ?? Infinity) - (a.bytes ?? Infinity));
}

/**
 * 只读地比较两份 devices.json，返回和 syncDeviceManifestSync 同一种结论形状。
 *
 * doctor 是自检，不是部署工具：它绝不能为了「让检查通过」去写盘。写这件事
 * 属于网关启动流程，或者属于明确带 --fix 的人工操作。
 */
export function compareManifestPair(sourceFile, targetFile) {
  let source;
  try {
    source = fs.readFileSync(sourceFile, 'utf8');
  } catch (error) {
    return { synced: false, reason: `source-unreadable:${error.code || error.message}` };
  }
  let target = null;
  try {
    target = fs.readFileSync(targetFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { synced: false, reason: 'dist-missing' };
    return { synced: false, reason: `target-unreadable:${error.code || error.message}` };
  }
  const same = normaliseForCompare(source) === normaliseForCompare(target);
  return { synced: false, reason: same ? 'already-in-sync' : 'out-of-sync' };
}

function normaliseForCompare(text) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return `\u0000corrupt\u0000${text}`;
  }
}
