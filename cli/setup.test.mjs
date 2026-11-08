import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLUGIN_NAME,
  SERVICES,
  formatSetupPlan,
  planSetup,
  pluginInstallPlan,
  setupVerdict,
} from './setup.mjs';

const ALL_DONE = {
  runtimeReady: true, certReady: true, manifestInSync: true,
  pluginInstalled: true, autostartInstalled: true, servicesUp: true, doctorClean: true,
};

const plan = (facts, platform = 'win32') => planSetup({ facts, platform });

/* -------------------------------------------------- 计划形状 */

test('plan: every fact has exactly one step, in dependency order', () => {
  const keys = plan({}).map((entry) => entry.key);
  assert.deepEqual(keys, ['runtime', 'cert', 'manifest', 'plugin', 'autostart', 'services', 'verify']);
  // 证书排在起服务前面：反过来时「网关起不来」会掩盖真正的原因「缺证书」。
  assert.ok(keys.indexOf('cert') < keys.indexOf('services'));
});

test('plan: every step can be read as an instruction, not just a label', () => {
  for (const entry of plan({})) {
    assert.ok(entry.title.length > 4, `${entry.key} 没标题`);
    assert.ok(entry.why.length > 10, `${entry.key} 没解释为什么`);
    assert.ok(['skip', 'run'].includes(entry.action), `${entry.key} 动作不明确`);
    assert.equal(typeof entry.known, 'boolean');
    assert.ok(['local', 'system', 'service'].includes(entry.tier), `${entry.key} 分层不清`);
  }
});

test('plan: the four ports are the same list doctor uses', () => {
  assert.deepEqual(SERVICES.filter(s => s.required).map(s => s.port), [8799, 18789, 3001, 5186]);
});

/* -------------------------------------------------- 三态 */

test('plan: an unprobed fact is "unknown", never silently "missing"', () => {
  // 把「没探到」说成「不满足」是撒谎：一台装好了但探不到的设备会被说成缺一堆。
  const entry = plan({}).find((s) => s.key === 'manifest');
  assert.equal(entry.known, false);
  assert.equal(entry.satisfied, false);
  assert.match(entry.why, /^未确认/);
});

test('plan: unknown still means "do it", because every step is repeatable', () => {
  // 未知按要做处理：这些步骤都设计成可重复跑，漏跑比多跑贵。
  assert.equal(plan({}).find((s) => s.key === 'autostart').action, 'run');
});

test('plan: satisfied facts skip, and say what was found', () => {
  const steps = plan(ALL_DONE);
  assert.ok(steps.every((entry) => entry.action === 'skip'));
  assert.ok(steps.every((entry) => entry.known));
});

test('plan: a known-false fact must NOT be dressed up as unknown', () => {
  // 反向撒谎同样要命：把确定的说成未确认，人就不会去修它。
  const entry = plan({ certReady: false }).find((s) => s.key === 'cert');
  assert.equal(entry.known, true);
  assert.ok(!entry.why.startsWith('未确认'), entry.why);
  assert.equal(entry.action, 'run');
});

test('plan: known-ness follows the fact value, not its truthiness', () => {
  // 探测函数给 0 / 空串时算「探到了且不满足」，不算「没探到」。
  for (const falsy of [0, '', false]) {
    const entry = plan({ manifestInSync: falsy }).find((s) => s.key === 'manifest');
    assert.equal(entry.known, true, String(falsy));
  }
  for (const missing of [null, undefined]) {
    const entry = plan({ manifestInSync: missing }).find((s) => s.key === 'manifest');
    assert.equal(entry.known, false, String(missing));
  }
});

test('plan: cert reports the remaining days when known', () => {
  const entry = plan({ ...ALL_DONE, certDaysRemaining: 85 }).find(s => s.key === 'cert');
  assert.match(entry.why, /85 天/);
});

/* -------------------------------------------------- 平台差异 */

test('plan: autostart wording follows the platform', () => {
  assert.match(plan({}, 'win32').find(s => s.key === 'autostart').title, /计划任务/);
  assert.match(plan({}, 'linux').find(s => s.key === 'autostart').title, /systemd/);
});

