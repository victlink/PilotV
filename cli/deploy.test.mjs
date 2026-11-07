// deploy 的测试。这个命令唯一的承诺是幂等，而幂等的前提是
// 「事实判断不撒谎」：已经满足的必须标 skip，没探到的必须标未确认，
// 两者都不能被顺手写成「不满足」—— 否则每次都重跑，命令就废了。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACTS_PORT,
  GATEWAY_PORT,
  REQUIRED_COMMANDS,
  buildRemoteCommand,
  deviceFromManifest,
  formatPlan,
  judgeArtifactsProbe,
  judgeSelfCheck,
  planDeployment,
  resolveDevice,
  shellQuote,
} from './deploy.mjs';
import { buildRemoteProbeScript, parseRemoteProbe } from './deploy-command.mjs';

const DEVICE = { name: 'marc-pc', host: 'marc-pc.tail2b98e5.ts.net', scheme: 'http', gatewayPort: 3001, artifactsPort: 8799 };

/** 全部已满足的事实。 */
function readyFacts(overrides = {}) {
  return {
    commandsOk: true, commands: REQUIRED_COMMANDS,
    repoReady: true, repoExists: true, repoRemote: 'git@github.com:VICTLINK/PilotV.git',
    depsReady: true, uiDistReady: true, certReady: true, serviceReady: true,
    sidecarReady: true, gatewayListening: true, selfCheckOk: true,
    ...overrides,
  };
}

test('deviceFromManifest：端口与协议按清单来，不猜、不沿用别台', () => {
  const device = deviceFromManifest({ name: 'x', origin: 'http://host.tail1.ts.net:3002', artifactsPort: 8799 });
  assert.equal(device.host, 'host.tail1.ts.net');
  assert.equal(device.gatewayPort, 3002);
  assert.equal(device.scheme, 'http');
  assert.equal(device.artifactsPort, ARTIFACTS_PORT);

  assert.equal(deviceFromManifest({ name: 'y', origin: 'https://h.example' }).gatewayPort, 443);
  assert.equal(deviceFromManifest({ name: 'z', origin: '不是 URL' }), null, '脏数据要被丢掉而不是造出 NaN 端口');
});

test('resolveDevice：未知设备显式报错并列出已知，绝不静默退回本机', () => {
  const list = [DEVICE, { ...DEVICE, name: 'leo-mac-studio' }];
  assert.deepEqual(resolveDevice(list, 'marc-pc').device, DEVICE);

  const miss = resolveDevice(list, 'marc');
  assert.match(miss.error, /清单里没有设备/);
  assert.match(miss.error, /marc-pc, leo-mac-studio/);

  assert.match(resolveDevice(list, '').error, /要指定设备名/);
  assert.match(resolveDevice([], 'a').error, /清单为空/);

  const dup = resolveDevice([DEVICE, { ...DEVICE, gatewayPort: 3999 }], 'marc-pc');
  assert.match(dup.error, /出现 2 次/, '重名清单必须先修，不能挑一个用');
});

test('planDeployment：全部满足 -> 没有任何待执行步骤（幂等的定义）', () => {
  const plan = planDeployment({ device: DEVICE, facts: readyFacts() });
  assert.deepEqual(plan.pending, []);
  assert.equal(plan.noop, true);
  assert.equal(plan.steps.every((s) => s.action === 'skip'), true);
  assert.match(formatPlan(plan), /已经是目标状态/);
});

test('planDeployment：只缺证书 -> 只跑那一步，其余 skip（不做「有变化就全量重装」）', () => {
  const plan = planDeployment({ device: DEVICE, facts: readyFacts({ certReady: false }) });
  assert.deepEqual(plan.pending, ['cert']);
  assert.match(formatPlan(plan), /安全上下文/);
  assert.equal(plan.steps.find((s) => s.key === 'sidecar').action, 'skip');
});

