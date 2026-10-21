// PilotV 网关：把「同一个前端」接到任意一台 PilotDeck 后端。
//
// 为什么需要它：官方前端的 REST 与 WebSocket 全部走同源相对路径
// （/api、/ws、/shell、/memory-dashboard），所以只要把这些前缀转发到
// 目标机器，浏览器里看到的仍然是 PilotV 自己的页面，数据却来自那台机器。
// 设备切换只改一个 Cookie，不需要重新构建或重新部署前端。
//
// 允许转发的目标仅来自 devices.json 与环境变量，浏览器无法自带任意地址，
// 因此这不是一个开放代理。

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DeviceRegistry,
  isSameOrigin,
  normalizeDeviceName,
  validateDeviceTarget,
} from './device_registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

export const DEVICE_COOKIE = 'pdv_backend';
/**
 * 逐请求指定设备。Cookie 是整个浏览器共享的，两个标签页各连一台设备时必然打架；
 * 前端给每个请求都带上这个头，就能在不动 Cookie 的前提下把各标签页分开。
 */
export const DEVICE_HEADER = 'x-pilotv-device';

/** 只允许 http/https 的 origin，去掉路径、凭据和尾斜杠；不合法返回 null。 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.origin;
}

/** 把 name 变成 URL 友好的短标识：marc-linux-pc → marc-linux-pc。 */
export function slugify(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * 解析 ?d=。同时接受完整 origin 和 devices.json 里的设备短标识，
 * 两种写法都只在已知设备清单内解析，解析不出来就交给默认后端。
 */
export function resolveDeviceParam(raw, devices) {
  if (!raw) return { origin: null, reason: null };
  const direct = normalizeOrigin(raw);
  if (direct) {
    const known = devices.find(device => device.origin === direct);
    return known ? { origin: direct, device: known } : { origin: null, reason: 'unknown' };
  }
  const slug = slugify(raw);
  const bySlug = devices.find(device => slugify(device.name) === slug);
  return bySlug ? { origin: bySlug.origin, device: bySlug } : { origin: null, reason: 'unknown' };
}

/** 读 Cookie，只取我们那一个。 */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return readCookieValue(part.slice(index + 1).trim());
  }
  return null;
}

/**
 * Cookie 值可能带百分号转义。畸形转义（单独的 '%'、截断的 %E4）会让
 * decodeURIComponent 抛 URIError，而这个函数在 resolveBackend 的调用链上，
 * 一抛就把整个请求处理带崩。解不开就当这个 Cookie 没设。
 */
function readCookieValue(raw) {
  if (!raw) return raw;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// ── 设备写操作的会话鉴权 ───────────────────────────────────────────────
//
// 设备写接口会把新地址加进网关的转发白名单，所以它是这套网关里权限最大的
// 入口。以前只有一道 Origin 检查，而没有 Origin 头的请求（curl、脚本）会
// 直接放行 —— 等于任何能连到网关的客户端都能改清单。
//
// 现在写操作要过两关：
//   1) PILOTV_ALLOW_DEVICE_WRITES=1 显式打开（默认关闭）；
//   2) 带上有效的 pdv_admin 会话 Cookie，或等值的 Bearer 令牌。
// 浏览器打开首页时网关会种下这个 Cookie，所以正常界面照常能用；而一个
// 裸 curl 既没有 Cookie、也过不了同源检查。

export const ADMIN_COOKIE = 'pdv_admin';

/** 没配 PILOTV_ADMIN_TOKEN 就在清单旁边生成一个随机密钥，重启后仍然有效。 */
export function readOrCreateAdminSecret(registryFile) {
  const secretFile = `${registryFile}.secret`;
  try {
    const existing = fs.readFileSync(secretFile, 'utf-8').trim();
    if (existing) return existing;
  } catch { /* 没有就现生成一个 */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  } catch { /* 落盘失败就用内存里的这份，本进程内照样自洽 */ }
  return secret;
}

function signAdminCookie(secret) {
  return crypto.createHmac('sha256', secret).update('pilotv-admin-session-v1').digest('hex');
}

/** 导出来给测试用：测试要拿同一条签名去模拟合法会话。 */
export const adminTokenFor = signAdminCookie;

/** 定长比较，避免按字节试探出签名。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf-8');
  const right = Buffer.from(String(b ?? ''), 'utf-8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/**
 * 调用方有没有设备写权限。两条路：管理员令牌（给脚本用），或者网关自己在
 * 首页种下的会话 Cookie（给浏览器界面用）。
 */
export function verifyAdmin(request, config) {
  if (!config?.adminSecret) return false;
  const auth = request.headers?.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ') && safeEqual(auth.slice(7).trim(), signAdminCookie(config.adminSecret))) {
    return true;
  }
  return safeEqual(readCookie(request.headers?.cookie, ADMIN_COOKIE), signAdminCookie(config.adminSecret));
}

