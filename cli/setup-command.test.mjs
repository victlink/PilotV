import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APPLYABLE_STEPS,
  activeStartupEntries,
  applyPlan,
  autostartReason,
  autostartSatisfied,
  collectFacts,
  installPluginFiles,
  isApplyable,
  judgePluginInstall,
  judgeServices,
  pluginTargetDir,
  runSetup,
  startupDir,
} from './setup-command.mjs';
import { planSetup } from './setup.mjs';

delete process.env.PILOTV_TLS_CERT;

/** 造一台「刚 clone 完」的假机器：只建被探测的那些路径。 */
function makeRoot({ distManifest = true, pluginFiles = true, dist = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-root-'));
  const up = path.join(root, 'pilotdeck-mobile', 'upstream-official');
  fs.mkdirSync(path.join(root, '.venv'), { recursive: true });
  fs.mkdirSync(path.join(up, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(up, 'ui', 'public'), { recursive: true });
  const devices = JSON.stringify({ devices: [{ name: 'marc-pc', origin: 'http://marc-pc:3001' }] });
  fs.writeFileSync(path.join(up, 'ui', 'public', 'devices.json'), devices);
  if (dist) {
    fs.mkdirSync(path.join(up, 'ui', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(up, 'ui', 'dist', 'index.html'), '<html></html>');
    if (distManifest) fs.writeFileSync(path.join(up, 'ui', 'dist', 'devices.json'), devices);
  }
  const src = path.join(root, 'plugins-src', 'gateway-keeper');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ name: 'gateway-keeper', entry: 'index.js', server: 'server.mjs' }));
  if (pluginFiles) {
    for (const file of ['index.js', 'server.mjs', 'keeper-core.mjs']) {
      fs.writeFileSync(path.join(src, file), `// ${file}\n`);
    }
  }
  return root;
}

const okRunner = async () => ({ ok: true, stdout: 'enabled', stderr: '' });
const missingTaskRunner = async () => ({
  ok: false, stdout: '', stderr: 'ERROR: The system cannot find the file specified.',
});

/* ------------------------------------------------ 自启：一套还是两套 */

test('autostart: 只有一套才算满足', () => {
  assert.equal(autostartSatisfied({ taskRegistered: true, startupNames: ['desktop.ini'] }), true);
  assert.equal(autostartSatisfied({ taskRegistered: true, startupNames: ['PilotV.lnk'] }), false);
  assert.equal(autostartSatisfied({ taskRegistered: false, startupNames: [] }), false);
});

test('autostart: 我们关掉的入口不再算活入口（改名 .disabled 是真修法）', () => {
  assert.deepEqual(activeStartupEntries(['PilotV.vbs.disabled', 'desktop.ini']), []);
  assert.deepEqual(activeStartupEntries(['PilotV.vbs', 'PilotV.vbs.disabled']), ['PilotV.vbs']);
  assert.deepEqual(activeStartupEntries(undefined), []);
});

test('autostart: 「缺」和「多」分开报，两者修法相反', () => {
  assert.equal(autostartReason({ taskRegistered: false, startupNames: [] }).kind, 'missing');
  const dup = autostartReason({ taskRegistered: true, startupNames: ['PilotV.lnk'] });
  assert.equal(dup.kind, 'duplicate');
  assert.match(dup.detail, /PilotV\.lnk/);
  assert.match(dup.detail, /互相重启/, '备注要点名后果，否则没人知道为什么要关其中一套');
});

test('autostart: 无关程序的快捷方式不算第二套自启', () => {
  // 误报的代价是用户顺手把 Bitwarden 的自启关了 —— 比漏报更糟。
  const names = ['Bitwarden.lnk', 'desktop.ini', 'PilotV.vbs.disabled'];
  assert.equal(autostartSatisfied({ taskRegistered: true, startupNames: names }), true);
  assert.equal(autostartReason({ taskRegistered: true, startupNames: names }).kind, 'ok');
});

test('autostart: PilotV 自己的第二套入口仍然要报', () => {
  for (const name of ['PilotV.lnk', 'pilotv-boot.vbs', 'PilotDeck.lnk']) {
    assert.equal(autostartSatisfied({ taskRegistered: true, startupNames: [name] }), false, name);
    assert.match(autostartReason({ taskRegistered: true, startupNames: [name] }).detail, /Pilot/i, name);
  }
});

/* ------------------------------------------------ 插件：按内容判 */

const reader = (map) => (file) => (Object.hasOwn(map, file) ? map[file] : null);