test('planDeployment：没探到的标未确认，不伪装成观测到的「不满足」', () => {
  const plan = planDeployment({ device: DEVICE, facts: readyFacts({ commandsOk: null, repoReady: null, serviceReady: null }) });
  assert.deepEqual(plan.pending, ['preflight', 'repo', 'service']);
  assert.deepEqual(plan.unknown, ['preflight', 'repo', 'service']);
  const text = formatPlan(plan);
  assert.match(text, /未确认（探测没拿到事实）/);
  assert.match(plan.steps.find((s) => s.key === 'repo').why, /^未确认/);
  // 未知照「要执行」处理：脚本幂等，多跑一次无害；判成「已满足」才会真出事。
  assert.equal(plan.steps.find((s) => s.key === 'preflight').action, 'run');
});

test('planDeployment：目录存在但不是本仓库 -> 提示人工确认而不是覆盖', () => {
  const plan = planDeployment({ device: DEVICE, facts: readyFacts({ repoReady: false, repoExists: true }) });
  assert.match(plan.steps.find((s) => s.key === 'repo').why, /不动它/);
  const fresh = planDeployment({ device: DEVICE, facts: readyFacts({ repoReady: false, repoExists: false }) });
  assert.match(fresh.steps.find((s) => s.key === 'repo').why, /^clone 到/);
});

test('planDeployment：自检要求网关和成果台同时正常（只起一半是最常见的假正常）', () => {
  const half = planDeployment({ device: DEVICE, facts: readyFacts({ selfCheckOk: false }) });
  assert.deepEqual(half.pending, ['selfcheck']);
  const why = half.steps.find((s) => s.key === 'selfcheck').why;
  assert.match(why, /:3001\/8799/, '两个端口都要探到，只起一半不算起来');
});

test('planDeployment：端口取自设备清单，不写死 5186', () => {
  const plan = planDeployment({ device: DEVICE, facts: readyFacts() });
  assert.deepEqual(plan.ports, { gateway: 3001, artifacts: 8799 });
  const fallback = planDeployment({
    device: { name: 'n', host: 'h', gatewayPort: 0, artifactsPort: 0 },
    facts: readyFacts(),
  });
  assert.deepEqual(fallback.ports, { gateway: GATEWAY_PORT, artifacts: ARTIFACTS_PORT });
  assert.throws(() => planDeployment({ device: {}, facts: {} }), /需要 device.name/);
});

test('judgeArtifactsProbe：401/403 是「服务在跑」，判成未部署会让计划不再幂等', () => {
  assert.deepEqual(judgeArtifactsProbe({ status: 200, bodyOk: true }), { ready: true, note: '' });
  assert.equal(judgeArtifactsProbe({ status: 401 }).ready, true);
  assert.match(judgeArtifactsProbe({ status: 403 }).note, /要求登录/);
  assert.equal(judgeArtifactsProbe({ status: 500 }).ready, false);
  assert.equal(judgeArtifactsProbe({ status: 200, bodyOk: false }).ready, false);
  // 连不上是「没探到」，不是「坏」。
  assert.equal(judgeArtifactsProbe({}).ready, null);
  assert.equal(judgeArtifactsProbe().ready, null);
});

