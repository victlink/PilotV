// 扫码配对：把桌面端已有的登录态，一次性交给手机/平板客户端。
//
// 为什么不用「在手机上再输一遍账号密码」：PilotV 的账号是单用户的本地账号，
// 手机上输密码既慢又更容易被输入法/截屏带走。二维码里带的是一次性码 + 一次性
// 秘密，5 分钟、只能兑一次、兑换即焚。
//
// 安全边界（逐条对应代码）：
//   * 只有已登录的浏览器能「生成」二维码（authenticateToken）。
//   * 兑换接口不需要登录 —— 它靠 secret 证明「你确实看到了那台机器屏幕上的码」。
//   * 试错上限 5 次，码 6 位且不含易混字符。
//   * 下发的 token 与浏览器同一套 JWT，因此不需要改任何下游鉴权；客户端拿它调
//     /api/* 与 wss://…/ws?token= 即可。revoke 只是从登记表里移除记录，
//     真正让 token 失效仍需换代 JWT_SECRET（README 里写清楚了，不假装能单条吊销）。
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { authenticateToken, generateToken } from '../middleware/auth.js';
import { requestLimiters } from '../middleware/rateLimits.js';
import { createPairStore, REDEEM_REASONS, normalizeCode } from '../pairStore.mjs';
import { qrcode } from '../vendor/qrcode.mjs';

const PAIR_URI_SCHEME = 'pilotv://pair';

function statePath() {
  return path.join(resolvePilotHome(), 'paired-devices.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { version: 1, devices: [] };
  }
}

async function writeState(snapshot) {
  const file = statePath();
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
}

function parseOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 二维码里的地址必须是「手机能连上的那个入口」。浏览器自己知道这件事
 * （window.location.origin），所以由页面显式传上来，服务端只校验它的主机名
 * 与本次请求一致 —— 否则任何人都能让二维码指向别处。
 */