test('plugin: 文件齐且内容一致才算装好', () => {
  const files = ['manifest.json', 'index.js', 'server.mjs', 'keeper-core.mjs'];
  const src = reader(Object.fromEntries(files.map((f) => [f, `// ${f}`])));
  assert.equal(judgePluginInstall({ files, readSource: src, readTarget: reader({}) }).installed, false);
  const gone = judgePluginInstall({ files, readSource: src, readTarget: src });
  assert.equal(gone.installed, true);
  assert.deepEqual(gone.missing, []);
});

test('plugin: 目录存在但内容是旧版，必须判成没装好', () => {
  // 这是最难查的一种「装好了」：面板照常显示，行为还是旧的。
  const files = ['manifest.json', 'index.js'];
  const judged = judgePluginInstall({
    files,
    readSource: reader({ 'manifest.json': 'A', 'index.js': 'B' }),
    readTarget: reader({ 'manifest.json': 'A', 'index.js': 'OLD' }),
  });
  assert.equal(judged.installed, false);
  assert.deepEqual(judged.stale, ['index.js']);
  assert.deepEqual(judged.missing, []);
});

test('plugin: 源里缺文件时报「源缺失」，不去装一个不存在的东西', () => {
  const judged = judgePluginInstall({
    files: ['manifest.json', 'ghost.mjs'],
    readSource: reader({ 'manifest.json': 'A' }),
    readTarget: reader({ 'manifest.json': 'A', 'ghost.mjs': 'x' }),
  });
  assert.equal(judged.installed, false);
  assert.deepEqual(judged.missing, ['ghost.mjs(源缺失)']);
});

test('plugin: 装完的文件与仓库内字节一致，不多带一个', () => {
  const root = makeRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-home-'));
  const sourceDir = path.join(root, 'plugins-src', 'gateway-keeper');
  const targetDir = pluginTargetDir({ home });
  const result = installPluginFiles({
    files: ['manifest.json', 'index.js', 'server.mjs', 'keeper-core.mjs'],
    sourceDir, targetDir,
  });
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.copied.sort(), ['index.js', 'keeper-core.mjs', 'manifest.json', 'server.mjs']);
  assert.deepEqual(fs.readdirSync(targetDir).sort(), result.copied.sort());
  assert.equal(fs.readFileSync(path.join(targetDir, 'index.js'), 'utf8'), '// index.js\n');
});

test('plugin: 拷失败要留在结果里，不能只打印就返回成功', () => {
  const root = makeRoot({ pluginFiles: false });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-home-'));
  const result = installPluginFiles({
    files: ['manifest.json', 'index.js'],
    sourceDir: path.join(root, 'plugins-src', 'gateway-keeper'),
    targetDir: pluginTargetDir({ home }),
  });
  assert.deepEqual(result.copied, ['manifest.json']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].file, 'index.js');
});

/* ------------------------------------------------ 服务与路径 */

test('services: 少一个端口就不算起来了', () => {
  const all = [8799, 18789, 3001, 5186].map((port) => ({ port, ok: true }));
  assert.equal(judgeServices(all).up, true);
  const half = all.map((entry) => ({ ...entry, ok: entry.port !== 3001 }));
  const judged = judgeServices(half);
  assert.equal(judged.up, false);
  assert.deepEqual(judged.down, [3001]);
});

test('services: 探测结果为空时不算「都在听」', () => {
  assert.equal(judgeServices([]).up, false);
  assert.equal(judgeServices(undefined).down.length, 4);
});

test('startupDir: 只在 Windows 上有值，且落在真正的 Startup 目录', () => {
  const dir = startupDir({ platform: 'win32', home: path.join('X:', 'me') });
  assert.match(dir, /Start Menu.Programs.Startup$/);
  assert.match(dir, /^X:/);
  assert.equal(startupDir({ platform: 'darwin', home: path.join('X:', 'me') }), '');
});

test('startupDir: APPDATA 缺失时用 home 推断路径而不是拼出 undefined', () => {
  // 本机的 PowerShell 里 $env:APPDATA 就是空的，这条不是假想敌。
  const dir = startupDir({ platform: 'win32', home: path.join('X:', 'me'), appData: '' });
  assert.ok(!/undefined/.test(dir), dir);
  assert.match(dir, /me.AppData.Roaming/);
});

/* ------------------------------------------------ 事实采集 */