test('plan: autostart is satisfied only when exactly one mechanism exists', () => {
  // HANDOFF 事故 3：Startup 的 .vbs 和计划任务并存时会互相重启对方。
  // 「有一套自启」不等于「装好了」，所以这条 todo 必须点名并存的那一套。
  const todo = plan({}, 'win32').find(s => s.key === 'autostart').why;
  assert.match(plan({}, 'win32').find(s => s.key === 'autostart')
    // 未确认时 why 带前缀，取后半段判断实质内容仍在
    .why, /PilotV\.vbs/);
  assert.match(todo, /互相/);
});

test('plan: services step warns about the 3001 trap', () => {
  // 这是仓库里代价最高的一次误配：gateway 开在 3001 时页面正常、每个 /api 全挂。
  assert.match(plan({}).find(s => s.key === 'services').why, /3001/);
});

/* -------------------------------------------------- 输出与结论 */

test('plan: the plan text marks the three states differently', () => {
  const text = formatSetupPlan(plan({ runtimeReady: true, certReady: false }));
  assert.match(text, /OK   runtime/);
  assert.match(text, /TODO cert/);
  assert.match(text, /\?    manifest/);
});

test('plan: colour is opt-in and never leaks control codes by default', () => {
  assert.ok(!formatSetupPlan(plan({})).includes(String.fromCharCode(27)), '默认输出必须是纯文本，能被重定向和 diff');
  assert.ok(formatSetupPlan(plan({}), { color: true }).includes(String.fromCharCode(27)));
});

test('plan: steps that touch the machine are flagged before you run them', () => {
  const text = formatSetupPlan(plan({}));
  assert.match(text, /\[system\/medium\]/);
  // autostart(system) 和 services(service) 都不是 local，两者都要数进去。
  assert.match(text, /2 项会改动系统状态/);
  // 本地步骤不该带上这个标记，否则「会改系统」的提示就没信息量了。
  assert.ok(!/runtime.*\[local/.test(text));
});

test('verdict: all satisfied is the only green answer', () => {
  assert.deepEqual(setupVerdict(plan(ALL_DONE)), { ok: true, summary: '已就绪' });
});

test('verdict: "everything unknown" must not read as "everything missing"', () => {
  const result = setupVerdict(plan({}));
  assert.equal(result.ok, false);
  assert.match(result.summary, /一项都没探到实况/);
});

test('verdict: a mix counts both the gap and the unknowns', () => {
  const result = setupVerdict(plan({ runtimeReady: true, certReady: false, manifestInSync: null,
    pluginInstalled: true, autostartInstalled: null, servicesUp: true, doctorClean: false }));
  // runtime/plugin/services 已满足；剩 cert + verify，另有 manifest/autostart 未确认也要跑
  assert.match(result.summary, /还差 4 项/);
  assert.match(result.summary, /2 项未确认/);
});

/* -------------------------------------------------- 插件安装 */

test('plugin install: exactly the files the host will load', () => {
  const plan2 = pluginInstallPlan({ manifest: { entry: 'index.js', server: 'server.mjs' } });
  // keeper-core.mjs 是 server.mjs 的相对 import：漏了它插件启动即退出，
  // 而面板只显示「读不到 keeper」，看不出原因。
  assert.deepEqual(plan2.files, ['manifest.json', 'index.js', 'server.mjs', 'keeper-core.mjs']);
});

test('plugin install: no phantom files, no duplicates', () => {
  const plan2 = pluginInstallPlan({ manifest: { entry: 'index.js' } });
  assert.deepEqual(plan2.files, ['manifest.json', 'index.js'], '没有 server 就不该拷 server，否则线上会有仓库里没有的副本');
  const odd = pluginInstallPlan({ manifest: { entry: 'manifest.json', server: 'server.mjs' } });
  assert.equal(new Set(odd.files).size, odd.files.length, '同一个文件不能出现两次');
});

test('plugin install: a missing manifest degrades instead of throwing', () => {
  assert.deepEqual(pluginInstallPlan({}).files, ['manifest.json']);
  assert.equal(pluginInstallPlan({}).name, PLUGIN_NAME);
});