/** 首页响应上挂会话 Cookie。同源页面才带得上，跨站脚本读不到也用不了。 */
export function adminCookieHeader(config) {
  if (!config?.adminSecret) return null;
  return `${ADMIN_COOKIE}=${signAdminCookie(config.adminSecret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
}

/**
 * 决定一个请求该转发到哪一类上游。
 * artifacts 必须排在 /api 前面：成果台自己的路由同样挂在 /api/artifacts 下面。
 */
export function classifyPath(pathname) {
  // 独立成果台页面已删除，只剩成果页要用的静态资源（vendor 三维渲染器、图标）和 API。
  if (pathname.startsWith('/artifacts-static/') || pathname.startsWith('/artifacts/')
    || pathname === '/api/artifacts' || pathname.startsWith('/api/artifacts/')) {
    return 'artifacts';
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'backend';
  if (pathname === '/memory-dashboard' || pathname.startsWith('/memory-dashboard/')) return 'backend';
  if (pathname === '/ws' || pathname === '/shell') return 'socket';
  return 'static';
}

/** 只有清单里的地址才允许被转发，浏览器无法自带任意目标。 */
export function buildAllowlist(devices, config) {
  const base = devices || config.devices;
  return new Set([...base.map(device => device.origin), config.defaultBackend]);
}

/**
 * 请求用哪个后端。
 *
 * 优先级：?d= → X-PilotV-Device 头 → Cookie → 默认本机。
 * 头排在 Cookie 前面，是为了让不同标签页各连各的：Cookie 是全浏览器共享的，
 * 任何一个标签页改设备都会影响其他标签页，而请求头是每个标签页自己的。
 * 未知值不报错也不回退到用户输入，而是安静地用默认后端。
 */
export function resolveBackend(request, config, devices) {
  const query = new URL(request.url, 'http://pilotv.local').searchParams;
  const fromQuery = resolveDeviceParam(query.get('d'), devices || config.devices);
  if (fromQuery.origin) return { origin: fromQuery.origin, device: fromQuery.device, source: 'query' };

  const allowlist = buildAllowlist(devices, config);
  const rawHeader = request.headers?.[DEVICE_HEADER];
  const fromHeader = normalizeOrigin(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader || '');
  if (fromHeader && allowlist.has(fromHeader)) {
    const device = (devices || config.devices).find(item => item.origin === fromHeader) || null;
    return { origin: fromHeader, device, source: 'header' };
  }

  const fromCookie = normalizeOrigin(readCookie(request.headers?.cookie, DEVICE_COOKIE) || '');
  if (fromCookie && allowlist.has(fromCookie)) {
    const device = (devices || config.devices).find(item => item.origin === fromCookie) || null;
    return { origin: fromCookie, device, source: 'cookie' };
  }
  return {
    origin: config.defaultBackend,
    device: null,
    source: 'default',
    unknownDevice: fromQuery.reason === 'unknown',
  };
}

/**
 * 成果台上游：每台设备各跑一份独立成果台（默认 8799），本机则用本机那一份。
 *
 * 注意端口是「每台设备单独配的」，不是 PilotDeck 的 3001：实测各版本 PilotDeck
 * 都不带成果台（/artifacts/api 只是 SPA 回退页），成果台是我们自己部署的独立服务。
 * 设备没显式配置 artifactsPort 就说明它没部署，如实返回 null，让网关回 503，
 * ���不是把它甩到设备的 3001 上换一个来路不明的 404。
 */
export function resolveArtifactsOrigin(backendOrigin, config, devices) {
  if (!config.artifactsPerDevice || backendOrigin === config.defaultBackend) return config.artifactsTarget;
  const list = devices || config.devices || [];
  const device = list.find((item) => item.origin === backendOrigin);
  const port = Number(device && device.artifactsPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const url = new URL(backendOrigin);
    return `http://${url.hostname}:${port}`;
  } catch { return null; }
}

