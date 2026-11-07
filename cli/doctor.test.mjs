// doctor 判定层的测试：喂事实，断言结论。
//
// 这一层的价值全在「结论说对了没有」。采集层的错会立刻炸（连不上就是连不上），
// 判定层的错会安静地骗人：把好的证书报成没生效、把 HTML 兜底页当成健康、
// 把 warn 算进退出码让 CI 天天红。所以每条分支都要有正反两喂。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeProbeError,
  evaluateCertExpiry,
  evaluateHealthz,
  evaluateLogSize,
  evaluateManifestSync,
  evaluatePorts,
  evaluateUpstreamPatches,
  formatText,
  summarize,
} from './doctor.mjs';

const EXPECTED = [
  { port: 5186, name: '网关' },
  { port: 8799, name: '成果台' },
  { port: 8801, name: 'MCP 侧车', required: false },
];

test('describeProbeError：区分「没人听」「超时」「协议用反」「证书域名不符」', () => {
  assert.equal(describeProbeError({ code: 'ECONNREFUSED' }, '127.0.0.1:5186').severity, 'fail');
  assert.match(describeProbeError({ code: 'ECONNREFUSED' }, '127.0.0.1:5186').detail, /没人监听/);
  assert.match(describeProbeError({ code: 'ETIMEDOUT' }, 'a:1').detail, /超时/);
  assert.match(describeProbeError({ code: 'EPROTO' }, 'a:1').detail, /协议不匹配/);
  // 域名不匹配是自签证书环境的常态，值得单独提醒但不该和「挂了」同色。
  assert.equal(describeProbeError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'a:1').severity, 'warn');
  assert.match(describeProbeError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'a:1').fix, /SAN/);
});

test('describeProbeError：AggregateError 要看 cause 里第一条，否则只剩「fetch failed」', () => {
  const verdict = describeProbeError(
    { message: 'fetch failed', errors: [{ code: 'ECONNREFUSED' }] }, '127.0.0.1:3001');
  assert.match(verdict.detail, /没人监听/);
  assert.equal(verdict.code, 'ECONNREFUSED');
});

test('describeProbeError：认不出的错误也带上原始 code，不做「未知错误」式甩锅', () => {
  const verdict = describeProbeError({ code: 'ENOTFOUND' }, 'host:1');
  assert.equal(verdict.severity, 'fail');
  assert.match(verdict.detail, /ENOTFOUND/);
  assert.equal(describeProbeError({}, 'host:1').detail.includes('host:1'), true);
});

test('evaluatePorts：缺 required 端口是 fail，缺可选端口只是 warn', () => {
  const findings = evaluatePorts(EXPECTED, [{ port: 5186, pid: 11, command: 'node' }]);
  assert.equal(findings[0].severity, 'pass');
  assert.match(findings[0].detail, /pid 11/);
  assert.equal(findings[1].severity, 'fail');
  assert.equal(findings[2].severity, 'warn', '侧车没起不该让体检整体判失败');
});

test('evaluatePorts：两个进程抢同一端口必须判 fail（表现为「时好时坏」，比连不上难查）', () => {
  const [gateway] = evaluatePorts(EXPECTED, [
    { port: 5186, pid: 11 }, { port: 5186, pid: 22 }, { port: 8799, pid: 33 },
  ]);
  assert.equal(gateway.severity, 'fail');
  assert.match(gateway.detail, /2 个进程/);
  assert.match(gateway.detail, /11, 22/);
});

test('evaluateManifestSync：只有内容一致才算 pass；「还没同步」要说成「改完没重启」', () => {
  assert.equal(evaluateManifestSync({ synced: true, from: 'a', to: 'b' }).severity, 'pass');
  assert.equal(evaluateManifestSync({ synced: false, reason: 'already-in-sync' }).severity, 'pass');

  const outOfSync = evaluateManifestSync({ synced: false, reason: 'out-of-sync' });
  assert.equal(outOfSync.severity, 'fail');
  assert.match(outOfSync.fix, /重启 5186/, '这条的真实含义是没重启，不是同步失败');

  assert.equal(evaluateManifestSync({ synced: false, reason: 'dist-missing' }).severity, 'fail');
  const invalid = evaluateManifestSync({ synced: false, reason: 'source-invalid', problems: ['缺 origin'] });
  assert.equal(invalid.severity, 'warn');
  assert.match(invalid.detail, /缺 origin/);
  assert.equal(evaluateManifestSync({ synced: false }).severity, 'warn', '没给原因也不许抛，只降级为提醒');
});

test('evaluateLogSize：5 MB 是死循环信号，边界上不报警', () => {
  const limit = 5 * 1024 * 1024;
  assert.equal(evaluateLogSize('a.log', limit).severity, 'pass');
  assert.equal(evaluateLogSize('a.log', limit + 1).severity, 'fail');
  assert.match(evaluateLogSize('a.log', 1.82 * 1024 * 1024 * 1024).detail, /MB/);
});

test('evaluateCertExpiry：过期 fail、临期 warn、正常 pass、读不到只 warn', () => {
  assert.equal(evaluateCertExpiry(85).severity, 'pass');
  assert.equal(evaluateCertExpiry(13).severity, 'warn');
  assert.equal(evaluateCertExpiry(0).severity, 'warn');
  assert.equal(evaluateCertExpiry(-1).severity, 'fail');
  assert.equal(evaluateCertExpiry(null).severity, 'warn');

  // 正负号读反过一次：好证书被报成「还没生效」，比漏报更难查，因为看起来很有道理。
  assert.match(evaluateCertExpiry(85, -3).detail, /还没生效/);
  assert.equal(evaluateCertExpiry(85, -3).severity, 'fail');
  assert.equal(evaluateCertExpiry(85, 3).severity, 'pass', '距签发 3 天是完全正常的');
});