const allUp = async () => ({ ok: true });
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-home-'));
const factsOf = async (overrides = {}) => (await collectFacts({
  root: makeRoot(), home: tempHome(),
  platform: 'darwin', runCommand: okRunner, probe: allUp, ...overrides,
})).facts;

﻿test('facts: 一切就位时除证书与体检外全为 true，且各自如实标注', async () => {
  const root = makeRoot();
  const home = tempHome();
  // 插件要真装进这个假 home，否则「一切就位」是假前提。
  const src = path.join(root, 'plugins-src', 'gateway-keeper');
  const dst = pluginTargetDir({ home });
  fs.mkdirSync(dst, { recursive: true });
  for (const file of ['manifest.json', 'index.js', 'server.mjs', 'keeper-core.mjs']) {
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
  }
  const { facts, notes } = await collectFacts({
    root, home, platform: 'darwin', runCommand: okRunner, probe: allUp,
  });
  assert.equal(facts.runtimeReady, true);
  assert.equal(facts.manifestInSync, true);
  assert.equal(facts.pluginInstalled, true);
  assert.equal(facts.servicesUp, true);
  assert.equal(facts.autostartInstalled, true);
  // 没跑过 doctor 之前，「体检通过」既不是 true 也不是 false。
  assert.equal(facts.doctorClean, null);
  // 假 home 里没有证书：这是「看到了它不在」，不是没探到。
  assert.equal(facts.certReady, false);
  assert.match(notes.join('\n'), /没有证书文件/);
});

test('facts: dist 没构建时 runtimeReady 为 false 且备注说清缺哪样', async () => {
  const { facts, notes } = await collectFacts({
    root: makeRoot({ dist: false }), home: tempHome(),
    platform: 'darwin', runCommand: okRunner, probe: allUp,
  });
  assert.equal(facts.runtimeReady, false);
  assert.match(notes.join('\n'), /ui\/dist=false/);
});

test('facts: 清单含模板占位符时不算就绪，哪怕两份一致', async () => {
  const root = makeRoot();
  const up = path.join(root, 'pilotdeck-mobile', 'upstream-official', 'ui');
  const template = JSON.stringify({ devices: [{ name: 'REPLACE_NAME', origin: 'https://REPLACE_HOST:3001' }] });
  fs.writeFileSync(path.join(up, 'public', 'devices.json'), template);
  fs.writeFileSync(path.join(up, 'dist', 'devices.json'), template);
  assert.equal(await factsOf({ root }).then((f) => f.manifestInSync), false,
    '占位符清单会让设备下拉是空的，两份一致也没用');
});

test('facts: schtasks 自己挂了算未知，不当成「没注册」', async () => {
  const facts = await factsOf({
    platform: 'win32', appData: fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-ad-')),
    runCommand: async () => { throw new Error('nope'); },
  });
  assert.equal(facts.autostartInstalled, null);
});

test('facts: schtasks 明确说找不到才算未注册', async () => {
  const facts = await factsOf({
    platform: 'win32', appData: fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-ad-')),
    runCommand: missingTaskRunner,
  });
  assert.equal(facts.autostartInstalled, false);
});

test('facts: Startup 里还有活入口时，计划任务在位也不算满足', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-ad-'));
  const startup = startupDir({ platform: 'win32', home: path.join(os.tmpdir(), 'h'), appData });
  fs.mkdirSync(startup, { recursive: true });
  fs.writeFileSync(path.join(startup, 'PilotV.vbs'), 'wscript');
  assert.equal((await factsOf({ platform: 'win32', appData })).autostartInstalled, false,
    '两套自启会互相重启对方');
});

test('facts: 探不到端口时 servicesUp 为 false 且点名端口', async () => {
  const { facts, notes } = await collectFacts({
    root: makeRoot(), home: tempHome(), platform: 'darwin',
    runCommand: okRunner, probe: async () => ({ ok: false }),
  });
  assert.equal(facts.servicesUp, false);
  assert.match(notes.join('\n'), /8799, 18789, 3001, 5186/);
});

﻿test('facts: 证书读不出有效期才是未知，文件不在位是已知不满足', async () => {
  const missing = await factsOf({ home: tempHome() });
  assert.equal(missing.certReady, false);
  assert.equal(missing.certDaysRemaining, null);

  const home = tempHome();
  const tls = path.join(home, '.pilotdeck', 'tls');
  fs.mkdirSync(tls, { recursive: true });
  fs.writeFileSync(path.join(tls, 'pilotv-fullchain.pem'), '不是一段 PEM');
  const broken = await factsOf({ home });
  assert.equal(broken.certReady, null, '格式读不出来才是「探不到」，不能说证书是坏的/好的');
});