/**
 * 成果台 API 的路径在两种后端里不一样：
 *   - 独立成果台服务（8799）：/api/artifacts
 *   - PilotDeck 自带成果台：  /artifacts/api
 * 但实测新版本 PilotDeck 上并没有这个自带成果台——/artifacts/api 和随便乱写的路径
 * 返回完全一样（SPA 回退的 HTML），所以不能改写过去，那会把诚实的 404 变成
 * 一个内容类型错误的假 200。保持原样：远端设备没有成果台就如实报 404。
 */

/** 把 index.html 注入运行时信息，前端据此知道自己在跟哪台设备说话。 */
export function injectRuntime(html, runtime) {
  const payload = JSON.stringify(runtime).replace(/</g, '\\u003c');
  const tag = `<script>window.__PILOTV__=${payload};</script>`;
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  return tag + html;
}

/**
 * 「资料」页 iframe 要用的 WeKnora 地址。
 *
 * 优先用 PILOTV_WEKNORA_URL 固定；否则按「打开 PilotV 的这台机器 + WeKnora 的端口」
 * 拼出来——用户是通过局域网 IP 还是 tailscale 打开前端，iframe 就跟着走同一个主机，
 * 不会出现「前端能开、WeKnora 打不开」的分裂。
 */
export function resolveWeknoraUrl(request, config) {
  const fixed = normalizeOrigin(config.weknoraUrl || '');
  if (fixed) return fixed;
  const port = Number(config.weknoraPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const host = String(request?.headers?.host || '').trim();
  if (!host) return null;
  // 去掉 PilotV 自己的端口，保留 IPv6 的方括号写法。
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  if (!hostname) return null;
  const proto = request?.headers?.['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${hostname}:${port}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.pdf': 'application/pdf', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};

export function readDevices(jsonText, fallbackOrigin) {
  let payload;
  try { payload = JSON.parse(jsonText); } catch { payload = null; }
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.devices) ? payload.devices : [];
  const devices = [];
  for (const item of list) {
    const origin = normalizeOrigin(item?.origin ?? item?.url);
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : '';
    if (!origin || !name) continue;
    if (devices.some(device => device.origin === origin)) continue;
    // artifactsPort 要一起带出来：成果台跑在它自己部署的端口上，不是 PilotDeck 的端口。
    // 这里漏掉它，后面 resolveArtifactsOrigin 就会把每台远端设备都判成「没部署成果台」。
    const port = Number(item?.artifactsPort);
    const device = { name, origin, backend: origin };
    if (Number.isInteger(port) && port > 0 && port <= 65535) device.artifactsPort = port;
    devices.push(device);
  }
  // 部署 PilotV 的这台机器本身也是一台设备：成果台在它上面跑。
  if (fallbackOrigin && !devices.some(device => device.origin === fallbackOrigin)) {
    devices.unshift({ name: '当前设备', origin: fallbackOrigin, backend: fallbackOrigin });
  }
  return devices;
}

function resolveStaticFile(distDir, pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  const relative = clean.replace(/^\/+/, '');
  const target = path.resolve(distDir, relative);
  // 目录穿越保护：解析后必须仍在 dist 里面。
  if (target !== distDir && !target.startsWith(distDir + path.sep)) return null;
  return target;
}

function sendFile(res, filePath, extraHeaders) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
  stream.on('open', () => {
    res.writeHead(200, { 'content-type': type, 'cache-control': filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache', ...extraHeaders });
  });
  stream.pipe(res);
}

/**
 * 长连接隧道（/ws、/shell）的空闲上限。
 *
 * /ws 通道的前端每 30 秒发一次 ping，服务端也会回 pong，所以一条健康的连接
 * 最多 30 秒就一定有一个字节流过。超过这个窗口还一个字节都没有的，
 * 只可能是已经死了：手机切后台换了网络之后，隧道会一直挂着没人回收，
 * Send-Q 越堆越大，两端却都以为对方还在 —— 用户看到的就是
 * 「整个 App 卡住，只能重启」。
 *
 * 取 150 秒（5 个 ping 周期）是为了留足余量：中间任何一跳（Tailscale、AP）
 * 抖动一下都不该被判死，但一条真死的连接五分钟内一定会被收走。
 */
const WS_TUNNEL_IDLE_MS = 150_000;

/**
 * 隧道「连不上」的上限。跟空闲超时是两回事：空闲超时管的是连上之后没数据，
 * 这里管的是握手阶段就卡住 —— 典型场景是手机休眠或 Tailscale 换路径，
 * SYN 发出去石沉大海，net.connect 既不报错也不回调。
 * 30 秒是 Tailscale 探测对端唤醒的常见量级，超过就基本可以判定连不上了。
 */
const WS_TUNNEL_CONNECT_TIMEOUT_MS = 30_000;

/**
 * /shell 隧道不设空闲上限。
 *
 * 终端通道是另一套协议：它的客户端（useShellConnection）压根没有心跳，
 * 用户开着一个终端想事情的时候可以几分钟不产生任何字节 —— 那是一条
 * 完全健康的连接，拿 /ws 的阈值去砍它就是把「正常终端」变成「终端莫名其妙断了」，
 * 而客户端又没有自动重连，只会更糟。
 *
 * 终端隧道的僵尸连接只占一个 fd，PTY 本来就有 30 分钟的回收机制兜着，
 * 留着这点资源不值得拿功能可用性去换。
 */

/**
 * 转发普通 HTTP 请求时，上游允许的最大静默时间。
 *
 * 上游挂住时前端的 fetch 会永远不 settle，连带 Service Worker 的
 * network-first 也永远不返回，页面就一直转圈。默认给到 10 分钟：
 * 一次长时间的思考/生成中间可以很久没有输出，不能因为这个把流式响应掐断，
 * 但真挂死的请求一定会在这个时间内拿到 504 而不是无限等待。
 */
const UPSTREAM_IDLE_MS = Number(process.env.PILOTV_UPSTREAM_IDLE_MS || 600_000);

function forward(request, response, targetOrigin, pathname, token, stripCallerAuth = false) {
  let target;
  try { target = new URL(targetOrigin); } catch { response.writeHead(502); response.end('bad upstream'); return; }
  const headers = { ...request.headers, host: target.host };
  // Host 改写成上游之后，后端就不知道用户是从哪个入口来的。成果台要把评审链接
  // 指回 PilotV 前端，只能靠这两个头。客户端自带的要覆盖掉，不能让人伪造公网地址。
  headers['x-forwarded-host'] = request.headers.host || request.socket.localAddress;
  headers['x-forwarded-proto'] = 'http';
  // 这个头是网关自己的路由标记，后端不需要也不该看到。
  delete headers[DEVICE_HEADER];
  // 远端成果台用令牌鉴权。浏览器带的 Authorization 要换成网关自己持有的那个，
  // 否则既过不去，也等于把令牌当成前端可控的输入。
  if (token) headers.authorization = `Bearer ${token}`;
  if (stripCallerAuth) {
    // 网关没配 artifactsToken 时，上一行 if 不成立，调用方自带的凭据就会原样
    // 被送到成果台 —— 那是个跨源凭据外泄面（浏览器的会话 cookie、Bearer 令牌
    // 都会跟着进去）。所以成果台这一段无条件先摘掉调用方凭据：有网关令牌就
    // 换成网关的，没有就光秃秃过去让上游自己拒。
    delete headers.authorization;
    delete headers['x-artifacts-token'];
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const upstream = http.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: request.method,
    path: pathname,
    headers,
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  // 上游静默超过上限就掐掉，给前端一个明确的 504，而不是让它无限期转圈。
  // 用的是「静默」而不是「总时长」：流式响应中间可以长时间没有输出。
  upstream.setTimeout(UPSTREAM_IDLE_MS, () => {
    if (!response.headersSent) {
      response.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end(`上游 ${target.host} 超过 ${Math.round(UPSTREAM_IDLE_MS / 1000)} 秒没有任何响应`);
    upstream.destroy();
  });
  upstream.on('error', error => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`上游 ${target.host} 无响应：${error.code || error.message}`);
  });
  request.pipe(upstream);
}

function pipeSocket(request, socket, head, targetOrigin, idleMs = WS_TUNNEL_IDLE_MS) {
  let target;
  try { target = new URL(targetOrigin); } catch { socket.destroy(); return; }
  const upstream = net.connect(Number(target.port || (target.protocol === 'https:' ? 443 : 80)), target.hostname);
  const drop = () => { upstream.destroy(); socket.destroy(); };
  // 连不上就一定要有上限。隧道对端常常是手机：手机休眠、Wi-Fi 切蜂窝、
  // Tailscale 换路径时，SYN 会石沉大海（内核一直重试，net.connect 不报错也不回调），
  // 这条隧道就既不建立也不失败，客户端那边看起来就是「连上了但没反应」。
  // 到点直接拆掉，让客户端重连，而不是留一条永远悬着的隧道。
  const connectTimer = setTimeout(drop, WS_TUNNEL_CONNECT_TIMEOUT_MS);
  upstream.on('connect', () => {
    clearTimeout(connectTimer);
    const headers = [`GET ${request.url} HTTP/1.1`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      if (name.toLowerCase() === 'host') continue;
      if (name.toLowerCase() === DEVICE_HEADER) continue;
      headers.push(`${name}: ${request.rawHeaders[index + 1]}`);
    }
    headers.push(`Host: ${target.host}`, '', '');
    upstream.write(headers.join('\r\n'));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);

    // 空闲回收。判「客户端还活着」只看客户端→网关这一个方向：
    // 浏览器每 30 秒发一个 ping，30 秒一个来回，150 秒收不到任何客户端字节
    // 就说明这条路径已经断了（手机切后台换网络、Wi-Fi 切蜂窝、Tailscale 换路径）。
    //
    // 反过来，后端→网关这个方向绝对不能拿来判活：故障现场正是后端在往一个
    // 没人读的 socket 里猛推数据（Send-Q 堆到 2.4MB 且不下降），
    // 拿它当活性信号，死隧道就永远等不到超时，只会被越撑越大。
    if (idleMs > 0) {
      let idleTimer = setTimeout(drop, idleMs);
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(drop, idleMs);
      };
      socket.on('data', touch);
      socket.on('close', () => clearTimeout(idleTimer));
    }
  });
  upstream.on('error', () => { clearTimeout(connectTimer); if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); else socket.destroy(); });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.end());
}

