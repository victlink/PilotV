// 扫码配对的状态机（零依赖、可单测）。
//
// 为什么单独成文件：配对是「把登录态交给第二台设备」——最容易做错的安全面。
// 把它写成纯函数 + 显式状态，才能在不启动 HTTP 服务的情况下把过期、重放、
// 暴力猜码、二次兑换这些分支逐条测掉（见 pilotv-pair.test.js）。
//
// 三条不变量：
//   1. 秘密只在签发时返回一次，落盘/内存里只留 sha256。日志里出现明文就再也收不回来。
//   2. 一个配对码只能兑换一次；兑换成功即作废，重复兑换必须是显式错误而不是静默成功。
//   3. 试错有上限：6 位码 = 32^6 ≈ 10 亿，但如果不计次，5 分钟窗口内足够跑字典。

import crypto from 'node:crypto';

/** 去掉容易看错的 0/O/1/I，手输时容错更高。 */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_LENGTH = 6;
export const PAIR_TTL_MS = 5 * 60 * 1000;
export const PAIR_MAX_ATTEMPTS = 5;

export const REDEEM_REASONS = Object.freeze({
  unknownCode: 'unknown_code',
  expired: 'expired',
  alreadyUsed: 'already_used',
  badSecret: 'bad_secret',
  tooManyAttempts: 'too_many_attempts',
});

function randomCode(randomInt) {
  let out = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    out += PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)];
  }
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 定长比较，避免按字节提前返回把秘密泄漏成时序侧信道。 */
export function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function createPairStore({
  now = () => Date.now(),
  ttlMs = PAIR_TTL_MS,
  maxAttempts = PAIR_MAX_ATTEMPTS,
  randomBytes = crypto.randomBytes,
  randomInt = crypto.randomInt,
  devices = [],
} = {}) {
  /** code -> 待兑换记录 */
  let pending = new Map();
  /** deviceId -> 已配对设备 */
  let paired = new Map(devices.map(device => [device.id, device]));

  // 已兑换的记录保留到过期为止：这样重复扫码能拿到 already_used（能解释），
  // 而不是 unknown（像是码错了）。两条错误信息对用户的下一步动作完全不同。
  const prune = () => {
    const ts = now();
    for (const [code, record] of pending) {
      if (record.expiresAt <= ts) pending.delete(code);
    }
  };

  function issue({ origin, deviceOrigin = '', serverName = '', userId = null, username = null, ttl } = {}) {
    prune();
    if (!origin) throw new Error('origin is required');
    // 同一时刻只保留少量未兑换码：页面上点了几次「刷新」不该留下几十个可用入口。
    const active = [...pending.values()].filter(record => !record.usedAt && record.expiresAt > now());
    if (active.length >= 8) {
      active
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .slice(0, active.length - 7)
        .forEach(record => pending.delete(record.code));
    }
    const code = randomCode(randomInt);
    const secret = randomBytes(32).toString('base64url');
    const record = {
      code,
      secretHash: sha256(secret),
      origin,
      deviceOrigin,
      serverName,
      userId,
      username,
      issuedAt: now(),
      expiresAt: now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : ttlMs),
      attempts: 0,
      usedAt: null,
    };
    pending.set(code, record);
    return { code, secret, expiresAt: record.expiresAt, origin, serverName };
  }

  function inspect(code) {
    const record = pending.get(normalizeCode(code));
    if (!record) return { state: 'unknown' };
    if (record.usedAt) return { state: 'used', usedAt: record.usedAt };
    if (record.expiresAt <= now()) return { state: 'expired', expiresAt: record.expiresAt };
    return { state: 'pending', expiresAt: record.expiresAt, origin: record.origin, serverName: record.serverName };
  }

  /**
   * 兑换。成功后返回设备记录；失败返回 reason，调用方据此给出可读错误。
   * `deviceName` 是客户端自报的名字，服务端只做长度裁剪，不参与鉴权。
   */
  function redeem({ code, secret, deviceName = '', platform = '', deviceId = null } = {}) {
    const normalized = normalizeCode(code);
    const record = pending.get(normalized);
    if (!record) return { ok: false, reason: REDEEM_REASONS.unknownCode };
    if (record.usedAt) return { ok: false, reason: REDEEM_REASONS.alreadyUsed };
    if (record.expiresAt <= now()) {
      pending.delete(normalized);
      return { ok: false, reason: REDEEM_REASONS.expired };
    }
    if (record.attempts >= maxAttempts) return { ok: false, reason: REDEEM_REASONS.tooManyAttempts };
    record.attempts += 1;
    if (!constantTimeEqual(record.secretHash, sha256(secret))) {
      return { ok: false, reason: REDEEM_REASONS.badSecret, remaining: maxAttempts - record.attempts };
    }

    record.usedAt = now();
    const id = deviceId || `dev_${crypto.randomBytes(6).toString('hex')}`;
    const device = {
      id,
      name: String(deviceName || '未命名设备').slice(0, 40),
      platform: String(platform || 'android').slice(0, 40),
      origin: record.origin,
      deviceOrigin: record.deviceOrigin || '',
      serverName: record.serverName,
      username: record.username || null,
      pairedAt: new Date(record.usedAt).toISOString(),
      lastSeenAt: new Date(record.usedAt).toISOString(),
    };
    paired.set(id, device);
    return { ok: true, device, record };
  }

  function touch(deviceId) {
    const device = paired.get(deviceId);
    if (!device) return null;
    const next = { ...device, lastSeenAt: new Date(now()).toISOString() };
    paired.set(deviceId, next);
    return next;
  }

  function revoke(deviceId) {
    return paired.delete(deviceId);
  }

  function listDevices() {
    return [...paired.values()].sort((a, b) => String(b.pairedAt).localeCompare(String(a.pairedAt)));
  }

  /** 落盘用：pending 不持久化（重启即作废），只留已配对设备。 */
  function snapshot() {
    return { version: 1, devices: listDevices() };
  }

  function restore(state) {
    const incoming = Array.isArray(state?.devices) ? state.devices : [];
    paired = new Map(incoming.filter(device => device && typeof device.id === 'string').map(device => [device.id, device]));
  }

  return { issue, inspect, redeem, touch, revoke, listDevices, snapshot, restore, prune, _pending: pending };
}

export default createPairStore;
