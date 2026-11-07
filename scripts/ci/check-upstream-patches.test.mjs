import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, formatText, patchKey } from './check-upstream-patches.mjs';

const APPLIED = { key: 'crash-guards', file: '0001-crash-guards.patch', state: 'applied' };
const MISSING = { key: 'partial-summary', file: '0002-partial-summary.patch', state: 'missing' };
const DRIFTED = { key: 'tolerant-decoder', file: '0003-tolerant-decoder.patch', state: 'drifted' };

test('patchKey：编号前缀和扩展名都不该进 key', () => {
  assert.equal(patchKey('0001-crash-guards.patch'), 'crash-guards');
  assert.equal(patchKey('patches/0012-a-b-c.patch'), 'a-b-c');
});

test('evaluate：全 applied 才算过', () => {
  const result = evaluate([APPLIED, { ...MISSING, state: 'applied' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('evaluate：被上游覆盖要红，且给出重放这条路径', () => {
  const result = evaluate([APPLIED, MISSING]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.map((e) => e.key), ['partial-summary']);
  assert.deepEqual(result.drifted, []);
  assert.match(result.problems.join(), /上游覆盖/);
});

test('evaluate：漂移要红，且修法与「覆盖」不同', () => {
  const result = evaluate([APPLIED, DRIFTED]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.drifted.map((e) => e.key), ['tolerant-decoder']);
  assert.deepEqual(result.missing, []);
  // 这两种情形的修复动作不一样：一个是重放，一个必须重新生成。
  // 混成一条 FAIL，人就只会去 git apply，然后发现根本 apply 不上。
  assert.match(result.problems.join(), /对不上/);
});

test('evaluate：空目录要红 —— 补丁通道整个没了不能算干净', () => {
  const result = evaluate([]);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /一张 patch 都没有/);
});

test('formatText：失败时报错要能直接照着做', () => {
  const text = formatText(evaluate([MISSING, DRIFTED]));
  assert.match(text, /FAIL partial-summary\s+missing/);
  assert.match(text, /FAIL tolerant-decoder\s+drifted/);
  assert.match(text, /git apply -p1/);
  assert.match(text, /重新生成/);
});

test('formatText：全绿时不许出现 FAIL（否则 CI 日志会骗人）', () => {
  const text = formatText(evaluate([APPLIED]));
  assert.ok(!text.includes('FAIL'), text);
  assert.match(text, /OK/);
});

test('unknown state 不许被当成 applied 放过去', () => {
  const result = evaluate([{ key: 'x', file: 'x.patch', state: 'what-the' }]);
  assert.equal(result.ok, false, '既不是 missing 也不是 drifted 的状态必须红');
});