test('judgeSelfCheck：网关与成果台都要真起来，只起一半不算；没探到不算好也不算坏', () => {
  assert.equal(judgeSelfCheck({ gatewayListening: true, sidecarReady: true }), true);
  assert.equal(judgeSelfCheck({ gatewayListening: true, sidecarReady: false }), false, '成果台没起来就是没起来');
  assert.equal(judgeSelfCheck({ gatewayListening: false, sidecarReady: true }), false, '网关没起来同理');
  assert.equal(judgeSelfCheck({ gatewayListening: true, sidecarReady: null }), null, '有一个没探到 -> 不知道');
  assert.equal(judgeSelfCheck({ gatewayListening: false, sidecarReady: null }), false, '已经有一个明确否定了就不用再等另一个');
  assert.equal(judgeSelfCheck({}), null);
});
test('parseRemoteProbe：缺 DONE 一律算未知，绝不把「没输出」读成「都正常」', () => {
  assert.deepEqual(parseRemoteProbe(''), { ok: false });
  assert.deepEqual(parseRemoteProbe('git version 2.40'), { ok: false }, '中途断掉的输出不能用');

  const full = parseRemoteProbe([
    'NODE=v22.23.3', 'REPO=yes', 'DIST=yes', 'DEPS=yes', 'SERVICE=no', 'DONE',
  ].join('\n'));
  assert.equal(full.ok, true);
  assert.equal(full.commandsOk, true);
  assert.equal(full.nodeVersion, 'v22.23.3');
  assert.equal(full.repoReady, true);
  assert.equal(full.uiDistReady, true);
  assert.equal(full.serviceReady, false);

  const partial = parseRemoteProbe('MISSING=node\nMISSING=npm\nNODE=\nREPO=no\nDIST=no\nDEPS=no\nSERVICE=no\nDONE');
  assert.equal(partial.commandsOk, false);
  assert.deepEqual(partial.missingCommands, ['node', 'npm']);
  assert.deepEqual(partial.commands, ['git', 'python3']);
  assert.equal(partial.repoReady, false);
});

test('buildRemoteProbeScript：只读命令，且路径带引号', () => {
  const script = buildRemoteProbeScript('/data/My PilotV');
  assert.match(script, /DEV_DIR='\/data\/My PilotV'/);
  assert.match(script, /\$UI\/dist\/index.html/);
  assert.match(script, /export PATH=".*\/opt\/homebrew\/bin.*\.local\/bin/, '非交互 ssh 不补 PATH 会把已经装好的 node/npm 判成缺依赖');
  // 探测脚本里出现这些动词就说明它不是只读的。
  for (const verb of ['systemctl start', 'systemctl enable', 'launchctl load', 'rm -rf', 'npm install', 'git clone']) {
    assert.equal(script.includes(verb), false, `探测脚本不该有 ${verb}`);
  }
  assert.match(script, /echo DONE/);
});

test('shellQuote：空格、单引号、$ 与反引号都不改变含义', () => {
  assert.equal(shellQuote('/a/b'), "'/a/b'");
  assert.equal(shellQuote("o'brien"), "'o'\\''brien'");
  assert.match(shellQuote('a b'), /^'a b'$/);
  assert.equal(shellQuote('$(rm -rf /)').startsWith("'"), true);
});

test('buildRemoteCommand：补 PATH、已存在就 --ff-only、端口按设备注入', () => {
  const { remote } = buildRemoteCommand({ repoUrl: 'git@github.com:VICTLINK/PilotV.git', devDir: '~/PilotV', device: DEVICE });
  assert.match(remote, /export PATH=".*\.local\/bin/, '非交互 ssh 不补 PATH 会把装好的 npm 判成缺失');
  assert.match(remote, /git pull --ff-only/, '宁可失败也不自动 merge/rebase');
  assert.match(remote, /git clone 'git@github.com:VICTLINK\/PilotV\.git'/, 'repoUrl 必须被引号包住');
  assert.match(remote, /PILOTV_PORT=3001 PILOTV_ARTIFACTS_PORT=8799/);
  assert.match(remote, /set -euo pipefail/);
  assert.match(remote, /scripts\/deploy_pilotv_device\.sh/, '执行仍下发给那份跑通过的 bash');

  assert.throws(() => buildRemoteCommand({ device: DEVICE }), /需要 repoUrl/);
  assert.throws(() => buildRemoteCommand({ repoUrl: 'u' }), /需要 device/);
});

test('buildRemoteCommand：devDir 带空格不会把一条命令拆成三条', () => {
  const { remote } = buildRemoteCommand({ repoUrl: 'git@h:p/r.git', devDir: '/data/My PilotV', device: DEVICE });
  assert.match(remote, /DEV_DIR='\/data\/My PilotV'/);
  assert.match(remote, /cd "\$DEV_DIR"/);
  assert.equal(remote.includes('clone git@h:p/r.git /data/My PilotV'), false);
});