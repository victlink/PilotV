import { describe, expect, it } from 'vitest';
import { createPairStore, normalizeCode, constantTimeEqual, REDEEM_REASONS } from '../pairStore.mjs';
import { buildPairUri, qrSvg, collectAlternates } from './pilotv-pair.js';

function fixedStore(start = 1_700_000_000_000) {
  let ts = start;
  let n = 0;
  const store = createPairStore({
    now: () => ts,
    randomInt: () => (n++ % 32),
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  return { store, advance: (ms) => { ts += ms; }, now: () => ts };
}

describe('pairStore 签发与兑换', () => {
  it('签发返回 6 位码与秘密，秘密不在记录里', () => {
    const { store } = fixedStore();
    const issued = store.issue({ origin: 'https://192.168.1.24:5186', userId: 1, username: 'marc' });
    expect(issued.code).toHaveLength(6);
    expect(issued.secret.length).toBeGreaterThanOrEqual(32);
    const record = store._pending.get(issued.code);
    expect(JSON.stringify(record)).not.toContain(issued.secret);
    expect(store.inspect(issued.code).state).toBe('pending');
  });

  it('兑换成功一次，重复兑换是显式错误', () => {
    const { store } = fixedStore();
    const issued = store.issue({ origin: 'https://h:5186', username: 'marc' });
    const first = store.redeem({ code: issued.code, secret: issued.secret, deviceName: 'Pixel 9' });
    expect(first.ok).toBe(true);
    expect(first.device.name).toBe('Pixel 9');
    expect(first.device.platform).toBe('android');
    const second = store.redeem({ code: issued.code, secret: issued.secret });
    expect(second).toMatchObject({ ok: false, reason: REDEEM_REASONS.alreadyUsed });
    expect(store.listDevices()).toHaveLength(1);
  });

  it('过期码不再可兑换', () => {
    const { store, advance } = fixedStore();
    const issued = store.issue({ origin: 'https://h:5186' });
    advance(5 * 60 * 1000 + 1);
    expect(store.redeem({ code: issued.code, secret: issued.secret })).toMatchObject({
      ok: false, reason: REDEEM_REASONS.expired,
    });
    expect(store.inspect(issued.code).state).toBe('unknown');
  });

  it('错误秘密不计成功，且 5 次后锁定', () => {
    const { store } = fixedStore();
    const issued = store.issue({ origin: 'https://h:5186' });
    for (let i = 0; i < 5; i += 1) {
      expect(store.redeem({ code: issued.code, secret: 'x'.repeat(43) })).toMatchObject({
        ok: false, reason: REDEEM_REASONS.badSecret,
      });
    }
    expect(store.redeem({ code: issued.code, secret: issued.secret })).toMatchObject({
      ok: false, reason: REDEEM_REASONS.tooManyAttempts,
    });
  });

  it('大小写与分隔符不影响手输', () => {
    const { store } = fixedStore();
    const issued = store.issue({ origin: 'https://h:5186' });
    expect(normalizeCode(' ' + issued.code.toLowerCase() + '-')).toBe(issued.code);
    const messy = issued.code.slice(0, 2) + ' ' + issued.code.slice(2).toLowerCase();
    expect(store.redeem({ code: messy, secret: issued.secret }).ok).toBe(true);
  });

  it('未知码被拒，且不消耗任何配额', () => {
    const { store } = fixedStore();
    expect(store.redeem({ code: 'ZZZZZZ', secret: 'y'.repeat(43) })).toMatchObject({
      ok: false, reason: REDEEM_REASONS.unknownCode,
    });
  });

  it('pending 不落盘，restore 只恢复设备台账', () => {
    const { store } = fixedStore();
    const issued = store.issue({ origin: 'https://h:5186' });
    store.redeem({ code: issued.code, secret: issued.secret });
    const snap = store.snapshot();
    expect(snap.devices).toHaveLength(1);
    expect(JSON.stringify(snap)).not.toContain('secretHash');

    const revived = createPairStore();
    revived.restore(snap);
    expect(revived.listDevices()).toHaveLength(1);
    expect(revived.inspect(issued.code).state).toBe('unknown');
  });

  it('撤销后设备消失，touch 更新时间', () => {
    const { store, advance } = fixedStore();
    const issued = store.issue({ origin: 'https://h:5186' });
    const { device } = store.redeem({ code: issued.code, secret: issued.secret, deviceName: 'iPad' });
    advance(1000);
    const touched = store.touch(device.id);
    expect(touched.lastSeenAt >= device.lastSeenAt).toBe(true);
    expect(store.revoke(device.id)).toBe(true);
    expect(store.listDevices()).toHaveLength(0);
  });

  it('未兑换码堆积有上限', () => {
    const { store } = fixedStore();
    for (let i = 0; i < 20; i += 1) store.issue({ origin: 'https://h:5186' });
    expect([...store._pending.values()].filter(r => !r.usedAt)).toHaveLength(8);
  });
});

describe('constantTimeEqual', () => {
  it('长度不同直接 false，内容相同 true', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('配对串与二维码', () => {
  it('uri 带版本、入口、码与秘密', () => {
    const uri = buildPairUri({ origin: 'https://192.168.1.24:5186', code: 'K7M2QP', secret: 's3cret', serverName: 'nas', ttlSeconds: 300 });
    expect(uri.startsWith('pilotv://pair?')).toBe(true);
    const params = new URLSearchParams(uri.split('?')[1]);
    expect(params.get('h')).toBe('https://192.168.1.24:5186');
    expect(params.get('c')).toBe('K7M2QP');
    expect(params.get('s')).toBe('s3cret');
    expect(params.get('ttl')).toBe('300');
    expect(params.get('n')).toBe('nas');
  });

  it('qrSvg 生成合法 SVG 且模块数随内容增长', () => {
    const small = qrSvg('pilotv://pair?c=ABC123');
    const large = qrSvg('pilotv://pair?' + 'x'.repeat(300));
    expect(small.startsWith('<svg')).toBe(true);
    expect(small).toContain('viewBox');
    expect(small).not.toMatch(/<script/i);
    const size = (svg) => Number(svg.match(/width="(\d+)"/)[1]);
    expect(size(large)).toBeGreaterThan(size(small));
  });
});

describe('备用入口（局域网 + 公网兜底）', () => {
  const fakeIfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '192.168.1.24', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    wlan0: [{ address: '10.0.0.9', family: 4, internal: false }],
  };

  it('公网入口补齐 scheme 并排在局域网之前', () => {
    const out = collectAlternates(
      'https://nas.tail2b98e5.ts.net:5186',
      { PILOTV_PUBLIC_ORIGINS: 'pilotv.victlink.com', PILOTV_LAN_PORT: '5187' },
      fakeIfaces,
    );
    expect(out[0]).toBe('https://pilotv.victlink.com');
    // 只有两个名额：公网占一个，剩下的给第一个局域网地址。
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('http://192.168.1.24:5187');
  });

  it('不把自己当备用，也不重复带同一个地址', () => {
    const out = collectAlternates(
      'http://192.168.1.24:5187',
      { PILOTV_PUBLIC_ORIGINS: 'https://pilotv.victlink.com,https://pilotv.victlink.com/' },
      fakeIfaces,
    );
    expect(out).toEqual(['https://pilotv.victlink.com']);
  });

  it('跳过回环和 IPv6，最多留两个（二维码容量）', () => {
    const out = collectAlternates(
      'https://pilotv.victlink.com',
      { PILOTV_LAN_PORT: '5187' },
      { eth0: [{ address: '192.168.1.24', family: 'IPv4', internal: false }],
        eth1: [{ address: '192.168.1.25', family: 'IPv4', internal: false }],
        eth2: [{ address: '192.168.1.26', family: 'IPv4', internal: false }],
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] },
    );
    expect(out).toHaveLength(2);
    expect(out.every(item => item.startsWith('http://192.168.1.'))).toBe(true);
  });

  it('没配环境变量时一个都不加（不改变现有部署的行为）', () => {
    expect(collectAlternates('https://pilotv.victlink.com', {}, fakeIfaces)).toEqual([]);
  });

  it('非法端口与非法 origin 被丢弃', () => {
    const out = collectAlternates(
      'https://pilotv.victlink.com',
      { PILOTV_PUBLIC_ORIGINS: 'javascript:alert(1),ftp://x', PILOTV_LAN_PORT: '99999' },
      fakeIfaces,
    );
    expect(out).toEqual([]);
  });

  it('网关绑回环地址时不给局域网候选（那是必然失败的死地址）', () => {
    const out = collectAlternates(
      'https://pilotv.victlink.com',
      { PILOTV_BIND: '127.0.0.1', PILOTV_LAN_PORT: '5187', PILOTV_PUBLIC_ORIGINS: 'https://pilotv.victlink.com' },
      fakeIfaces,
    );
    expect(out).toEqual([]);
  });

  it('排除 docker 网桥与 CGNAT/Tailscale 段，并按 192.168 → 10 排序', () => {
    const out = collectAlternates(
      'https://pilotv.victlink.com',
      { PILOTV_BIND: '0.0.0.0', PILOTV_LAN_PORT: '5187' },
      {
        eth0: [
          { address: '172.17.0.1', family: 'IPv4', internal: false },   // docker 默认网桥
          { address: '100.90.196.104', family: 'IPv4', internal: false }, // Tailscale
          { address: '10.0.0.9', family: 'IPv4', internal: false },
          { address: '192.168.1.24', family: 'IPv4', internal: false },
        ],
      },
    );
    expect(out).toEqual(['http://192.168.1.24:5187', 'http://10.0.0.9:5187']);
    expect(out.some(item => item.includes('172.17') || item.includes('100.90'))).toBe(false);
  });

  it('uri 带上 a 参数，多个地址用 | 连接', () => {
    const uri = buildPairUri({
      origin: 'https://pilotv.victlink.com',
      alternates: ['http://192.168.1.24:5187', 'https://nas.tail2b98e5.ts.net:5186'],
      code: 'K7M2QP',
      secret: 's3cret',
      ttlSeconds: 300,
    });
    const params = new URLSearchParams(uri.split('?')[1]);
    expect(params.get('a')).toBe('http://192.168.1.24:5187|https://nas.tail2b98e5.ts.net:5186');
  });

  it('没有备用地址时不写 a 参数（二维码保持小尺寸）', () => {
    const uri = buildPairUri({ origin: 'https://pilotv.victlink.com', code: 'K7M2QP', secret: 's3cret' });
    expect(new URLSearchParams(uri.split('?')[1]).has('a')).toBe(false);
  });
});
