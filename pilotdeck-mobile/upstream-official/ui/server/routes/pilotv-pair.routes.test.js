import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { createPilotVPairRouter } from './pilotv-pair.js';

/**
 * 路由级测试：真起一个 HTTP 服务，把「鉴权 → 生成码 → 渲染二维码 → 兑换 → 台账 → 移除」
 * 这条链走一遍。纯函数单测（pilotv-pair.test.js）覆盖状态机，这里覆盖接线 ——
 * 手机端拿不到的是接线错误，而不是状态机错误。
 */
describe('POST /api/pilotv/pair', () => {
  let server;
  let base = '';
  const devices = [];
  const authenticate = (req, res, next) => {
    if (req.headers['x-test-user'] !== 'marc') return res.status(401).json({ error: 'no session' });
    req.user = { id: 'u1', username: 'marc' };
    return next();
  };

  beforeAll(async () => {
    const app = express();
    app.use('/api/pilotv/pair', express.json(), createPilotVPairRouter({
      authenticate,
      tokenFor: (user) => `token-for-${user.username}`,
      persist: async (snapshot) => { devices.splice(0, devices.length, ...snapshot.devices); },
      serverName: 'nas',
    }));
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const call = (path, options = {}) => fetch(`${base}/api/pilotv/pair${path}`, {
    headers: { 'content-type': 'application/json', 'x-test-user': 'marc', ...(options.headers || {}) },
    ...options,
  });

  let issued;

  it('没有登录态不许生成码', async () => {
    const response = await fetch(`${base}/api/pilotv/pair/new`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('origin 与请求主机不一致时拒绝', async () => {
    const response = await call('/new', { method: 'POST', body: JSON.stringify({ origin: 'https://evil.example.com' }) });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('bad_origin');
  });

  it('生成码返回 uri 与 svg 路径', async () => {
    const response = await call('/new', {
      method: 'POST',
      body: JSON.stringify({ origin: base, deviceOrigin: 'http://127.0.0.1:3001' }),
    });
    expect(response.status).toBe(200);
    issued = await response.json();
    expect(issued.code).toHaveLength(6);
    expect(issued.uri.startsWith('pilotv://pair?')).toBe(true);
    expect(issued.ttlSeconds).toBeLessThanOrEqual(300);
    expect(issued.deviceOrigin).toBe('http://127.0.0.1:3001');
  });

  it('二维码是 SVG，且拒绝非配对串', async () => {
    const uri = Buffer.from(issued.uri, 'utf8').toString('base64url');
    const ok = await call(`/render.svg?d=${uri}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('image/svg+xml');
    expect(await ok.text()).toContain('<svg');

    const bad = await call(`/render.svg?d=${Buffer.from('https://example.com', 'utf8').toString('base64url')}`);
    expect(bad.status).toBe(400);
  });

  it('错误秘密 401，正确秘密换到 token', async () => {
    const wrong = await call('/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: issued.code, secret: 'x'.repeat(43), deviceName: 'Pixel' }),
    });
    expect(wrong.status).toBe(401);

    const ok = await call('/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: issued.code, secret: issued.secret, deviceName: 'Pixel 9', platform: 'android' }),
    });
    expect(ok.status).toBe(200);
    const payload = await ok.json();
    expect(payload.token).toBe('token-for-marc');
    expect(payload.device.name).toBe('Pixel 9');
    // 手机靠这个值在后续请求里带 X-PilotV-Device，否则多设备部署会被路由到默认设备。
    expect(payload.deviceOrigin).toBe('http://127.0.0.1:3001');
    expect(devices).toHaveLength(1);
  });

  it('非法 deviceOrigin 被丢弃而不是原样回显', async () => {
    const response = await call('/new', {
      method: 'POST',
      body: JSON.stringify({ origin: base, deviceOrigin: 'javascript:alert(1)' }),
    });
    expect((await response.json()).deviceOrigin).toBe('');
  });

  it('同一个码不能再兑一次', async () => {
    const again = await call('/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: issued.code, secret: issued.secret }),
    });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('already_used');
  });

  it('台账可读、可移除', async () => {
    const list = await call('/devices');
    const { devices: paired } = await list.json();
    expect(paired).toHaveLength(1);

    const removed = await call(`/devices/${encodeURIComponent(paired[0].id)}`, { method: 'DELETE' });
    expect((await removed.json()).ok).toBe(true);
    expect(devices).toHaveLength(0);
  });
});
