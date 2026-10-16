// 网关的纯函数与端到端行为。端到端部分真起两个假后端，
// 用来确认「同一个前端入口」确实能按设备切到不同的后端。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import {
  DEVICE_COOKIE, DEVICE_HEADER, ADMIN_COOKIE, adminTokenFor, claimRegistryLock, classifyPath, createGateway,
  injectRuntime, normalizeOrigin, readTlsOptions,
  readCookie, readDevices, resolveArtifactsOrigin, resolveBackend, resolveDeviceParam, resolveWeknoraUrl,
  slugify, verifyAdmin,
} from './pilotv_gateway.mjs';
import {
  DeviceRegistry, isPrivateHost, mergeRegistry, normalizeDeviceName, pruneDeadRenames, readRegistryFile,
  validateDeviceTarget,
} from './device_registry.mjs';

/** 端到端用例里的固定会话密钥，配合 send() 默认带的令牌使用。 */
const TEST_ADMIN_SECRET = 'test-admin-secret-do-not-use-in-prod';

const DEVICES = [
  { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001', backend: 'http://100.72.0.111:3001' },
  { name: 'leo-mac-studio', origin: 'http://100.117.103.34:3001', backend: 'http://100.117.103.34:3001' },
  { name: 'jx88', origin: 'http://100.108.86.109:3001', backend: 'http://100.108.86.109:3001' },
];

test('normalizeOrigin 只接受 http(s) 并去掉路径', () => {
  assert.equal(normalizeOrigin('http://100.0.0.1:3001/'), 'http://100.0.0.1:3001');
  assert.equal(normalizeOrigin('https://host:8443/a/b?c=1'), 'https://host:8443');
  assert.equal(normalizeOrigin('file:///etc/passwd'), null);
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
  assert.equal(normalizeOrigin('100.0.0.1:3001'), null);
  assert.equal(normalizeOrigin(''), null);
  assert.equal(normalizeOrigin(undefined), null);
});

test('slugify 生成的短标识可用于 ?d=', () => {
  assert.equal(slugify('MARC Linux PC'), 'marc-linux-pc');
  assert.equal(slugify('  jx88  '), 'jx88');
});

test('resolveDeviceParam 认 origin 和短标识，其余一律拒绝', () => {
  assert.equal(resolveDeviceParam('http://100.108.86.109:3001', DEVICES).origin, 'http://100.108.86.109:3001');
  assert.equal(resolveDeviceParam('jx88', DEVICES).origin, 'http://100.108.86.109:3001');
  assert.equal(resolveDeviceParam('marc-linux-pc', DEVICES).origin, 'http://100.72.0.111:3001');
  assert.equal(resolveDeviceParam('http://evil.example:3001', DEVICES).reason, 'unknown');
  assert.equal(resolveDeviceParam('169.254.169.254', DEVICES).reason, 'unknown');
  assert.equal(resolveDeviceParam('jx88', []).reason, 'unknown');
});

test('readCookie 只取自己那一个', () => {
  assert.equal(readCookie('a=1; pdv_backend=http%3A%2F%2Fjx%3A3001; b=2', DEVICE_COOKIE), 'http://jx:3001');
  assert.equal(readCookie('a=1', DEVICE_COOKIE), null);
  assert.equal(readCookie(undefined, DEVICE_COOKIE), null);
});

test('classifyPath 让成果台先于通用 /api', () => {
  assert.equal(classifyPath('/api/artifacts'), 'artifacts');
  assert.equal(classifyPath('/api/artifacts/abc'), 'artifacts');
  assert.equal(classifyPath('/artifacts-static/x.png'), 'artifacts');
  assert.equal(classifyPath('/api/projects'), 'backend');
  assert.equal(classifyPath('/memory-dashboard'), 'backend');
  assert.equal(classifyPath('/ws'), 'socket');
  assert.equal(classifyPath('/shell'), 'socket');
  assert.equal(classifyPath('/assets/index.js'), 'static');
  assert.equal(classifyPath('/artifacts.json'), 'static');
});

const config = {
  devices: DEVICES,
  defaultBackend: 'http://127.0.0.1:3001',
  artifactsTarget: 'http://127.0.0.1:8799',
  artifactsPerDevice: true,
};
const request = (url, cookie) => ({ url, headers: cookie ? { cookie } : {} });

test('resolveBackend：?d= 优先于 Cookie，Cookie 再优先于默认后端', () => {
  assert.equal(resolveBackend(request('/?d=jx88'), config).origin, 'http://100.108.86.109:3001');
  assert.equal(resolveBackend(request('/', `${DEVICE_COOKIE}=http://100.72.0.111:3001`), config).origin, 'http://100.72.0.111:3001');
  assert.equal(resolveBackend(request('/'), config).origin, 'http://127.0.0.1:3001');
});

test('resolveBackend：Cookie 里的陌生地址被忽略，不能借它探测内网', () => {
  const resolved = resolveBackend(request('/', `${DEVICE_COOKIE}=http://169.254.169.254:80`), config);
  assert.equal(resolved.origin, 'http://127.0.0.1:3001');
  assert.equal(resolveBackend(request('/?d=http://evil.example'), config).unknownDevice, true);
});

test('成果台跟到设备自己那一份（端口单独配，不走 3001）', () => {
  const withPorts = [
    { name: '本机', origin: 'http://127.0.0.1:3001' },
    { name: 'jx88', origin: 'http://100.108.86.109:3001', artifactsPort: 8799 },
    { name: 'leo', origin: 'http://100.117.103.34:3002', artifactsPort: 8899 },
  ];
  // 远端设备用它们自己部署的成果台，端口来自设备记录，不是 PilotDeck 的 3001。
  assert.equal(resolveArtifactsOrigin('http://100.108.86.109:3001', config, withPorts), 'http://100.108.86.109:8799');
  assert.equal(resolveArtifactsOrigin('http://100.117.103.34:3002', config, withPorts), 'http://100.117.103.34:8899');
  // 本机用本机那份，不受设备记录影响。
  assert.equal(resolveArtifactsOrigin('http://127.0.0.1:3001', config, withPorts), 'http://127.0.0.1:8799');
  // 关闭跟随设备时一律用本机那份。
  assert.equal(resolveArtifactsOrigin('http://100.108.86.109:3001', { ...config, artifactsPerDevice: false }, withPorts), 'http://127.0.0.1:8799');
});

test('读设备清单时成果台端口不能被吞掉', () => {
  const parsed = readDevices(JSON.stringify({ devices: [
    { name: 'jx88', origin: 'http://100.108.86.109:3001', artifactsPort: 8799 },
    { name: '坏了', origin: 'http://100.9.9.9:3001', artifactsPort: 'abc' },
    { name: '越界', origin: 'http://100.9.9.8:3001', artifactsPort: 99999 },
  ] }), 'http://127.0.0.1:3001');
  // 本机会被 unshift 到最前面，所以按 origin 找，别按下标。
  const jx88 = parsed.find(d => d.origin === 'http://100.108.86.109:3001');
  assert.equal(jx88.artifactsPort, 8799, '合法端口必须带出来，否则远端会被误判成没部署成果台');
  assert.equal('artifactsPort' in parsed.find(d => d.origin === 'http://100.9.9.9:3001'), false, '非法端口不该进清单');
  assert.equal('artifactsPort' in parsed.find(d => d.origin === 'http://100.9.9.8:3001'), false, '越界端口不该进清单');
});

test('设备没部署成果台就如实报缺失，不甩到它的 3001', () => {
  const noArtifacts = [
    { name: 'jx88', origin: 'http://100.108.86.109:3001' },                  // 没配
    { name: 'leo', origin: 'http://100.117.103.34:3002', artifactsPort: 0 },   // 端口非法
    { name: 'marc', origin: 'http://100.72.0.111:3001', artifactsPort: 'abc' }, // 不是数字
    { name: 'x', origin: 'http://100.9.9.9:3001', artifactsPort: 99999 },      // 越界
  ];
  for (const device of noArtifacts) {
    assert.equal(resolveArtifactsOrigin(device.origin, config, noArtifacts), null, device.name + ' 应判为未部署');
  }
  // 分类器必须把成果 API 与成果页要用的静态资源交给 artifacts 上游，
  // 而不是普通后端；独立成果台页面已删除，不再有 /artifacts.html。
  assert.equal(classifyPath('/api/artifacts'), 'artifacts');
  assert.equal(classifyPath('/api/artifacts/workspace'), 'artifacts');
  assert.equal(classifyPath('/artifacts-static/vendor/model-viewer.min.js'), 'artifacts');
  assert.equal(classifyPath('/artifacts.html'), 'static');
  assert.equal(classifyPath('/api/projects'), 'backend');
});

test('injectRuntime 把当前后端写进页面', () => {
  const html = injectRuntime('<html><head></head><body></body></html>', { backend: 'http://jx:3001' });
  assert.match(html, /window\.__PILOTV__=/);
  assert.match(html, /http:\/\/jx:3001/);
  assert.equal(html.indexOf('__PILOTV__') < html.indexOf('</head>'), true);
});

test('resolveWeknoraUrl 跟着当前入口主机走，只换端口', () => {
  assert.equal(
    resolveWeknoraUrl({ headers: { host: '100.90.196.104:5186' } }, { weknoraPort: 8080 }),
    'http://100.90.196.104:8080',
  );
  // 没带端口的 Host 也要能用。
  assert.equal(
    resolveWeknoraUrl({ headers: { host: 'pilotv.local' } }, { weknoraPort: 18080 }),
    'http://pilotv.local:18080',
  );
  // IPv6 的方括号是 Host 的一部分，不能切。
  assert.equal(
    resolveWeknoraUrl({ headers: { host: '[fd00::1]:5186' } }, { weknoraPort: 8080 }),
    'http://[fd00::1]:8080',
  );
  // 反代在前面终止 TLS 时，按转发协议给 https，否则 iframe 会被浏览器判成混合内容。
  assert.equal(
    resolveWeknoraUrl({ headers: { host: 'a:5186', 'x-forwarded-proto': 'https' } }, { weknoraPort: 8080 }),
    'https://a:8080',
  );
});

test('resolveWeknoraUrl 优先用钉死的地址，端口非法或没有 Host 时返回 null', () => {
  assert.equal(
    resolveWeknoraUrl({ headers: { host: 'a:5186' } }, { weknoraUrl: 'http://docs.lan:9000/', weknoraPort: 8080 }),
    'http://docs.lan:9000',
  );
  assert.equal(
    resolveWeknoraUrl({ headers: { host: 'a:5186' } }, { weknoraUrl: 'not-a-url', weknoraPort: 8080 }),
    'http://a:8080',
  );
  assert.equal(resolveWeknoraUrl({ headers: { host: 'a:5186' } }, { weknoraPort: 0 }), null);
  assert.equal(resolveWeknoraUrl({ headers: {} }, { weknoraPort: 8080 }), null);
});

test('readDevices 去重、剔除非法项并补上本机设备', () => {
  const devices = readDevices(JSON.stringify({
    devices: [
      { name: 'jx88', origin: 'http://100.108.86.109:3001' },
      { name: '重复', origin: 'http://100.108.86.109:3001/' },
      { name: '坏地址', origin: 'not-a-url' },
      { name: '  ', origin: 'http://x:1' },
    ],
  }), 'http://127.0.0.1:3001');
  assert.deepEqual(devices.map(item => item.name), ['当前设备', 'jx88']);
});

test('readDevices 容忍坏 JSON', () => {
  assert.deepEqual(readDevices('not json', 'http://127.0.0.1:3001').map(item => item.origin), ['http://127.0.0.1:3001']);
});

// ---- 端到端 ----

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const fakeBackend = label => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    backend: label,
    url: req.url,
    host: req.headers.host,
    forwardedHost: req.headers['x-forwarded-host'] || null,
    forwardedProto: req.headers['x-forwarded-proto'] || null,
  }));
};

