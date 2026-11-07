import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCK_PORT,
  classifyLockProbe,
  decideKeeperAction,
  mergeKeeperConfig,
  planKeeperStep,
  defaultRepoCandidates,
  readyLine,
  resolveRepoRoot,
  statusPayload,
} from './keeper-core.mjs';

const REPO = '/srv/pilotv';
// 只有真的存在锚点文件的目录算仓库。用集合模拟，避免测试碰磁盘。
const anchors = (roots) => (dir) => roots.includes(dir);

/* -------------------------------------------------- 仓库定位 */

test('repo root: config wins when it really is a PilotV checkout', () => {
  assert.deepEqual(
    resolveRepoRoot({ config: { repoRoot: REPO }, anchorExists: anchors([REPO]) }),
    { root: REPO, source: 'config' },
  );
});

test('repo root: a stale config path is NOT allowed to fall back to guessing', () => {
  // 装错仓库比装不上更贵：它会去起另一台机器上的服务，而那看起来像「起好了」。
  const result = resolveRepoRoot({
    config: { repoRoot: '/old/machine/pilotv' },
    env: { PILOTV_HOME: REPO },
    candidates: [REPO],
    anchorExists: anchors([REPO]),
  });
  assert.equal(result.root, null);
  assert.equal(result.source, 'config');
  assert.equal(result.rejected, '/old/machine/pilotv');
});

test('repo root: env is used when there is no config', () => {
  assert.deepEqual(
    resolveRepoRoot({ env: { PILOTV_HOME: REPO }, anchorExists: anchors([REPO]) }),
    { root: REPO, source: 'env' },
  );
});

test('repo root: an env path that is not a checkout gets rejected, not trusted', () => {
  // PILOTV_HOME 是人写的，写错太常见了。相信它的后果不是报错，
  // 而是 keeper 在一个没有 supervisor 的目录里反复尝试拉起。
  const result = resolveRepoRoot({ env: { PILOTV_HOME: '/tmp' }, anchorExists: anchors([REPO]) });
  assert.equal(result.root, null);
  assert.equal(result.rejected, '/tmp');
});

test('repo root: candidates are tried in order and must be provable', () => {
  const found = resolveRepoRoot({ candidates: ['/nope', REPO, '/also-nope'], anchorExists: anchors([REPO, '/also-nope']) });
  assert.deepEqual(found, { root: REPO, source: 'candidate' });
  assert.equal(resolveRepoRoot({ candidates: ['/nope'], anchorExists: anchors([]) }).root, null);
});

test('repo root: a directory name is not proof — the anchor is', () => {
  assert.equal(resolveRepoRoot({ candidates: ['/home/music/PilotV'], anchorExists: () => false }).root, null);
});

/* -------------------------------------------------- 动作判定 */

test('keeper: holds the lock means it stays out of the way', () => {
  const d = decideKeeperAction({ repoRoot: REPO, lockReachable: true });
  assert.equal(d.action, 'idle');
  assert.match(d.why, /单实例锁/);
});

test('keeper: an unknown probe must not be treated as "nobody is running"', () => {
  // 这是本文件最重要的一条。把「探测超时」当成「没人跑」，keeper 就会在
  // 已经有一个 supervisor 的时候再拉一个，两个互相重启对方。
  assert.equal(decideKeeperAction({ repoRoot: REPO, lockReachable: undefined }).action, 'wait');
});

test('keeper: a refused lock means it really should spawn', () => {
  assert.equal(decideKeeperAction({ repoRoot: REPO, lockReachable: false }).action, 'spawn');
});

test('keeper: cooldown after spawning, or it becomes a tight spawn loop', () => {
  // agent.log 涨到 1.82 GB 的成因之一就是这种紧循环。
  const d = decideKeeperAction({ repoRoot: REPO, lockReachable: false, nowMs: 10_000, lastSpawnMs: 0, minSpawnGapMs: 30_000 });
  assert.equal(d.action, 'cooldown');
  assert.equal(d.sinceSpawnMs, 10_000);
  const after = decideKeeperAction({ repoRoot: REPO, lockReachable: false, nowMs: 31_000, lastSpawnMs: 0, minSpawnGapMs: 30_000 });
  assert.equal(after.action, 'spawn', '冷却结束还探不到锁，就该再拉一次');
});

test('keeper: no repo root blocks everything with an actionable hint', () => {
  const d = decideKeeperAction({ repoRoot: null, lockReachable: false });
  assert.equal(d.action, 'blocked');
  assert.match(d.why, /pilotv setup/);
});

test('keeper: the blocked verdict outranks the cooldown', () => {
  // 顺序错了的话，没有仓库时 keeper 会先说「冷却中」，人就永远等不到那句人话。
  const d = decideKeeperAction({ repoRoot: null, lockReachable: false, nowMs: 1, lastSpawnMs: 0 });
  assert.equal(d.action, 'blocked');
});

/* -------------------------------------------------- 探测三态 */