const PILOTV_API_PREFIX = '/api/pilotv/';

function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体太大')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    request.on('error', reject);
  });
}

/**
 * 网关自己的设备管理接口。这一段永远不转发给 PilotDeck 后端。
 *
 * 这是「在悬浮窗里加一台设备就能切过去」和「换个浏览器还能看到别人改过的名字」
 * 两件事的落点：用户改的清单存服务端，网关每次请求都重新读，
 * 所以新增的设备立刻出现在允许列表里。
 */
function handleRegistryApi(request, response, url, config, registry) {
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const writable = config.allowRegistryWrites;

  if (request.method === 'GET') {
    const device = config.defaultBackend;
    return send(200, {
      devices: registry.devices(),
      defaultBackend: device,
      defaultName: registry.displayName(device),
      writable,
    });
  }

  // 写操作是这套网关里权限最大的入口：能把新地址加进转发白名单。
  // 三道闸依次过 —— 服务端开关、会话 Cookie/令牌、同源。
  if (!writable) return send(403, { error: '服务端已关闭设备写操作，设置 PILOTV_ALLOW_DEVICE_WRITES=1 可打开' });
  if (!verifyAdmin(request, config)) return send(401, { error: '设备写操作需要有效会话（请从 PilotV 页面进入）或管理员令牌' });
  if (!isSameOrigin(request, config)) return send(403, { error: '只能从 PilotV 页面本身提交' });

  if (request.method === 'POST' || request.method === 'PUT') {
    return readJsonBody(request).then(body => {
      const target = validateDeviceTarget(body?.origin);
      if (!target.ok) return send(400, { error: target.reason });
      const label = normalizeDeviceName(body?.name);
      if (!label.ok) return send(400, { error: label.reason });

      const current = registry.read();
      const hidden = current.hidden.filter(origin => origin !== target.origin);
      const renamed = { ...current.renamed };
      const isBuiltIn = (config.devices || []).some(device => device.origin === target.origin);
      if (isBuiltIn) {
        // 预置设备改名：记成覆盖，免得改回去之前它一直是旧名字。
        renamed[target.origin] = label.name;
      } else if (!current.added.some(entry => entry.origin === target.origin)) {
        current.added.push({ name: label.name, origin: target.origin });
      } else {
        current.added = current.added.map(entry =>
          entry.origin === target.origin ? { ...entry, name: label.name } : entry);
      }
      registry.save({ ...current, renamed, hidden });
      // 写完必须自己看一眼：改名记进了 renamed，而地址又不在预置清单里时，
      // mergeRegistry 根本不会应用它，接口却照样回 200。浏览器于是关掉设置窗口，
      // 名字纹丝不动，用户只得到一句「保存不了」。这里对一遍结果再答复。
      const merged = registry.devices();
      const applied = merged.find(device => device.origin === target.origin);
      if (!applied || applied.name !== label.name) {
        return send(409, {
          error: `网关没能把「${label.name}」写进设备清单：${target.origin} 既不在预置清单里，也没被当成新设备加入`,
          devices: merged,
        });
      }
      return send(200, { devices: merged });
    }).catch(error => send(400, { error: error.message }));
  }

  if (request.method === 'DELETE') {
    const origin = normalizeOrigin(url.searchParams.get('origin') || '');
    if (!origin) return send(400, { error: '要指定要删除的设备地址' });
    const current = registry.read();
    const renamed = { ...current.renamed };
    delete renamed[origin];
    registry.save({
      ...current,
      renamed,
      added: current.added.filter(entry => entry.origin !== origin),
      hidden: current.hidden.includes(origin) ? current.hidden : [...current.hidden, origin],
    });
    return send(200, { devices: registry.devices() });
  }

  return send(405, { error: '不支持的请求方法' });
}

