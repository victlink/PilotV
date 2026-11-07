import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decideUnknownDevice, parseDeviceManifest, readDeviceManifest, syncDeviceManifest, syncDeviceManifestSync } from './deviceManifest.mjs';

const tempDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-devices-'));

test('正常清单：解析出设备，带 artifactsPort', () => {
  const { devices, problems } = parseDeviceManifest(JSON.stringify({
    devices: [
      { name: 'marc-pc', origin: 'https://marc.tail.ts.net:3001', artifactsPort: 8799 },
      { name: 'jx88', origin: 'http://100.108.86.109:3001' },
    ],
  }));
  assert.equal(problems.length, 0);
  assert.deepEqual(devices.map(device => device.origin),
    ['https://marc.tail.ts.net:3001', 'http://100.108.86.109:3001']);
  assert.equal(devices[0].artifactsPort, 8799);
  assert.equal(devices[1].artifactsPort, undefined);
  assert.equal(devices[0].backend, devices[0].origin, 'backend 要一起填好，网关按它转发');
});

test('带路径/查询串的 origin 会被规范化成 origin', () => {
  const { devices, problems } = parseDeviceManifest(JSON.stringify(
    [{ name: 'a', origin: 'https://host:3001/p/xyz?d=1' }],
  ));
  assert.equal(problems.length, 0);
  assert.equal(devices[0].origin, 'https://host:3001');
});

test('JSON 语法错：给的是能定位的问题，不是空清单', () => {
  const { devices, problems } = parseDeviceManifest('{ devices: [');
  assert.deepEqual(devices, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /JSON 语法错误/);
});

test('结构不对（既不是数组也没有 devices）也能说清楚', () => {
  assert.match(parseDeviceManifest('{"hosts":[]}').problems[0], /既不是数组也没有 devices/);
  assert.match(parseDeviceManifest('').problems[0], /内容为空/);
  assert.match(parseDeviceManifest('   ').problems[0], /内容为空/);
});

test('模板占位符必须被点名：带着 REPLACE_ 上线等于把「没配」伪装成「配好了」', () => {
  const { devices, problems } = parseDeviceManifest(JSON.stringify({
    devices: [
      { name: 'REPLACE_WITH_DEVICE_NAME', origin: 'http://REPLACE_TAILSCALE_IP:3001' },
      { name: 'ok-device', origin: 'https://ok.example:3001' },
    ],
  }));
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'ok-device');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /模板占位符/);
});

test('坏条目逐条报，不整批静默丢弃', () => {
  const { devices, problems } = parseDeviceManifest(JSON.stringify({
    devices: [
      { name: '', origin: 'https://a:3001' },
      { name: 'b' },
      { name: 'c', origin: 'not-a-url' },
      { name: 'd', origin: 'ftp://d:21' },
      { name: 'e', origin: 'https://e:3001', artifactsPort: 70000 },
      { name: 'f', origin: 'https://f:3001' },
      { name: 'dup', origin: 'https://f:3001' },
    ],
  }));
  // e 的 artifactsPort 非法，但设备本身仍可连：保留设备、只丢端口并报告问题。
  // 把整台设备判死会让人完全切不过去，那比「没有成果台」糟得多。
  assert.deepEqual(devices.map(device => device.name), ['e', 'f']);
  assert.equal(devices[0].artifactsPort, undefined);
  assert.equal(problems.length, 6, '每一条坏数据都该有一条问题');
  assert.match(problems.join('\n'), /缺少 name 或 origin/);
  assert.match(problems.join('\n'), /不是合法 URL/);
  assert.match(problems.join('\n'), /协议必须是 http\/https/);
  assert.match(problems.join('\n'), /artifactsPort 不是有效端口/);
  assert.match(problems.join('\n'), /origin 重复/);
});

test('空清单是问题而不是「一切正常」', () => {
  const { problems } = parseDeviceManifest('{"devices":[]}');
  assert.match(problems[0], /清单是空的/);
});

test('readDeviceManifest：文件不存在要说读不到，而不是给一个空清单', () => {
  const { problems } = readDeviceManifest(path.join(os.tmpdir(), 'pilotv-no-such-devices.json'));
  assert.match(problems[0], /读不到/);
});

