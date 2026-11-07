// 极简 CDP 客户端：发方法、等回应、等事件，三件事。
//
// 为什么不引 playwright：这个 CLI 的约束是零运行时依赖（网关、supervisor、侧车都是），
// 而上游那个 playwright 是 devDependency 且不带浏览器二进制。自己写 CDP 反而没有
// 版本兼容包袱 —— Rodex 的 browser_check 也是同一个思路。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** 找一个能用的 Chromium 系浏览器。顺序：显式指定 → Edge → Chrome。 */
export function findBrowser(explicit = process.env.PILOTV_BROWSER) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    process.env.PILOTV_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const getJson = (url, timeoutMs = 2500) => new Promise((resolve, reject) => {
  const request = http.get(url, { timeout: timeoutMs }, (response) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  });
  request.on('error', reject);
  request.on('timeout', () => request.destroy(new Error('ETIMEDOUT')));
});

/** 端口上已经有浏览器在听就复用它；profile 是按端口分开的，共用会撞 SingletonLock。 */
async function existingDebuggerUrl(port) {
  try {
    const info = await getJson(`http://127.0.0.1:${port}/json/version`);
    return info.webSocketDebuggerUrl || null;
  } catch { return null; }
}

export async function launchBrowser({ port = 9333, headless = true } = {}) {
  const reused = await existingDebuggerUrl(port);
  if (reused) return { wsUrl: reused, owned: null, profileDir: null };

  const binary = findBrowser();
  if (!binary) {
    // 说清楚是「这台机器没浏览器」，不是「连不上」：两者的处理方式完全不同。
    throw Object.assign(new Error('NO_BROWSER'), {
      hint: '装一个 Edge/Chrome，或用 PILOTV_BROWSER 指向可执行文件',
    });
  }
  const profileDir = path.join(os.tmpdir(), `pilotv-verify-${port}`);
  fs.mkdirSync(profileDir, { recursive: true });
  // 只清自己这个端口的 profile 里的锁：走到这里说明该端口上没人在听，
  // 锁只可能是上次异常退出的残留（照抄 artifacts_cdp.py 的做法，它已验证）。
  for (const junk of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.rmSync(path.join(profileDir, junk), { force: true }); } catch { /* 没有就算了 */ }
  }
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    // 本机网关是自签证书：不忽略就什么都测不到，而忽略只影响这个临时 profile。
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--hide-scrollbars',
    '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1280,900',
  ];
  if (headless) args.unshift('--headless=new');
  const child = spawn(binary, args, { stdio: 'ignore', detached: false });
  const deadline = Date.now() + 20000; // 冷启动给足 20 秒，别赌机器快慢
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw Object.assign(new Error(`BROWSER_EXITED:${child.exitCode}`), {
        hint: `浏览器进程自己退了（${binary}）；常见原因是该 profile 被别的实例占着`,
      });
    }
    const wsUrl = await existingDebuggerUrl(port);
    if (wsUrl) return { wsUrl, owned: child, profileDir };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw Object.assign(new Error('BROWSER_TIMEOUT'), { hint: `调试端口 ${port} 20 秒内没起来` });
}

/** 一条 CDP 连接。target 级连接才能驱动页面。 */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    socket.addEventListener('message', (event) => this.onMessage(event));
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP_CONNECT_FAILED')), { once: true });
    });
    return new Cdp(socket);
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(Object.assign(new Error(message.error.message), { cdpCode: message.error.code }));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.eventHandlers.get(message.method) || []) handler(message.params);
    }
  }

  send(method, params = {}, { timeoutMs = 20000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP_TIMEOUT:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method).push(handler);
  }

  close() {
    try { this.socket.close(); } catch { /* 已经断了 */ }
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('CDP_CLOSED')); }
    this.pending.clear();
  }
}

/** 新建一个页面 target 并接上它。返回的 cdp 直接就是页面级连接。 */
export async function openPage(port, url) {
  const info = await getJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 6000)
    .catch(() => null);
  // 新版 Chromium 要求 PUT 才能开新 tab；GET 拿不到就退回 Target.createTarget。
  if (info?.webSocketDebuggerUrl) {
    return { targetId: info.id, cdp: await Cdp.connect(info.webSocketDebuggerUrl) };
  }
  const browser = await Cdp.connect(await existingDebuggerUrl(port));
  const { targetId } = await browser.send('Target.createTarget', { url });
  browser.close();
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = list.find(entry => entry.id === targetId && entry.webSocketDebuggerUrl);
  if (!page) throw new Error('TARGET_NOT_FOUND');
  return { targetId, cdp: await Cdp.connect(page.webSocketDebuggerUrl) };
}

export async function closeBrowser({ owned, profileDir }) {
  if (owned && owned.exitCode === null) {
    // 只杀我们自己拉起来的那个进程。复用别人浏览器的场合绝不关它 ——
    // 那可能是用户正在用的窗口。
    try { owned.kill(); } catch { /* 已经退了 */ }
  }
  if (profileDir) {
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 临时目录留给系统清 */ }
  }
}