async function withGateway(run) {
  const distDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-dist-'));
  await fsp.writeFile(path.join(distDir, 'index.html'), '<html><head><title>PilotV</title></head><body>ok</body></html>');
  await fsp.writeFile(path.join(distDir, 'devices.json'), '{"devices":[]}');
  const a = await listen(fakeBackend('A'));
  const b = await listen(fakeBackend('B'));
  const console = await listen(fakeBackend('LOCAL-CONSOLE'));
  const originA = `http://127.0.0.1:${a.port}`;
  const originB = `http://127.0.0.1:${b.port}`;
  const registryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-reg-'));
  const c = await listen(fakeBackend('C'));
  const originC = `http://127.0.0.1:${c.port}`;
  const baseDevices = [
    { name: 'A机', origin: originA, backend: originA, artifactsPort: console.port },
    { name: 'B机', origin: originB, backend: originB, artifactsPort: console.port },
  ];
  const gatewayConfig = {
    distDir,
    devices: baseDevices,
    // C 不在基线里：它就是「用户在界面上现加的那台」。
    registry: new DeviceRegistry(path.join(registryDir, 'devices.local.json'), baseDevices),
    allowRegistryWrites: true,
    // 设备写操作的会话密钥。测试里的 send() 默认带上等值的 Bearer 令牌，
    // 模拟「已经通过首页拿到会话的客户端」。
    adminSecret: TEST_ADMIN_SECRET,
    defaultBackend: originA,
    artifactsTarget: `http://127.0.0.1:${console.port}`,
    artifactsPerDevice: true,
  };
  const gateway = createGateway(gatewayConfig);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const port = gateway.address().port;
  const get = (pathname, headers) => new Promise(resolve => {

    http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', error => resolve({ status: 0, body: error.message }));
  });
  // 默认带上管理员令牌 —— 大多数用例关心的是写操作之后的行为，不是鉴权本身。
  // 鉴权单独有用例覆盖；显式传 admin: false 可以关掉它。
  const send = (method, pathname, payload, headers, admin = true) => new Promise(resolve => {
    const auth = admin
      ? { authorization: `Bearer ${adminTokenFor(TEST_ADMIN_SECRET)}` }
      : {};
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, ...auth, ...headers } },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    request.on('error', error => resolve({ status: 0, body: error.message }));
    if (payload) request.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    request.end();
  });
  try { await run({ get, send, distDir, originA, originB, originC, consolePort: console.port, port, registry: gatewayConfig.registry, adminSecret: TEST_ADMIN_SECRET }); }
  finally {
    await new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); });
    await new Promise(resolve => { a.server.closeAllConnections(); a.server.close(resolve); });
    await new Promise(resolve => { b.server.closeAllConnections(); b.server.close(resolve); });
    await new Promise(resolve => { c.server.closeAllConnections(); c.server.close(resolve); });
    await new Promise(resolve => { console.server.closeAllConnections(); console.server.close(resolve); });
    await fsp.rm(distDir, { recursive: true, force: true });
  }
}