test('同步：把 public 规范化写进 dist', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({
      devices: [{ name: 'a', origin: 'https://a.example:3001', artifactsPort: 8799 }],
    }));
    const result = await syncDeviceManifest(source, target);
    assert.equal(result.synced, true);
    const written = JSON.parse(await fsp.readFile(target, 'utf-8'));
    assert.deepEqual(written.devices, [{ name: 'a', origin: 'https://a.example:3001', artifactsPort: 8799 }]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('同步：内容等价时不写盘（避免每次启动都让前端缓存失效）', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    const payload = JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] });
    await fsp.writeFile(source, payload);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, payload.replace('{"devices":', '{\n  "devices": '));
    const result = await syncDeviceManifest(source, target);
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'already-in-sync');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('同步：源清单有问题时绝不写盘（不把坏配置扩散到前端）', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, '{"devices":[{"name":"a"}]}');
    const result = await syncDeviceManifest(source, target);
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'source-invalid');
    assert.equal(fs.existsSync(target), false, '坏清单不该被同步出去');
    assert.ok(result.problems.length > 0, '要带着原因回来');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('同步：dist 里是坏 JSON 时会被覆盖掉', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] }));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, '{"devices": [ 坏掉的');
    const result = await syncDeviceManifest(source, target);
    assert.equal(result.synced, true, '坏的目标文件正是同步要修的坏状态');
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf-8')).devices,
      [{ name: 'a', origin: 'https://a:3001' }]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('同步不留临时文件（原子写）', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] }));
    await syncDeviceManifest(source, target);
    const leftovers = fs.readdirSync(path.dirname(target)).filter(name => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('同步失败要如实回报，不假装成功', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] }));
    // 把目标位置占成一个目录，rename 必然失败。
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.mkdir(target, { recursive: true });
    const result = await syncDeviceManifest(source, target);
    assert.equal(result.synced, false);
    assert.match(result.reason, /^write-failed:/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('?d= 指向未知设备：显式报错并列出可用清单', () => {
  const devices = [{ origin: 'https://a:3001' }, { origin: 'https://b:3001' }];
  const decision = decideUnknownDevice('http://127.0.0.1:1', devices, { source: 'query' });
  assert.equal(decision.mode, 'error');
  assert.match(decision.problem, /清单里没有这台设备/);
  assert.match(decision.problem, /http:\/\/127\.0\.0\.1:1/);
  assert.match(decision.problem, /https:\/\/a:3001, https:\/\/b:3001/);
  assert.equal(decision.origin, undefined, '报错时绝不能给一个可转发的 origin');
});

test('Cookie/头里的陌生地址：带着原因回落本机，而不是把人锁死', () => {
  const decision = decideUnknownDevice('http://old-name:3001', [{ origin: 'https://a:3001' }],
    { source: 'cookie', defaultOrigin: 'http://127.0.0.1:3001' });
  assert.equal(decision.mode, 'resolve');
  assert.equal(decision.origin, 'http://127.0.0.1:3001');
  assert.equal(decision.problem, 'stale-selection:http://old-name:3001',
    '回落可以，但原因必须留下，否则又是「切不过去且没原因」');
});

test('陌生地址永远不会被当成可转发目标（安全边界不因报错而松动）', () => {
  const attempts = ['http://169.254.169.254:80', 'http://evil.example', 'https://attacker:9999'];
  for (const raw of attempts) {
    const decision = decideUnknownDevice(raw, [{ origin: 'https://a:3001' }], { source: 'query' });
    assert.equal(decision.mode, 'error');
    assert.equal(decision.origin, undefined, `${raw} 不得成为转发目标`);
  }
});


test('启动同步：dist 还没构建出来时报 dist-missing，不越权替 vite 建目录', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] }));
    const result = syncDeviceManifestSync(source, target);
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'dist-missing');
    assert.equal(fs.existsSync(path.join(dir, 'dist')), false);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('启动同步：显式授权建目录时才创建（部署脚本路径）', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] }));
    const result = syncDeviceManifestSync(source, target, { createTargetDir: true });
    assert.equal(result.synced, true);
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf-8')).devices,
      [{ name: 'a', origin: 'https://a:3001' }]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('启动同步：内容等价就不写盘（否则每次重启都让前端缓存失效）', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    const payload = JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] });
    await fsp.writeFile(source, payload);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, payload);
    const before = fs.statSync(target).mtimeMs;
    const result = syncDeviceManifestSync(source, target);
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'already-in-sync');
    assert.equal(fs.statSync(target).mtimeMs, before);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('启动同步：源清单有问题时绝不写盘（坏配置不外扩到前端）', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ origin: 'REPLACE_ME' }] }));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const result = syncDeviceManifestSync(source, target);
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'source-invalid');
    assert.ok(result.problems.length > 0);
    assert.equal(fs.existsSync(target), false);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('启动同步：dist 里是坏 JSON 时会被修好', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] }));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, '{"devices":[');
    const result = syncDeviceManifestSync(source, target);
    assert.equal(result.synced, true);
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf-8')).devices,
      [{ name: 'a', origin: 'https://a:3001' }]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('启动同步：写不进去要如实报 write-failed，不假装同步过', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'devices.json');
    const target = path.join(dir, 'dist', 'devices.json');
    await fsp.writeFile(source, JSON.stringify({ devices: [{ name: 'a', origin: 'https://a:3001' }] }));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    const result = syncDeviceManifestSync(source, target);
    assert.equal(result.synced, false);
    assert.match(result.reason, /^write-failed:/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