function resolveRequestedOrigin(req, requested) {
  const parsed = parseOrigin(requested);
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (parsed) {
    const host = new URL(parsed).host;
    if (!forwardedHost || host === forwardedHost) return parsed;
    const allow = String(process.env.PILOTV_PAIR_ORIGINS || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    if (allow.includes(parsed)) return parsed;
    return null;
  }
  return parseOrigin(process.env.PILOTV_PAIR_ORIGIN || `http://${forwardedHost}`);
}

/** 局域网地址的可用性排序；返回 9 表示「不要给手机」，探测一轮要白等好几秒。 */
function lanRank(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  // docker / 容器网桥：宿主机能访问，手机访问不到。
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 9;
  // CGNAT 段，Tailscale 的 100.64/10 也在这里 —— 本方案的目标就是不用它。
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 9;
  return 2;
}

/**
 * 手机能试连的其它入口。两个来源，各自解决一个问题：
 *   * 公网隧道（PILOTV_PUBLIC_ORIGINS）—— 手机不在同一网络时唯一的办法；
 *   * 局域网 IP（PILOTV_LAN_PORT）—— 同网时不必绕 Cloudflare，延迟差一个数量级。
 *
 * 只由服务端生成，不接受页面传来的值：候选地址会连同一次性秘密一起写进二维码，
 * 若允许页面指定，等于允许把秘密指向任意主机。
 */
export function collectAlternates(primary, env = process.env, interfaces = os.networkInterfaces()) {
  const out = [];
  const push = (value) => {
    const normalized = parseOrigin(value);
    if (!normalized || normalized === primary || out.includes(normalized)) return;
    out.push(normalized);
  };

  for (const item of String(env.PILOTV_PUBLIC_ORIGINS || '').split(',')) {
    const host = item.trim();
    if (!host) continue;
    push(host.includes('://') ? host : `https://${host}`);
  }

  // 网关只监听回环地址时，局域网候选是必然连不上的死地址：
  // 手机要为此白等一整轮探测超时，比不带还糟。
  // 默认值和 service/pilotv_gateway.mjs 保持一致（未设置就是 0.0.0.0）。
  const bind = String(env.PILOTV_BIND || '0.0.0.0').trim();
  const boundToLoopback = bind === '::1' || bind.startsWith('127.');
  const lanPort = Number(env.PILOTV_LAN_PORT || 0);
  if (!boundToLoopback && Number.isInteger(lanPort) && lanPort > 0 && lanPort < 65536) {
    const candidates = [];
    for (const list of Object.values(interfaces || {})) {
      for (const entry of list || []) {
        // Node 14 之后 family 是 'IPv4'，之前是数字 4，两种都得认。
        if (entry.family !== 'IPv4' && entry.family !== 4) continue;
        if (entry.internal) continue;
        const rank = lanRank(entry.address);
        if (rank >= 9) continue;
        candidates.push({ address: entry.address, rank });
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    for (const item of candidates) push(`http://${item.address}:${lanPort}`);
  }

  // 二维码容量有限：每多一个地址约多 30 字符，带三个以上会把版本推到 v12+，
  // 屏幕上更难扫。局域网 + 公网两个足够了。
  return out.slice(0, 2);
}

export function buildPairUri({ origin, alternates = [], code, secret, serverName, ttlSeconds }) {
  const params = new URLSearchParams({
    v: '1',
    h: origin,
    ...(alternates.length ? { a: alternates.join('|') } : {}),
    c: code,
    s: secret,
    ...(serverName ? { n: serverName } : {}),
    ...(Number.isFinite(ttlSeconds) ? { ttl: String(ttlSeconds) } : {}),
  });
  return `${PAIR_URI_SCHEME}?${params.toString()}`;
}

/** 生成 SVG，不引第三方服务：配对秘密不能出现在任何外部的 URL 里。 */
export function qrSvg(text, { scale = 8, margin = 4, dark = '#0A0A0A', light = '#FFFFFF' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * scale;
  const rects = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      rects.push(`M${(col + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="PilotV 配对二维码"><rect width="${size}" height="${size}" fill="${light}"/><path d="${rects.join('')}" fill="${dark}"/></svg>`;
}

export function createPilotVPairRouter({
  now = () => Date.now(),
  serverName = process.env.PILOTV_SERVER_NAME || '',
  store = createPairStore({ now, devices: readState().devices || [] }),
  persist = writeState,
  tokenFor = generateToken,
  // 注入点：单测里换成假的鉴权中间件，就能把路由真跑起来（而不是只测纯函数）。
  authenticate = authenticateToken,
} = {}) {
  const router = express.Router();

  router.post('/new', authenticate, async (req, res) => {
    const body = req.body || {};
    const origin = resolveRequestedOrigin(req, body.origin);
    if (!origin) {
      return res.status(400).json({ error: 'origin 不是合法的入口地址，或与当前请求主机不一致', code: 'bad_origin' });
    }
    // deviceOrigin：网关当前把请求转发到哪台设备。手机没有 Cookie，后续每个请求
    // 都要带 X-PilotV-Device 才不会被路由到默认设备上。只接受 http(s) 源。
    const deviceOrigin = parseOrigin(body.deviceOrigin) || '';
    // 备用入口：手机扫到码之后可以逐个试连，哪个通就用哪个。
    const alternates = collectAlternates(origin);
    const issued = store.issue({
      origin,
      alternates,
      deviceOrigin,
      serverName: String(body.serverName || serverName || '').slice(0, 60),
      userId: req.user?.id ?? null,
      username: req.user?.username ?? null,
      ttl: Number(body.ttlSeconds) > 0 ? Number(body.ttlSeconds) * 1000 : undefined,
    });
    const ttlSeconds = Math.round((issued.expiresAt - now()) / 1000);
    return res.json({
      code: issued.code,
      secret: issued.secret,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      ttlSeconds,
      origin: issued.origin,
      serverName: issued.serverName,
      deviceOrigin,
      alternates: issued.alternates || [],
      uri: buildPairUri({ ...issued, alternates: issued.alternates || [], ttlSeconds }),
      qrPath: `/api/pilotv/pair/${issued.code}/qr.svg`,
    });
  });

  // 秘密只在签发响应里出现过一次，服务端只留哈希，无法重算二维码内容，
  // 所以由签发页面把 uri 用 base64url 传上来渲染 —— 这样二维码里不会出现
  // 任何第三方服务，秘密也不会离开这台机器。
  router.get('/render.svg', authenticate, (req, res) => {
    const data = String(req.query.d || '');
    if (!data || data.length > 2048) return res.status(400).json({ error: 'bad payload' });
    let text;
    try {
      text = Buffer.from(data, 'base64url').toString('utf8');
    } catch {
      return res.status(400).json({ error: 'bad payload' });
    }
    if (!text.startsWith(PAIR_URI_SCHEME)) return res.status(400).json({ error: 'not a pair uri' });
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(qrSvg(text));
  });

  router.get('/status', authenticate, (req, res) => {
    const code = normalizeCode(req.query.code || '');
    return res.json({ code, ...store.inspect(code) });
  });

  // 兑换：唯一一个不需要登录的写操作，靠 secret + 试错上限保护。
  router.post('/redeem', requestLimiters.auth, async (req, res) => {
    const body = req.body || {};
    if (typeof body.secret !== 'string' || body.secret.length < 16) {
      return res.status(400).json({ error: 'secret 缺失', code: REDEEM_REASONS.badSecret });
    }
    const result = store.redeem({
      code: body.code,
      secret: body.secret,
      deviceName: body.deviceName,
      platform: body.platform,
      deviceId: typeof body.deviceId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.deviceId) ? body.deviceId : null,
    });
    if (!result.ok) {
      const status = result.reason === REDEEM_REASONS.badSecret ? 401
        : result.reason === REDEEM_REASONS.tooManyAttempts ? 429
          : result.reason === REDEEM_REASONS.alreadyUsed ? 409
            : 404;
      return res.status(status).json({ error: result.reason, code: result.reason, remaining: result.remaining });
    }
    const token = tokenFor({ id: result.device.id, username: result.device.username || 'pilotv' });
    try {
      await persist(store.snapshot());
    } catch (error) {
      // 落盘失败不能把已经发出去的 token 变成「未知状态」：设备记录只是台账，
      // 内存里已经有，重试交给下一次写入。
      console.error('[pilotv-pair] 设备台账写入失败:', error?.message || error);
    }
    return res.json({
      ok: true,
      token,
      tokenType: 'Bearer',
      device: result.device,
      origin: result.record.origin,
      alternates: result.record.alternates || [],
      deviceOrigin: result.record.deviceOrigin || '',
      serverName: result.record.serverName,
      expiresAt: new Date(now() + 7 * 24 * 3600 * 1000).toISOString(),
    });
  });

  router.get('/devices', authenticate, (req, res) => {
    return res.json({ devices: store.listDevices() });
  });

  router.delete('/devices/:id', authenticate, async (req, res) => {
    const removed = store.revoke(req.params.id);
    if (removed) {
      try { await persist(store.snapshot()); } catch { /* 台账失败不影响本次撤销结果 */ }
    }
    return res.json({ ok: removed });
  });

  return router;
}

export default createPilotVPairRouter;