const HEALTHY = { ok: true, status: 'healthy', sessions: 3, wsConnections: 2, degradedSessions: 0, compaction: { successRate: 0.98 } };

test('evaluateHealthz：ok=true + degraded 是正常降级，只 warn 并写清是哪条会话', () => {
  assert.equal(evaluateHealthz(HEALTHY, 200).severity, 'pass');
  const degraded = evaluateHealthz({
    ...HEALTHY, status: 'degraded', degradedSessions: 1,
    reasons: [{ sessionKey: 'sess-a', reason: '模型超时' }],
  }, 200);
  assert.equal(degraded.severity, 'warn');
  assert.match(degraded.detail, /sess-a: 模型超时/);
  assert.match(degraded.fix, /别重启进程/, '重启会把好的会话一起踢掉');
});

test('evaluateHealthz：200 + HTML 要认出「探错了端口/构建太旧」，不能当健康', () => {
  const verdict = evaluateHealthz(null, 200, { rawText: '<!doctype html><html><body>ok</body></html>' });
  assert.equal(verdict.severity, 'fail');
  assert.match(verdict.detail, /前端页面而不是 JSON/);
  assert.match(verdict.fix, /18789/);

  assert.equal(evaluateHealthz(null, 200, { rawText: 'not json' }).severity, 'fail');
  assert.match(evaluateHealthz({ ok: true }, 503).detail, /HTTP 503/);
});

test('evaluateHealthz：整体判不可用是 fail，并给出第一条出问题的会话', () => {
  const verdict = evaluateHealthz({
    ok: false, status: 'unavailable', sessions: 2,
    reasons: [{ sessionKey: 'sess-b', reason: 'DB 锁死' }, { sessionKey: 'sess-c', reason: 'DB 锁死' }],
  }, 200);
  assert.equal(verdict.severity, 'fail');
  assert.match(verdict.detail, /sess-b: DB 锁死/);
});

test('evaluateUpstreamPatches：三处补丁缺一处就 fail，并点名缺哪个', () => {
  const all = [
    { key: 'decoder', present: true }, { key: 'compaction', present: true }, { key: 'guard', present: true },
  ];
  assert.equal(evaluateUpstreamPatches(all).severity, 'pass');
  const lost = evaluateUpstreamPatches([...all.slice(0, 2), { key: 'guard', present: false }]);
  assert.equal(lost.severity, 'fail');
  assert.match(lost.detail, /guard/);
  assert.match(lost.fix, /patches/);
});

test('evaluateUpstreamPatches：被覆盖与漂移给的修法不同', () => {
  const ok = { key: 'a', present: true, state: 'applied' };
  const lost = evaluateUpstreamPatches([ok, { key: 'b', present: false, state: 'missing' }]);
  assert.equal(lost.severity, 'fail');
  assert.match(lost.fix, /git apply/, '被覆盖就该直接重放');
  const drift = evaluateUpstreamPatches([ok, { key: 'b', present: false, state: 'drifted' }]);
  assert.equal(drift.severity, 'fail');
  assert.match(drift.fix, /重新生成/);
  assert.ok(!drift.fix.includes('patches/<'), '漂移时叫人 git apply 是错误指导');
  const mixed = evaluateUpstreamPatches([{ key: 'b', present: false, state: 'missing' }, { key: 'c', present: false, state: 'drifted' }]);
  assert.match(mixed.fix, /混合状态/);
});

test('evaluateUpstreamPatches：没有 state 字段的旧输入仍然 fail（不能靠 state 漏过）', () => {
  const result = evaluateUpstreamPatches([{ key: 'x', present: false }]);
  assert.equal(result.severity, 'fail');
});
test('summarize：退出码只看 fail —— warn 让 CI 红就没人再看它', () => {
  const warnOnly = summarize([
    { id: 'a', title: 'a', severity: 'warn', detail: 'x' },
    { id: 'b', title: 'b', severity: 'pass', detail: 'y' },
  ]);
  assert.equal(warnOnly.ok, true);
  assert.equal(warnOnly.exitCode, 0);
  assert.deepEqual(warnOnly.actionable.map((f) => f.id), ['a'], '只列需要人处理的');

  const withFail = summarize([
    { id: 'a', title: 'a', severity: 'fail', detail: 'x' },
    { id: 'w', title: 'w', severity: 'warn', detail: 'y' },
  ]);
  assert.equal(withFail.exitCode, 1);
  assert.deepEqual(withFail.counts, { pass: 0, warn: 1, fail: 1 });
});

test('formatText：只给需要处理的行写「怎么办」，颜色可关', () => {
  const report = summarize([
    { id: 'a', title: '端口 5186', severity: 'pass', detail: 'pid 1', fix: '不需要' },
    { id: 'b', title: '证书', severity: 'warn', detail: '还剩 3 天', fix: '续期' },
  ]);
  const text = formatText(report, { color: false });
  assert.equal(text.includes('怎么办：不需要'), false, 'pass 行不该有怎么办');
  assert.match(text, /怎么办：续期/);
  assert.equal(text.includes('\u001b['), false);
  assert.ok(formatText(report, { color: true }).includes('\u001b[33m'), 'warn 要有颜色');
  assert.match(formatText(summarize([{ id: 'x', title: 'x', severity: 'pass', detail: '' }]), { color: false }), /全部通过/);
});