test('同一个入口按 ?d= 切到不同后端', async () => {
  await withGateway(async ({ get, originA, originB }) => {
    const first = await get('/api/projects');
    assert.equal(JSON.parse(first.body).backend, 'A');

    // 文档请求带上 ?d= 就会记住新设备，并把运行时信息注入页面。
    const switched = await get('/?d=' + encodeURIComponent(originB));
    assert.match(switched.headers['set-cookie'][0], new RegExp(`${DEVICE_COOKIE}=${encodeURIComponent(originB)}`));
    assert.match(switched.body, new RegExp(`window.__PILOTV__={"backend":"${originB.replace(/[/.]/g, '\\$&')}"`));

    // 记住之后，不带参数的 /api 也命中 B。
    const remembered = await get('/api/projects', { cookie: switched.headers['set-cookie'][0].split(';')[0] });
    assert.equal(JSON.parse(remembered.body).backend, 'B');
    assert.equal(JSON.parse(remembered.body).host, new URL(originB).host, '转发时应改写 Host');

    // 陌生设备不会变成开放代理：安静回落到默认后端，也不写设备 Cookie。
    // 首页现在无条件种一个 pdv_admin 会话 Cookie（设备写操作的凭据，与设备
    // 选择无关），所以这里查的是「有没有写 pdv_backend」，而不是整个响应头。
    const unknown = await get('/?d=http://127.0.0.1:1');
    assert.match(unknown.body, new RegExp(`window.__PILOTV__={"backend":"${originA.replace(/[/.]/g, '\\$&')}"`));
    const unknownCookies = [].concat(unknown.headers['set-cookie'] || []);
    assert.equal(unknownCookies.some(value => value.startsWith(`${DEVICE_COOKIE}=`)), false);
    assert.equal(unknownCookies.some(value => value.startsWith(`${ADMIN_COOKIE}=`)), true,
      '首页应当种下设备写操作的会话 Cookie');
    assert.equal(unknown.body.includes('unknownDevice":true'), true);
  });
});