/**
 * 读 TLS 证书。两项必须同时存在才启用 HTTPS —— 只给一半就当没配，
 * 不能让网关在半 TLS 半明文的中间态上跑起来，那比干脆不加密更难排查。
 */
export function readTlsOptions(env = process.env) {
  const cert = (env.PILOTV_TLS_CERT || '').trim();
  const key = (env.PILOTV_TLS_KEY || '').trim();
  if (!cert || !key) {
    if (cert || key) {
      throw new Error('PILOTV_TLS_CERT 与 PILOTV_TLS_KEY 必须同时设置，只给一半不会启用 HTTPS');
    }
    return null;
  }
  if (!fs.existsSync(cert)) throw new Error(`PILOTV_TLS_CERT 不存在: ${cert}`);
  if (!fs.existsSync(key)) throw new Error(`PILOTV_TLS_KEY 不存在: ${key}`);
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

/**
 * 按有没有证书选 https / http。
 *
 * 为什么必须真的上 TLS：安卓 Chrome 只在「安全上下文」里允许注册 Service Worker
 * 和安装 PWA，局域网 http://192.168.x.x:5186 不是安全上下文 —— Service Worker
 * 直接注册失败，浏览器也永远不给安装入口，manifest 写得再对都没用。
 * WebSocket 会跟着页面自动升级成 wss://，升级事件在两种 server 上同名，
 * 所以下面那段隧道逻辑不用改。
 */
export function createGatewayServer(config, listener) {
  const tls = config.tls;
  if (!tls) return http.createServer(listener);
  // HSTS 只在 HTTPS 下才有意义：告诉浏览器一年内别再把这个源降级回 http，
  // 否则用户手输 http:// 打不开，会以为服务挂了。
  return https.createServer({ cert: tls.cert, key: tls.key }, (request, response) => {
    response.setHeader('strict-transport-security', 'max-age=31536000');
    listener(request, response);
  });
}

export function createGateway(config) {
  const distDir = config.distDir;
  const indexPath = path.join(distDir, 'index.html');
  const registry = config.registry;

  // 首页和前端路由回退都得注入运行时信息，漏掉一次刷新就会把当前设备弄丢。
  const serveIndex = (request, response) => {
    const devices = registry ? registry.devices() : config.devices;
    const backend = resolveBackend(request, config, devices);
    return fsp.readFile(indexPath, 'utf-8').then(html => {
      const cookies = [];
      // 只有通过 ?d= 明确切换时才刷新 Cookie，普通刷新不会覆盖别人的选择。
      // 刻意用会话 Cookie（不设 Max-Age）：设备选择只活在当前浏览器会话里，
      // 关掉浏览器再打开就回到本机默认。之前挂 1 年会让一次误点永久生效，
      // 而且设备换了之后请求会被转发到一台没有本机 token 的机器上，
      // 前端一收到 401 就清 token 刷新 —— 表现就是「登录后又弹回登录页」。
      if (backend.source === 'query') {
        cookies.push(`${DEVICE_COOKIE}=${encodeURIComponent(backend.origin)}; Path=/; SameSite=Lax`);
      }
      // 浏览器打开首页才算「从 PilotV 页面进入」，这个会话 Cookie 就是设备
      // 写操作的凭据。裸 curl / 跨站脚本拿不到它。
      const admin = adminCookieHeader(config);
      if (admin) cookies.push(admin);
      const headers = {};
      if (cookies.length) headers['set-cookie'] = cookies;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...headers });
      response.end(injectRuntime(html, {
        backend: backend.origin, device: backend.device, source: backend.source,
        unknownDevice: Boolean(backend.unknownDevice), artifactsPerDevice: config.artifactsPerDevice,
        defaultBackend: config.defaultBackend,
        defaultName: devices.find(item => item.origin === config.defaultBackend)?.name || '当前设备',
        weknoraUrl: resolveWeknoraUrl(request, config),
      }));
    }).catch(() => { response.writeHead(404); response.end('dist/index.html 不存在，请先构建前端'); });
  };

  const handleRequest = (request, response) => {
    const url = new URL(request.url, 'http://pilotv.local');

    if (registry && url.pathname.startsWith(PILOTV_API_PREFIX)) {
      return handleRegistryApi(request, response, url, config, registry);
    }

    const devices = registry ? registry.devices() : config.devices;
    const route = classifyPath(url.pathname);

    if (route === 'artifacts' || route === 'backend') {
      const backend = resolveBackend(request, config, devices);
      const upstream = route === 'artifacts' ? resolveArtifactsOrigin(backend.origin, config, devices) : backend.origin;
      if (upstream === null) {
        const body = JSON.stringify({ error: 'device-has-no-artifacts', device: backend.origin });
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        response.end(body);
        return;
      }
      const token = route === 'artifacts' ? config.artifactsToken : null;
      return forward(request, response, upstream, url.pathname + url.search, token,
        route === 'artifacts');
    }

    if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(request, response);

    const file = resolveStaticFile(distDir, url.pathname);
    if (!file) { response.writeHead(400); response.end('bad path'); return; }
    if (file.endsWith(path.sep + 'index.html')) { sendFile(response, file); return; }
    fs.stat(file, (error, stat) => {
      if (!error && stat.isFile()) return sendFile(response, file);
      // 没有扩展名的路径交给前端路由；其余按 404 处理。
      if (path.extname(file)) { response.writeHead(404); response.end('not found'); return; }
      serveIndex(request, response);
    });
  };

  const server = createGatewayServer(config, handleRequest);

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://pilotv.local').pathname;
    const route = classifyPath(pathname);
    // 只放行真正的长连接路径。以前这里不看路径直接隧道，等于任何一条
    // WebSocket 请求（包括 /api/... 之类本该走普通 HTTP 的路径）都能被原样
    // 接到上游去，绕开了下面的路由判断和鉴权。
    if (route !== 'socket') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    // 浏览器发起的跨站 WebSocket 握手不带同源限制，Origin 必须自己查。
    if (!isSameOrigin(request, config)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const devices = registry ? registry.devices() : config.devices;
    const backend = resolveBackend(request, config, devices);
    const upstream = route === 'artifacts' ? resolveArtifactsOrigin(backend.origin, config, devices) : backend.origin;
    if (upstream === null) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    // /shell 通道的客户端没有心跳，不能套用 /ws 的空闲阈值（见 WS_TUNNEL_IDLE_MS 的说明）。
    const idleMs = pathname.startsWith('/shell') ? 0 : WS_TUNNEL_IDLE_MS;
    pipeSocket(request, socket, head, upstream, idleMs);
  });

  return server;
}