test('probe: only an explicit refusal means "not listening"', () => {
  assert.equal(classifyLockProbe({ connected: true }), true);
  assert.equal(classifyLockProbe({ errorCode: 'ECONNREFUSED' }), false);
  assert.equal(classifyLockProbe({ errorCode: 'ETIMEDOUT' }), undefined);
  assert.equal(classifyLockProbe({}), undefined);
});

/* -------------------------------------------------- dry-run / 配置层叠 */

test('planKeeperStep: dry-run still decides, only skips the hand', () => {
  const spawn = { action: 'spawn', why: ':18790 无人持有' };
  const plan = planKeeperStep(spawn, { dryRun: true });
  assert.equal(plan.action, 'dry-run');
  assert.equal(plan.executed, false);
  assert.match(plan.why, /dry-run/);
  assert.ok(plan.why.includes(':18790 无人持有'), 'dry-run 不能把原判定理由吞掉');
});

test('planKeeperStep: without dry-run a spawn is executed', () => {
  const plan = planKeeperStep({ action: 'spawn', why: 'x' });
  assert.equal(plan.action, 'spawn');
  assert.equal(plan.executed, true);
});

test('planKeeperStep: idle never becomes executed', () => {
  // 只有 spawn 才能被执行。其它判定若也带 executed:true，server 会把 idle 当成要动手。
  for (const action of ['idle', 'wait', 'cooldown', 'blocked']) {
    assert.equal(planKeeperStep({ action, why: 'x' }).executed, false, action);
  }
});

test('mergeKeeperConfig: the user file wins over the plugin package default', () => {
  // setup 写的是用户目录那份。方向写反的话，升级插件会把这台机器的仓库指定
  // 静静改回默认值，而 keeper 看起来一切正常。
  assert.deepEqual(
    mergeKeeperConfig({ userConfig: { repoRoot: '/mine' }, localConfig: { repoRoot: '/default', dryRun: false } }),
    { repoRoot: '/mine', dryRun: false },
  );
});

test('mergeKeeperConfig: a broken config file degrades to the other layer, not to a crash', () => {
  for (const junk of [null, undefined, 'oops', 42, ['a']]) {
    assert.deepEqual(mergeKeeperConfig({ userConfig: junk, localConfig: { dryRun: true } }), { dryRun: true });
    assert.deepEqual(mergeKeeperConfig({ userConfig: { dryRun: true }, localConfig: junk }), { dryRun: true });
  }
  assert.deepEqual(mergeKeeperConfig({}), {});
});

test('status: dryRun is visible so a lying panel is impossible', () => {
  assert.equal(statusPayload({ repoRoot: REPO, lockReachable: true }).dryRun, false);
  assert.equal(statusPayload({ repoRoot: REPO, lockReachable: true, dryRun: true }).dryRun, true);
});

/* -------------------------------------------------- 宿主契约 */

test('ready line: exactly what ui/server waits for on stdout', () => {
  assert.equal(readyLine(43000), '{"ready":true,"port":43000}\n');
  assert.deepEqual(JSON.parse(readyLine(43000)), { ready: true, port: 43000 });
});

test('ready line: a bogus port fails loudly instead of stalling the host', () => {
  for (const bad of [0, -1, 70000, 'abc', null, undefined, 1.5]) {
    assert.throws(() => readyLine(bad), /端口/, `${String(bad)} 不该被当成合法端口`);
  }
});

test('status: never leaks more than the lock verdict and the last action', () => {
  const payload = statusPayload({
    repoRoot: REPO, lockReachable: false, action: 'spawn', why: 'x',
    spawnCount: 3, lastSpawnMs: 1, supervisorPid: null,
  });
  assert.equal(payload.supervisorRunning, false);
  assert.equal(payload.lockProbe, 'refused');
  assert.equal(payload.lockPort, LOCK_PORT);
  assert.deepEqual(Object.keys(payload).sort(), [
    'dryRun', 'lastAction', 'lastSpawnMs', 'lastWhy', 'lockPort',
    'lockProbe', 'repoRoot', 'spawnCount', 'supervisorPid', 'supervisorRunning',
  ].sort());
});

test('status: an unprobed state says unknown rather than "not running"', () => {
  assert.equal(statusPayload({ repoRoot: REPO, lockReachable: undefined }).lockProbe, 'unknown');
  assert.equal(statusPayload({ repoRoot: REPO, lockReachable: undefined }).supervisorRunning, false);
});

/* -------------------------------------------------- 候选位置 */

test('candidates: cover both POSIX home and Windows USERPROFILE', () => {
  const nix = defaultRepoCandidates({ homedir: '/home/marc' });
  assert.ok(nix.includes('/home/marc/PilotV'));
  const win = defaultRepoCandidates({ env: { USERPROFILE: 'C:\\Users\\music' } });
  assert.ok(win.some((entry) => entry.includes('music') && entry.includes('pilotv')));
  assert.deepEqual(defaultRepoCandidates({}), []);
});