test('成果台路由跟着设备走，与通用 /api 分开', async () => {
  await withGateway(async ({ get, send, originA, originB, originC, consolePort, port }) => {
    // 本机（包括选中本机自己）走本机成果台。
    assert.equal(JSON.parse((await get('/api/artifacts')).body).backend, 'LOCAL-CONSOLE');
    assert.equal(JSON.parse((await get('/api/artifacts', { cookie: `${DEVICE_COOKIE}=${originA}` })).body).backend, 'LOCAL-CONSOLE');
    assert.equal(JSON.parse((await get('/api/artifacts/abc')).body).backend, 'LOCAL-CONSOLE');
    // 通用 /api 不受影响，始终跟着设备走。
    assert.equal(JSON.parse((await get('/api/projects')).body).backend, 'A');

    // 装了自己成果台的远端设备：请求要发到它的成果台端口（这里指到假成果台），
    // 而不是它的 3001——那边只会回 B，证明请求没走错地方。
    await send('POST', '/api/pilotv/devices', { name: 'B机-装成果台', origin: originB, artifactsPort: consolePort },
      { origin: `http://127.0.0.1:${port}` });
    const viaSidecar = await get('/api/artifacts', { cookie: `${DEVICE_COOKIE}=${originB}` });
    assert.equal(JSON.parse(viaSidecar.body).backend, 'LOCAL-CONSOLE');

    // 没部署成果台的设备：如实回 503，不要甩到它的 3001 上去换一个来路不明的 404。
    await send('POST', '/api/pilotv/devices', { name: 'C机-没成果台', origin: originC },
      { origin: `http://127.0.0.1:${port}` });
    const missing = await get('/api/artifacts', { cookie: `${DEVICE_COOKIE}=${originC}` });
    assert.equal(missing.status, 503);
    assert.equal(JSON.parse(missing.body).error, 'device-has-no-artifacts');
  });
});

test('转发时带上公网地址，成果台才知道链接该发给谁', async () => {
  await withGateway(async ({ send, port }) => {
    // Host 被改写成上游地址是代理的常规做法，但也因此丢了「用户是从哪个入口来的」。
    // 成果台要靠转发头把评审链接指回 PilotV 前端，不然发出来的是 8799 的 JSON 页。
    const response = await send('GET', '/api/artifacts', null, { host: `pilotv.example:${port}` });
    const payload = JSON.parse(response.body);
    assert.equal(payload.forwardedHost, `pilotv.example:${port}`);
    assert.equal(payload.forwardedProto, 'http');
    // 客户端自己带的转发头要被覆盖，不能让人伪造公网地址。
    const spoofed = await send('GET', '/api/artifacts', null, { host: `pilotv.example:${port}`, 'x-forwarded-host': 'evil.example' });
    assert.equal(JSON.parse(spoofed.body).forwardedHost, `pilotv.example:${port}`);
  });
});

test('静态资源、SPA 回退与目录穿越', async () => {
  await withGateway(async ({ get, distDir, originB }) => {
    assert.equal((await get('/devices.json')).status, 200);
    const deep = await get('/settings/general');
    assert.match(deep.body, /PilotV/);
    // 前端路由回退也必须注入运行时信息：漏掉一次，深链刷新就会丢掉当前设备。
    assert.match(deep.body, /window\.__PILOTV__=/);
    const deepOnDevice = await get('/p/general', { cookie: `${DEVICE_COOKIE}=${originB}` });
    assert.match(deepOnDevice.body, new RegExp(`window\\.__PILOTV__=\\{"backend":"${originB.replace(/[/.]/g, '\\$&')}"`));
    assert.equal((await get('/missing.js')).status, 404);
    // 穿越只会被当成前端路由回落到 index.html，不会读到 dist 之外的文件。
    const traversal = await get('/../../../../etc/passwd');
    assert.equal(traversal.body.includes('root:'), false);
    assert.match(traversal.body, /PilotV/);
    assert.equal(fs.existsSync(distDir), true);
  });
});

test('WebSocket upgrade 按当前设备转发', async () => {
  const seen = [];
  const upstreamSockets = [];
  const wss = http.createServer();
  wss.on('upgrade', (req, socket) => {
    seen.push(req.url);
    upstreamSockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write('hi-from-remote');
  });
  await new Promise(resolve => wss.listen(0, '127.0.0.1', resolve));
  const wsPort = wss.address().port;
  const origin = `http://127.0.0.1:${wsPort}`;
  const distDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-ws-'));
  await fsp.writeFile(path.join(distDir, 'index.html'), '<html><head></head></html>');
  const gateway = createGateway({
    distDir, devices: [{ name: 'WS机', origin, backend: origin }],
    defaultBackend: origin, artifactsTarget: origin, artifactsPerDevice: true,
  });
  // upgrade 之后的连接不再受 closeAllConnections 管辖，得自己收。
  const gatewaySockets = [];
  gateway.on('connection', socket => gatewaySockets.push(socket));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));

  const payload = await new Promise((resolve, reject) => {
    const socket = net.connect(gateway.address().port, '127.0.0.1', () => {
      socket.write('GET /ws?token=abc HTTP/1.1\r\nHost: pilotv.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let data = '';
    socket.on('data', chunk => { data += chunk; if (data.includes('hi-from-remote')) { socket.destroy(); resolve(data); } });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 4000).unref();
  });

  assert.match(payload, /101 Switching Protocols/);
  assert.match(payload, /hi-from-remote/);
  assert.deepEqual(seen, ['/ws?token=abc']);

  for (const socket of gatewaySockets) socket.destroy();
  for (const socket of upstreamSockets) socket.destroy();
  await new Promise(resolve => gateway.close(resolve));
  await new Promise(resolve => wss.close(resolve));
  await fsp.rm(distDir, { recursive: true, force: true });
});
// ── 服务端设备注册表 ────────────────────────────────────────────────