export function loadConfigFromEnv(env = process.env) {
  const distDir = env.PILOTV_DIST || path.join(REPO_ROOT, 'pilotdeck-mobile/upstream-official/ui/dist');
  const devicesFile = env.PILOTV_DEVICES || path.join(REPO_ROOT, 'pilotdeck-mobile/upstream-official/ui/public/devices.json');
  const defaultBackend = normalizeOrigin(`http://${env.PILOTDECK_BACKEND || '127.0.0.1:3001'}`) || 'http://127.0.0.1:3001';
  let devicesText = '';
  try { devicesText = fs.readFileSync(devicesFile, 'utf-8'); } catch { devicesText = ''; }
  const devices = readDevices(devicesText, defaultBackend);
  for (const extra of (env.PILOTV_EXTRA_BACKENDS || '').split(',').map(item => item.trim()).filter(Boolean)) {
    const origin = normalizeOrigin(extra);
    if (origin && !devices.some(device => device.origin === origin)) devices.push({ name: origin, origin, backend: origin });
  }
  // 用户在悬浮窗里加的、改名的、藏掉的都存在这份文件里，它不属于构建产物。
  const registryFile = env.PILOTV_REGISTRY || path.join(HERE, 'data', 'devices.local.json');
  // 设备写操作的看门狗令牌。没配就退化成随机密钥落盘，两者都能签发浏览器
  // 的 pdv_admin 会话 Cookie（见 issueAdminCookie）。
  const adminSecret = env.PILOTV_ADMIN_TOKEN || readOrCreateAdminSecret(registryFile);
  return {
    distDir,
    devices,
    registry: new DeviceRegistry(registryFile, devices),
    registryFile,
    adminSecret,
    // 写操作默认关闭。设备写接口能把新地址加进代理白名单，等于让网关开始
    // 往那个地址转发 —— 谁能写，谁就能决定网关把流量送往哪个内网服务。
    // 必须显式 PILOTV_ALLOW_DEVICE_WRITES=1 打开，且还得能过会话 Cookie 校验。
    allowRegistryWrites: env.PILOTV_ALLOW_DEVICE_WRITES === '1',
    defaultBackend,
    artifactsTarget: normalizeOrigin(env.ARTIFACTS_TARGET || env.PILOTV_ARTIFACTS_TARGET || 'http://127.0.0.1:8799') || 'http://127.0.0.1:8799',
    artifactsPerDevice: env.PILOTV_ARTIFACTS_PER_DEVICE !== '0',
    // 远端成果台的令牌：只存在于网关进程，前端永远看不到。
    artifactsToken: env.PILOTV_ARTIFACTS_TOKEN || '',
    // 资料（WeKnora）：默认与前端同机、同为 http，端口可改；地址也可整段钉死。
    weknoraPort: Number(env.PILOTV_WEKNORA_PORT || 8080),
    weknoraUrl: env.PILOTV_WEKNORA_URL || '',
    port: Number(env.UI_PORT || 5186),
    bind: env.PILOTV_BIND || '0.0.0.0',
    tls: readTlsOptions(env),
  };
}

