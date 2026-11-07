import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_AFTER_RESTARTS, BASE_BACKOFF_MS, MAX_BACKOFF_MS,
  backoffDelay, createRestartTracker, isBackoffCapped, judgeHealth,
} from './supervisorPolicy.mjs';

test('退避从 3s 起指数增长，并封顶在 30s', () => {
  assert.equal(backoffDelay(1, { jitterRatio: 0 }), 3000);
  assert.equal(backoffDelay(2, { jitterRatio: 0 }), 6000);
  assert.equal(backoffDelay(3, { jitterRatio: 0 }), 12000);
  assert.equal(backoffDelay(4, { jitterRatio: 0 }), 24000);
  assert.equal(backoffDelay(5, { jitterRatio: 0 }), 30000, '第 5 次应当被封顶而不是 48s');
  assert.equal(backoffDelay(99, { jitterRatio: 0 }), MAX_BACKOFF_MS);
  assert.equal(BASE_BACKOFF_MS, 3000);
});

test('抖动只在 ±25% 之内，且永远是正数', () => {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    for (const r of [0, 0.5, 1]) {
      const delay = backoffDelay(attempt, { random: () => r });
      const pure = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      assert.ok(delay >= Math.round(pure * 0.75) && delay <= Math.round(pure * 1.25),
        `attempt ${attempt} r=${r} 得到 ${delay}，超出 ±25%`);
    }
  }
});

test('封顶判定：用于把「还在退避」和「已经放弃无望」分开', () => {
  assert.equal(isBackoffCapped(1), false);
  assert.equal(isBackoffCapped(3), false);
  assert.equal(isBackoffCapped(4), false, '3*2^3 = 24s < 30s，第 4 次还在增长');
  assert.equal(isBackoffCapped(5), true);
});

test('记账器：连续失败到阈值才告警，且告警之间也按退避节流', () => {
  let clock = 0;
  const tracker = createRestartTracker({ now: () => clock, jitterRatio: 0 });
  assert.equal(ALERT_AFTER_RESTARTS, 5);
  for (let i = 1; i < ALERT_AFTER_RESTARTS; i += 1) {
    const outcome = tracker.recordFailure();
    assert.equal(outcome.shouldAlert, false, `第 ${i} 次不该告警`);
  }
  const fifth = tracker.recordFailure();
  assert.equal(fifth.shouldAlert, true);
  assert.match(fifth.message, /连续失败 5 次/);

  // 紧接着再失败一次：退避还没走完，不该重复刷屏。
  const sixth = tracker.recordFailure();
  assert.equal(sixth.shouldAlert, false, '告警必须节流，否则又变成刷屏');
  clock += backoffDelay(6, { jitterRatio: 0 });
  assert.equal(tracker.recordFailure().shouldAlert, true, '过了退避窗口就该再提醒一次');
});

test('稳定运行够久就把失败计数清零', () => {
  let clock = 0;
  const tracker = createRestartTracker({ now: () => clock, jitterRatio: 0 });
  tracker.recordStart();
  for (let i = 0; i < 4; i += 1) tracker.recordFailure();
  assert.equal(tracker.snapshot().restarts, 4);

  clock += 11 * 60 * 1000; // 超过 10 分钟稳定窗口
  tracker.recordStart();
  assert.equal(tracker.snapshot().restarts, 0, '活了 11 分钟说明已经自愈，不该继续背着历史包袱告警');
});

test('markHealthy 立即清账（healthz 通过后调用）', () => {
  const tracker = createRestartTracker({ jitterRatio: 0 });
  for (let i = 0; i < 6; i += 1) tracker.recordFailure();
  assert.ok(tracker.snapshot().restarts > 0);
  tracker.markHealthy();
  assert.equal(tracker.snapshot().restarts, 0);
  assert.equal(tracker.snapshot().alertCount, 0);
});

test('judgeHealth：只有新鲜且 ok 的快照才算健康', () => {
  const now = Date.parse('2026-11-07T10:00:00.000Z');
  const fresh = { ok: true, pid: 42, at: '2026-11-07T09:59:40.000Z' };
  assert.deepEqual(judgeHealth(fresh, { now }), { healthy: true, reason: 'ok' });
  assert.equal(judgeHealth(null, { now }).healthy, false);
  assert.equal(judgeHealth({ ok: false, pid: 1, at: fresh.at }, { now }).reason, 'not-ok');
  assert.equal(judgeHealth({ ok: true, pid: 0, at: fresh.at }, { now }).reason, 'bad-pid');
  assert.equal(judgeHealth({ ok: true, pid: 1 }, { now }).reason, 'no-timestamp');
  assert.match(judgeHealth({ ok: true, pid: 1, at: '2026-11-07T09:50:00.000Z' }, { now }).reason, /^stale-/);
});

test('healthz 快照超过 60 秒未更新视为不健康（进程活着但不干活）', () => {
  const now = Date.parse('2026-11-07T10:00:00.000Z');
  const verdict = judgeHealth({ ok: true, pid: 7, at: '2026-11-07T09:58:00.000Z' }, { now });
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.reason, 'stale-120s');
});