/* ------------------------------------------------ 执行边界 */

/** 桩：谁被调用一目了然，也保证测试不碰真实仓库的 dist 和线上端口。 */
function stubDeps({ fixOk = true, doctorExit = 0 } = {}) {
  const calls = [];
  return {
    calls,
    fixManifest: () => { calls.push('manifest'); return { ok: fixOk, summary: fixOk ? '已同步' : '未写盘' }; },
    runDoctor: async () => {
      calls.push('verify');
      return { exitCode: doctorExit, findings: doctorExit ? [{ id: 'tls:expiry', severity: 'fail' }] : [] };
    },
  };
}

const DONE = {
  runtimeReady: true, certReady: true, manifestInSync: true, pluginInstalled: true,
  autostartInstalled: true, servicesUp: true, doctorClean: true,
};

test('apply: 白名单只有幂等、可逆、不需要提权的三步', () => {
  assert.deepEqual(APPLYABLE_STEPS, ['manifest', 'plugin', 'verify']);
  for (const key of ['cert', 'autostart', 'services', 'runtime']) assert.equal(isApplyable(key), false);
});

test('apply: 不可代跑的步骤进 deferred 而不是 failed', async () => {
  const steps = planSetup({ facts: { certReady: false, autostartInstalled: false, servicesUp: false }, platform: 'darwin' });
  const deps = stubDeps();
  const applied = await applyPlan({ steps, facts: {}, log: () => {}, deps });
  assert.ok(applied.deferred.includes('cert'));
  assert.ok(applied.deferred.includes('services'));
  assert.deepEqual(applied.failed, [], 'CLI 不代跑不是失败，记成失败会让人以为 --apply 坏了');
});

test('apply: 计划里没有待办时什么都不做', async () => {
  const deps = stubDeps();
  const applied = await applyPlan({ steps: planSetup({ facts: DONE }), facts: {}, log: () => {}, deps });
  assert.deepEqual(applied.attempted, []);
  assert.deepEqual(applied.deferred, []);
  assert.deepEqual(deps.calls, [], '没事做就不该调 doctor');
});

test('apply: doctor 报失败时 verify 记为失败而不是成功', async () => {
  const steps = planSetup({ facts: { ...DONE, doctorClean: false }, platform: 'darwin' });
  const facts = {};
  const applied = await applyPlan({ steps, facts, log: () => {}, deps: stubDeps({ doctorExit: 1 }) });
  assert.equal(facts.doctorClean, false);
  assert.equal(applied.failed.length, 1);
  assert.equal(applied.failed[0].key, 'verify');
});

test('runSetup: 默认 dryRun，不写盘也不起进程', async () => {
  const root = makeRoot();
  const home = tempHome();
  const result = await runSetup({ root, home, platform: 'darwin', runCommand: okRunner, probe: allUp });
  assert.equal(result.dryRun, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.match(result.summary, /未执行/);
});

test('runSetup: --apply 装插件，证书与自启仍留给人', async () => {
  const root = makeRoot();
  const home = tempHome();
  const result = await runSetup({
    root, home, platform: 'darwin', apply: true, runCommand: okRunner,
    probe: async () => ({ ok: false }), deps: stubDeps(),
  });
  assert.equal(result.dryRun, false);
  assert.ok(result.applied.done.some((item) => item.key === 'plugin'), '插件没装就该被装上');
  assert.ok(result.applied.deferred.includes('cert'));
  assert.ok(result.applied.deferred.includes('services'));
  assert.ok(fs.existsSync(path.join(pluginTargetDir({ home }), 'keeper-core.mjs')));
});

test('runSetup: --apply 有失败时退出码为 1', async () => {
  const result = await runSetup({
    root: makeRoot(), home: tempHome(), platform: 'darwin', apply: true,
    runCommand: okRunner, probe: allUp, deps: stubDeps({ doctorExit: 1 }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.summary, /verify/);
});

test('runSetup: --json 需要的字段都在结果里', async () => {
  const result = await runSetup({ root: makeRoot(), home: tempHome(), platform: 'darwin', runCommand: okRunner, probe: allUp });
  for (const key of ['steps', 'facts', 'notes', 'summary', 'exitCode', 'dryRun']) {
    assert.ok(key in result, `缺 ${key}`);
  }
});
