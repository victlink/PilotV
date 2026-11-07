// .run/agent-supervisor.mjs 的行为测试。
//
// 这个测试存在的意义：supervisor 是「服务挂了谁来捞」的最后一环，它自己出 bug
// 的代价是线上服务静默死亡或者被反复重启。而它之前完全没法测 —— 一 import 就
// 抢 18790 锁、真的 spawn 一个网关。现在路径/端口可注入、import 无副作用，才谈得上测。
//
// 关键护栏：所有日志路径都指向临时目录，锁端口另开一个。用例如果去轮转
// .run/agent.log 或者抢走 18790，那就不是测试通过，而是测试改了生产状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-sup-'));
process.env.PILOTDECK_SUPERVISOR_LOG = path.join(tempDir, 'supervisor.log');
process.env.PILOTDECK_GATEWAY_LOG = path.join(tempDir, 'agent.log');

/** 假网关：/healthz 的返回内容由每个用例自己拨。 */
let healthPayload = null;
let healthStatus = 200;
let healthDelayMs = 0;
const fakeGateway = http.createServer((request, response) => {
  if (request.url !== '/healthz') { response.writeHead(404); response.end(); return; }
  if (healthDelayMs) {
    setTimeout(() => {
      response.writeHead(healthStatus, { 'content-type': 'application/json' });
      response.end(healthPayload === null ? '' : JSON.stringify(healthPayload));
    }, healthDelayMs);
    return;
  }
  response.writeHead(healthStatus, { 'content-type': 'application/json' });
  response.end(healthPayload === null ? '' : JSON.stringify(healthPayload));
});
await new Promise(resolve => fakeGateway.listen(0, '127.0.0.1', resolve));
process.env.PILOTDECK_AGENT_PORT = String(fakeGateway.address().port);

// 锁端口挑一个空闲的，避免抢开发机上正在跑的那个 supervisor。
process.env.PILOTDECK_AGENT_LOCK_PORT = String(await freePort());

// 用模块自身位置定位，不用 process.cwd()：node --test 的 cwd 会随调用方式变。
const { __testables } = await import(new URL('../.run/agent-supervisor.mjs', import.meta.url));
const { ensureGateway, fetchHealth, releaseLock, rotateGatewayLog, setGateway, setActive, setNextSpawnAt, tracker, paths } = __testables;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function freshHealth(overrides = {}) {
  return {
    ok: true, status: 'healthy', pid: 4242,
    at: new Date().toISOString(),
    sessions: 3, degradedSessions: 0,
    compaction: { total: 4, succeeded: 4, failed: 0, successRate: 1 },
    ...overrides,
  };
}

test.after(async () => {
  releaseLock();
  // closeAllConnections() 没有回调参数，把它包进 new Promise 里 await 会永远悬着
  // （表现为「用例全绿但 node --test 不退出」）。它本身是同步的，直接调即可。
  fakeGateway.closeAllConnections();
  await new Promise(resolve => fakeGateway.close(resolve));
  await fsp.rm(tempDir, { recursive: true, force: true });
});

test('网关报健康时：keep，不重启不记失败', async () => {
  healthStatus = 200;
  healthPayload = freshHealth();
  tracker.markHealthy();
  setNextSpawnAt(0);
  setActive(true);
  setGateway({ pid: 4242, exitCode: null });

  await ensureGateway();
  await ensureGateway();
  assert.equal(tracker.snapshot().restarts, 0, '健康的网关一次失败都不该记');
});

test('网关自报不健康时：判重启并进入退避窗口', async () => {
  healthPayload = freshHealth({ ok: false, status: 'degraded', sessions: 2, degradedSessions: 2 });
  // 一个不存在的 pid：stopOurGateway 会去 signal 它，拿不到就只记日志，不能抛。
  setGateway({ pid: 999_999, exitCode: null });
  setNextSpawnAt(0);
  setActive(true);

  const before = tracker.snapshot().restarts;
  await ensureGateway();
  assert.ok(tracker.snapshot().restarts > before, 'ok:false 必须被记成一次失败');
  assert.equal(healthPayload.ok, false, '确认我们喂的确实是不健康的载荷');
  // 重启之后必须留出退避窗口，否则就是回到 3 秒一次的死循环。
  const secondRunBefore = tracker.snapshot().restarts;
  await ensureGateway();
  assert.equal(tracker.snapshot().restarts, secondRunBefore,
    '退避窗口内不得再次重启，这正是每天 2.8 万次 spawn 的来源');
});

test('healthz 超时不拖垮巡检：卡住的探测按“拿不到”处理', async () => {
  healthDelayMs = 5000;
  healthPayload = freshHealth();
  setGateway(null);
  setNextSpawnAt(0);
  setActive(true);
  const startedAt = Date.now();
  await ensureGateway();
  const elapsed = Date.now() - startedAt;
  healthDelayMs = 0;
  assert.ok(elapsed < 4500, `探测应当在 2 秒左右被掐断，实测 ${elapsed}ms`);
});

test('日志路径已注入临时目录，测试不会碰到真实的 .run/*.log', () => {
  assert.equal(paths.SUPERVISOR_LOG, process.env.PILOTDECK_SUPERVISOR_LOG);
  assert.equal(paths.GATEWAY_LOG, process.env.PILOTDECK_GATEWAY_LOG);
  assert.ok(paths.SUPERVISOR_LOG.startsWith(tempDir));
  assert.ok(paths.GATEWAY_LOG.startsWith(tempDir));
});

test('巡检会轮转网关日志：超过 5 MB 就改名，不再可能涨到 1.82 GB', async () => {
  await fsp.writeFile(paths.GATEWAY_LOG, 'x'.repeat(6 * 1024 * 1024));
  healthPayload = freshHealth();
  setGateway({ pid: 4242, exitCode: null });
  setActive(true);
  setNextSpawnAt(0);
  await ensureGateway();
  assert.equal(fs.existsSync(paths.GATEWAY_LOG), false, '超限日志应当已经被改名让位');
  assert.equal(fs.existsSync(path.join(tempDir, 'agent.prev.log')), true);
});

test('supervisor 自己的日志同样受轮转约束', async () => {
  await fsp.writeFile(paths.SUPERVISOR_LOG, 'x'.repeat(6 * 1024 * 1024));
  rotateGatewayLog();
  rotateSupervisorCall();
  assert.equal(fs.existsSync(paths.SUPERVISOR_LOG), false);
  assert.equal(fs.existsSync(path.join(tempDir, 'supervisor.prev.log')), true);
});

function rotateSupervisorCall() {
  // __testables 里暴露的就是内部那个带路径的轮转函数，直接调它。
  __testables.rotateSupervisorLog();
}

test('fetchHealth：拿不到 /healthz 时返回 null 而不是抛', async () => {
  healthStatus = 500;
  healthPayload = freshHealth();
  assert.equal(await fetchHealth(), null, '非 200 应当当作探测失败');

  healthStatus = 200;
  healthPayload = null; // 空 body -> JSON.parse 失败
  assert.equal(await fetchHealth(), null, '非 JSON 响应同样当作探测失败');

  healthPayload = freshHealth({ sessions: 7 });
  const health = await fetchHealth();
  assert.equal(health.sessions, 7, '恢复正常之后要能读到');
});