test('只放行内网地址，云元数据和公网地址都不行', () => {
  assert.equal(isPrivateHost('100.72.0.111'), true);      // Tailscale
  assert.equal(isPrivateHost('192.168.1.20'), true);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('172.16.0.9'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('169.254.169.254'), false);  // 云元数据，绝不能代理
  assert.equal(isPrivateHost('169.254.1.1'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(isPrivateHost('172.32.0.1'), false);       // 172.16/12 之外
});

test('校验设备地址：必须写明端口且必须是内网', () => {
  assert.equal(validateDeviceTarget('http://100.72.0.111:3001').ok, true);
  assert.equal(validateDeviceTarget('http://100.72.0.111').ok, false);          // 缺端口
  assert.equal(validateDeviceTarget('http://169.254.169.254:80').ok, false);    // 元数据
  assert.equal(validateDeviceTarget('http://example.com:3001').ok, false);       // 域名
  assert.equal(validateDeviceTarget('file:///etc/passwd').ok, false);
  assert.equal(validateDeviceTarget('  ').ok, false);
});

test('校验设备名', () => {
  assert.deepEqual(normalizeDeviceName('  我的   NAS  '), { ok: true, name: '我的 NAS' });
  assert.equal(normalizeDeviceName('   ').ok, false);
  assert.equal(normalizeDeviceName('x'.repeat(65)).ok, false);
});

test('注册表覆盖预置设备的名字、增删设备', () => {
  const base = [
    { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001', backend: 'http://100.72.0.111:3001' },
    { name: 'leo-mac-studio', origin: 'http://100.117.103.34:3001', backend: 'http://100.117.103.34:3001' },
  ];
  const merged = mergeRegistry(base, {
    added: [{ name: '书房机器', origin: 'http://192.168.1.30:3001' }],
    renamed: { 'http://100.72.0.111:3001': 'Marc 的 PC' },
    hidden: ['http://100.117.103.34:3001'],
  });
  assert.deepEqual(merged.map(device => device.name), ['Marc 的 PC', '书房机器']);
});

test('注册表文件损坏时退回空清单，不影响启动', () => {
  const file = path.join(os.tmpdir(), `pilotv-broken-${process.pid}.json`);
  fs.writeFileSync(file, '{ 这不是 json');
  assert.deepEqual(readRegistryFile(file), { added: [], renamed: {}, hidden: [] });
  fs.rmSync(file, { force: true });
});

test('切换设备后，浏览器加的设备也能被代理到（原来会回落本机）', async () => {
  await withGateway(async ({ get, send, originA, originB, originC, port }) => {
    const created = await send('POST', '/api/pilotv/devices', { name: '书房机器', origin: originC });
    assert.equal(created.status, 200);
    assert.deepEqual(JSON.parse(created.body).devices.map(device => device.name).sort(), ['A机', 'B机', '书房机器']);

    // 关键：它不在构建产物里，但网关现在认它了。
    const proxied = await get('/api/projects', { [DEVICE_HEADER]: originC });
    assert.equal(JSON.parse(proxied.body).backend, 'C');
  });
});

test('新增设备要同源，且拒绝公网和元数据地址', async () => {
  await withGateway(async ({ send, port }) => {
    const cross = await send('POST', '/api/pilotv/devices', { name: 'x', origin: 'http://192.168.1.5:3001' },
      { origin: 'http://evil.example.com', 'content-type': 'application/json' });
    assert.equal(cross.status, 403);

    const publicTarget = await send('POST', '/api/pilotv/devices', { name: '外网', origin: 'http://8.8.8.8:80' },
      { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });
    assert.equal(publicTarget.status, 400);
    assert.match(JSON.parse(publicTarget.body).error, /不是内网地址/);

    const metadata = await send('POST', '/api/pilotv/devices', { name: '元数据', origin: 'http://169.254.169.254:80' },
      { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });
    assert.equal(metadata.status, 400);

    const noPort = await send('POST', '/api/pilotv/devices', { name: '没端口', origin: 'http://192.168.1.5' },
      { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });
    assert.equal(noPort.status, 400);
  });
});

test('改名和删除会同步给别的浏览器', async () => {
  await withGateway(async ({ send, port, originC }) => {
    await send('POST', '/api/pilotv/devices', { name: 'B机', origin: originC },
      { origin: `http://127.0.0.1:${port}` });
    const renamed = await send('POST', '/api/pilotv/devices', { name: '家里的 jx88', origin: originC },
      { origin: `http://127.0.0.1:${port}` });
    assert.equal(JSON.parse(renamed.body).devices.some(d => d.name === '家里的 jx88'), true);

    // 另一个浏览器（没有 Cookie、没有 localStorage）应该直接看到新名字。
    const listed = await send('GET', '/api/pilotv/devices');
    assert.equal(JSON.parse(listed.body).devices.some(d => d.name === '家里的 jx88'), true);

    const deleted = await send('DELETE', `/api/pilotv/devices?origin=${originC}`, null,
      { origin: `http://127.0.0.1:${port}` });
    assert.equal(JSON.parse(deleted.body).devices.some(d => d.origin === originC), false);
  });
});

// 写进去却没生效的改名必须当场被拒。旧版本照回 200，浏览器于是关掉窗口，
// 名字纹丝不动——这就是「改完保存不了」最像的一种：请求成功，改动没了。
test('改名没落进清单时接口自己报错，而不是回一个假的成功', async () => {
  await withGateway(async ({ send, port, registry }) => {
    // 让清单「假装没收到这次改名」，重现真正的故障现场。
    const readDevices = registry.devices.bind(registry);
    registry.devices = () => readDevices().map(device =>
      device.origin === 'http://100.108.86.109:3001' ? { ...device, name: '旧名字' } : device);

    const res = await send('POST', '/api/pilotv/devices', { name: '机房的 jx88', origin: 'http://100.108.86.109:3001' },
      { origin: `http://127.0.0.1:${port}` });
    assert.equal(res.status, 409);
    const body = JSON.parse(res.body);
    assert.match(body.error, /机房的 jx88/);
    // 回给浏览器的清单仍然是旧样子，别让它以为改成了。
    assert.equal(body.devices.some(d => d.name === '机房的 jx88'), false);

    registry.devices = readDevices;
    const ok = await send('POST', '/api/pilotv/devices', { name: '机房的 jx88', origin: 'http://100.108.86.109:3001' },
      { origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).devices.some(d => d.name === '机房的 jx88'), true);
  });
});

test('保存时清掉对不上任何设备的改名残骸', () => {
  const base = [{ name: 'jx88', origin: 'http://100.108.86.109:3001' }];
  const pruned = pruneDeadRenames({
    added: [{ name: '新机器', origin: 'http://100.72.9.9:3001' }],
    renamed: {
      'http://100.108.86.109:3001': '改过的 jx88',
      'http://100.72.9.9:3001': '改过的新机器',
      'http://100.117.103.34:3001': '端口改前的名字',
    },
  }, base);
  assert.deepEqual(pruned, {
    'http://100.108.86.109:3001': '改过的 jx88',
    'http://100.72.9.9:3001': '改过的新机器',
  });
});

test('同一份设备清单只允许一个网关进程在用', async () => {
  const registryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-lock-'));
  const registryFile = path.join(registryDir, 'devices.local.json');
  const lockFile = `${registryFile}.lock`;

  const mine = claimRegistryLock(registryFile);
  assert.equal(fs.readFileSync(lockFile, 'utf-8').trim(), String(process.pid));
  mine.release();
  assert.equal(fs.existsSync(lockFile), false);

  // 另一个活着的网关正拿着这份清单：新的这个必须起不来。
  const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  await new Promise(resolve => alive.once('spawn', resolve));
  fs.writeFileSync(lockFile, `${alive.pid}\n`);
  assert.throws(() => claimRegistryLock(registryFile), new RegExp(String(alive.pid)));
  alive.kill();
  await new Promise(resolve => alive.once('exit', resolve));

  // 进程早就没了的残锁不该把启动堵死。
  fs.writeFileSync(lockFile, `${alive.pid}\n`);
  const takeover = claimRegistryLock(registryFile);
  assert.equal(fs.readFileSync(lockFile, 'utf-8').trim(), String(process.pid));
  takeover.release();
});

// ── 多标签隔离 ────────────────────────────────────────────────────

test('请求头决定设备，优先于共享的 Cookie', () => {
  const config = { devices: DEVICES, defaultBackend: 'http://127.0.0.1:3001' };
  const backend = resolveBackend({
    url: '/api/projects',
    headers: { [DEVICE_HEADER]: 'http://100.108.86.109:3001', cookie: `${DEVICE_COOKIE}=http%3A%2F%2F100.72.0.111%3A3001` },
  }, config);
  assert.equal(backend.origin, 'http://100.108.86.109:3001');
  assert.equal(backend.source, 'header');
});

test('两个标签页各连一台设备，不会互相干扰', () => {
  const config = { devices: DEVICES, defaultBackend: 'http://127.0.0.1:3001' };
  // Cookie 停在 B 上（标签页 A 刚切过），但两个标签页的请求头各自说各话。
  const cookie = { cookie: `${DEVICE_COOKIE}=http%3A%2F%2F100.117.103.34%3A3001` };
  const tabA = resolveBackend({ url: '/api/projects', headers: { ...cookie, [DEVICE_HEADER]: 'http://100.72.0.111:3001' } }, config);
  const tabB = resolveBackend({ url: '/api/projects', headers: { ...cookie, [DEVICE_HEADER]: 'http://100.108.86.109:3001' } }, config);
  assert.equal(tabA.origin, 'http://100.72.0.111:3001');
  assert.equal(tabB.origin, 'http://100.108.86.109:3001');
});

test('请求头里的陌生地址不会被代理', () => {
  const backend = resolveBackend({
    url: '/api/projects',
    headers: { [DEVICE_HEADER]: 'http://169.254.169.254:80' },
  }, { devices: DEVICES, defaultBackend: 'http://127.0.0.1:3001' });
  assert.equal(backend.origin, 'http://127.0.0.1:3001');
  assert.equal(backend.source, 'default');
});

test('Cookie 仍然兜底：命令行和没有 JS 的客户端还能用', () => {
  const backend = resolveBackend({
    url: '/api/projects',
    headers: { cookie: `${DEVICE_COOKIE}=http%3A%2F%2F100.108.86.109%3A3001` },
  }, { devices: DEVICES, defaultBackend: 'http://127.0.0.1:3001' });
  assert.equal(backend.origin, 'http://100.108.86.109:3001');
  assert.equal(backend.source, 'cookie');
});

// ── 安全回归 ──────────────────────────────────────────────────────────
// 下面每条都对应一次审查发现，改坏了会立刻红。

test('设备写操作必须带会话凭据：裸客户端加不了设备', async () => {
  await withGateway(async ({ send, registry, originC, port }) => {
    const before = registry.devices().length;

    // 没有 Cookie、没有令牌 —— 这正是以前的 curl 能直接改清单的姿势。
    const anonymous = await send('POST', '/api/pilotv/devices', { name: '偷偷加的', origin: originC },
      { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, false);
    assert.equal(anonymous.status, 401);
    assert.equal(registry.devices().length, before, '被拒的请求不能改动设备清单');

    // 令牌写错一样不行。
    const wrong = await send('POST', '/api/pilotv/devices', { name: '偷偷加的', origin: originC },
      { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json',
        authorization: 'Bearer wrong-secret' });
    assert.equal(wrong.status, 401);

    // 带上首页种的那个会话 Cookie 就该通过 —— 浏览器界面正是这条路。
    const viaCookie = await send('POST', '/api/pilotv/devices', { name: '界面加的', origin: originC },
      { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json',
        cookie: `${ADMIN_COOKIE}=${adminTokenFor(TEST_ADMIN_SECRET)}` }, false);
    assert.equal(viaCookie.status, 200);
    assert.equal(registry.devices().some(d => d.name === '界面加的'), true);
  });
});

test('跨站请求即使拿着会话 Cookie 也被拒', async () => {
  await withGateway(async ({ send, originC, port }) => {
    const cross = await send('POST', '/api/pilotv/devices', { name: '跨站的', origin: originC },
      { origin: 'http://evil.example.com', 'content-type': 'application/json' });
    assert.equal(cross.status, 403, '令牌不能替代同源检查');
  });
});

test('verifyAdmin 只认等值签名', () => {
  const config = { adminSecret: 'secret-a' };
  const good = adminTokenFor('secret-a');
  assert.equal(verifyAdmin({ headers: { authorization: `Bearer ${good}` } }, config), true);
  assert.equal(verifyAdmin({ headers: { cookie: `${ADMIN_COOKIE}=${good}` } }, config), true);
  assert.equal(verifyAdmin({ headers: { authorization: `Bearer ${adminTokenFor('secret-b')}` } }, config), false);
  assert.equal(verifyAdmin({ headers: { authorization: 'Bearer secret-a' } }, config), false, '不能直接拿密钥当令牌');
  assert.equal(verifyAdmin({ headers: {} }, config), false);
  assert.equal(verifyAdmin({ headers: { authorization: `Bearer ${good}` } }, { adminSecret: '' }), false,
    '没配密钥时一律拒绝，不能退化成放行');
});

test('畸形 Cookie 不会把请求处理带崩', () => {
  // 单独一个 '%' 或截断的 %E4 都会让 decodeURIComponent 抛 URIError。
  assert.equal(readCookie('pdv_backend=%', DEVICE_COOKIE), '%');
  assert.equal(readCookie('pdv_backend=%E4', DEVICE_COOKIE), '%E4');
  assert.equal(readCookie('pdv_backend=%zz', DEVICE_COOKIE), '%zz');
  // 正常值照旧能解。
  assert.equal(readCookie('pdv_backend=http%3A%2F%2F100.1.1.1%3A3001', DEVICE_COOKIE), 'http://100.1.1.1:3001');
});

test('WebSocket 升级只放行 /ws 和 /shell', async () => {
  // 路由分类层面就要拦住：不是 socket 的路径连升级都不该考虑。
  assert.equal(classifyPath('/ws'), 'socket');
  assert.equal(classifyPath('/shell'), 'socket');
  assert.equal(classifyPath('/api/projects'), 'backend');
  assert.equal(classifyPath('/'), 'static');
});

test('端到端：非 socket 路径的升级请求拿不到隧道', async () => {
  await withGateway(async ({ port, originB }) => {
    // 直接发一个 upgrade 握手。路径不是 /ws 或 /shell，网关应当自己回 404，
    // 而不是把这条连接原样接到上游去 —— 这正是审查发现的绕过口。
    const attempt = async pathname => new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `GET ${pathname} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let raw = '';
      socket.setTimeout(3000, () => { socket.destroy(); resolve({ raw, closed: true }); });
      socket.on('data', chunk => {
        raw += chunk.toString('utf-8');
        if (raw.includes('\r\n\r\n')) { socket.destroy(); resolve({ raw, closed: false }); }
      });
      socket.on('error', () => resolve({ raw, closed: true }));
    });

    const denied = await attempt('/api/projects');
    assert.match(denied.raw, /^HTTP\/1\.1 404/, `不该隧道的路径应被拒，实得：${denied.raw.split('\r\n')[0]}`);

    // 带 Origin 的跨站握手同样要挡住。
    const crossOrigin = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /ws HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Origin: http://evil.example.com\r\n' +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let raw = '';
      socket.setTimeout(3000, () => { socket.destroy(); resolve({ raw }); });
      socket.on('data', chunk => {
        raw += chunk.toString('utf-8');
        if (raw.includes('\r\n\r\n')) { socket.destroy(); resolve({ raw }); }
      });
      socket.on('error', () => resolve({ raw }));
    });
    assert.match(crossOrigin.raw, /^HTTP\/1\.1 403/, `跨站升级应被拒，实得：${crossOrigin.raw.split('\r\n')[0]}`);
    assert.ok(originB);
  });
});

// --- HTTPS ------------------------------------------------------------------
//
// 安卓 Chrome 只在安全上下文里注册 Service Worker、才给「安装桌面应用」入口。
// 局域网 http://192.168.x.x:5186 不是安全上下文，SW 注册直接失败，浏览器永远
// 不给安装入口 —— manifest 写得再对都没用。所以网关必须真的能起 https。

/** 生成一份临时自签证书（测试用，不做任何信任设置）。 */
function makeSelfSigned(dir) {
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { key, cert };
}

test('readTlsOptions: 两项齐全才启用 HTTPS，只给一半直接报错', () => {
  assert.equal(readTlsOptions({}), null);
  assert.equal(readTlsOptions({ PILOTV_TLS_CERT: '', PILOTV_TLS_KEY: '' }), null);
  // 半 TLS 半明文比干脆不加密更难排查，所以必须拒绝启动而不是降级。
  assert.throws(() => readTlsOptions({ PILOTV_TLS_CERT: '/tmp/x.pem' }), /必须同时设置/);
  assert.throws(() => readTlsOptions({ PILOTV_TLS_KEY: '/tmp/x.pem' }), /必须同时设置/);
  // 文件不存在也要报错，不能等到握手时才崩。
  assert.throws(() => readTlsOptions({ PILOTV_TLS_CERT: '/no/such.pem', PILOTV_TLS_KEY: '/no/such.pem' }), /PILOTV_TLS_CERT 不存在/);
});

test('readTlsOptions: 证书齐全时把内容读出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-tls-'));
  try {
    const paths = makeSelfSigned(dir);
    const tls = readTlsOptions({ PILOTV_TLS_CERT: paths.cert, PILOTV_TLS_KEY: paths.key });
    assert.ok(Buffer.isBuffer(tls.cert) && tls.cert.length > 0);
    assert.ok(Buffer.isBuffer(tls.key) && tls.key.length > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('端到端：配了证书的网关真的用 https 应答，并带上 HSTS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-tls-'));
  const distDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-dist-'));
  try {
    await fsp.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>PilotV</title>');
    const paths = makeSelfSigned(dir);
    const gateway = createGateway({
      distDir,
      devices: [],
      registry: null,
      registryFile: path.join(dir, 'devices.json'),
      adminSecret: TEST_ADMIN_SECRET,
      allowRegistryWrites: false,
      defaultBackend: 'http://127.0.0.1:3001',
      artifactsTarget: 'http://127.0.0.1:8799',
      artifactsPerDevice: true,
      tls: readTlsOptions({ PILOTV_TLS_CERT: paths.cert, PILOTV_TLS_KEY: paths.key }),
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const port = gateway.address().port;

    const res = await new Promise(resolve => {
      const request = https.get(
        { host: '127.0.0.1', port, path: '/', rejectUnauthorized: false,
          headers: { host: `127.0.0.1:${port}` } },
        r => { r.resume(); resolve(r); },
      );
      request.on('error', error => resolve({ error }));
    });
    assert.ok(!res.error, `https 握手应成功：${res.error?.message}`);
    assert.equal(res.statusCode, 200);
    // HSTS：让浏览器别把这个源降级回 http，否则用户手输 http:// 会以为服务挂了。
    assert.equal(res.headers['strict-transport-security'], 'max-age=31536000');

    // 明文端口必须不再是可用的 HTTP 服务 —— 否则等于给了个降级入口。
    // TLS 服务器握手失败时直接断开、**一个字节都不回**，所以必须监听 close：
    // 只等 data/error 的话 socket 被对端销毁后没有任何事件，这个 Promise 永远不落定。
    const plain = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      let raw = '';
      const done = () => { socket.destroy(); resolve(raw); };
      socket.setTimeout(3000, done);
      socket.on('data', chunk => { raw += chunk.toString('utf-8'); done(); });
      socket.on('error', done);
      socket.on('close', () => resolve(raw));
    });
    assert.doesNotMatch(plain, /^HTTP\/1\.1 200/, '明文请求不该拿到正常响应');
    await new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(distDir, { recursive: true, force: true });
  }
});

test('没配证书时网关仍然是 http（不因为新增 TLS 支持就改默认行为）', async () => {
  const distDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-dist-'));
  try {
    await fsp.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>PilotV</title>');
    const gateway = createGateway({
      distDir, devices: [], registry: null, registryFile: path.join(distDir, 'devices.json'),
      adminSecret: TEST_ADMIN_SECRET, allowRegistryWrites: false,
      defaultBackend: 'http://127.0.0.1:3001',
      artifactsTarget: 'http://127.0.0.1:8799', artifactsPerDevice: true,
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const port = gateway.address().port;
    const res = await new Promise(resolve => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` } }, r => {
        r.resume(); resolve(r);
      }).on('error', error => resolve({ error }));
    });
    assert.ok(!res.error, `http 应仍可用：${res.error?.message}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['strict-transport-security'], undefined);
    await new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); });
  } finally { await fsp.rm(distDir, { recursive: true, force: true }); }
});