/**
 * 同一份设备清单只能有一个网关进程在写。
 *
 * 两个实例并存时，后启动的那个读的是最新清单，先启动的那个内存里还留着旧的一份；
 * 谁后写谁赢，前一个刚存进去的改名会被后一个的整份写覆盖。表现就是「改完又变回去」，
 * 而且完全没有提示——因为每次写都成功、每次都回 200。这里改成拿不到锁就别启动，
 * 让人先把老进程停掉（端口不同不代表互不相干，它们共用同一个清单文件）。
 */
export function claimRegistryLock(registryFile) {
  const lockFile = `${registryFile}.lock`;
  const readOwner = () => {
    try {
      const pid = Number(fs.readFileSync(lockFile, 'utf-8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };
  /** EPERM 说明进程在，但不是我们能 kill 的——那也得当成「还活着」。 */
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
  };

  const owner = readOwner();
  if (owner && owner !== process.pid && alive(owner)) {
    throw new Error(
      `设备清单 ${registryFile} 正被网关进程 ${owner} 使用。` +
      `两个网关共用一份清单会互相覆盖改动，请先停掉那个进程（kill ${owner}）再启动。`);
  }

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, `${process.pid}\n`, 'utf-8');
  const release = () => {
    try { if (readOwner() === process.pid) fs.unlinkSync(lockFile); } catch { /* 已经没了就算了 */ }
  };
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    // 只摘掉锁，信号照旧往下走，免得 Ctrl-C 被我们悄悄吃掉。
    process.once(signal, () => { release(); process.kill(process.pid, signal); });
  }
  return { lockFile, release };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let config;
  try {
    config = loadConfigFromEnv();
    claimRegistryLock(config.registryFile);
  } catch (error) {
    // 启动期的问题都是「这台机器上的部署状态不对」，不是代码错误，
    // 打一行人话就够了，让人自己去停掉老进程，别被堆栈吓住。
    console.error(`PilotV 网关启动失败：${error.message}`);
    process.exit(1);
  }
  const server = createGateway(config);
  server.listen(config.port, config.bind, () => {
    // 没证书时是 http：安卓 Chrome 不会给安装入口，Service Worker 也注册不了，
    // 启动行必须让人一眼看出来，否则只能对着手机猜为什么装不上。
    console.log(`PilotV 网关已启动：${config.tls ? 'https' : 'http'}://${config.bind}:${config.port}/`);
    if (!config.tls) {
      console.log('  提示：未配置 PILOTV_TLS_CERT/PILOTV_TLS_KEY。安卓浏览器安装桌面应用需要 HTTPS，');
      console.log('       跑 scripts/make_tls_cert.sh 生成证书后再配进本服务。');
    }
    console.log(`  默认后端 ${config.defaultBackend}`);
    console.log(`  可选设备 ${config.registry.devices().map(device => `${device.name}(${device.origin})`).join('  ')}`);
    console.log(`  设备清单 ${config.registryFile}（写操作${config.allowRegistryWrites ? '已开启' : '已关闭'}）`);
    console.log(`  成果台 ${config.artifactsPerDevice ? '跟随设备' : config.artifactsTarget}${config.artifactsToken ? '（远端带令牌）' : ''}`);
  });
}