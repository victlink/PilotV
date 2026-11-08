// pilotv setup 的命令层：采集本机事实 -> 出计划 -> （显式 --apply 才）执行。
//
// 和 deploy 一样，默认只出计划。区别在于 deploy 改的是别人家的机器，setup 改的是
// 这台机器本身 —— 注册计划任务、往用户目录拷文件，这些动作在「我只是想看看还缺
// 什么」的时候绝不该发生。
//
// 执行侧还有一条更狠的约束：只执行白名单里那几步「幂等 + 可逆 + 不需要提权」的。
// 证书和计划任务宁可打印命令让人自己跑，也不要 CLI 在非交互环境里替人改登录自启
// —— 那正是 HANDOFF 事故 3（两套自启互相重启对方）的成因。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { certExpiry, compareManifestPair, probeTcp } from './probes.mjs';
import { PLUGIN_NAME, SERVICES, formatSetupPlan, planSetup, pluginInstallPlan, setupVerdict } from './setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/** 插件的仓库内来源与用户目录目的地。宿主只认后者（plugin-loader.js 的 PLUGINS_DIR）。 */
export function pluginSourceDir({ root = REPO_ROOT, pluginName = PLUGIN_NAME } = {}) {
  return path.join(root, 'plugins-src', pluginName);
}

export function pluginTargetDir({ home = os.homedir(), pluginName = PLUGIN_NAME } = {}) {
  return path.join(home, '.pilotdeck', 'plugins', pluginName);
}

/** 登录自启的 Startup 目录。home 可注入，这样判定不依赖真实家目录就能被测。 */
export function startupDir({ platform = process.platform, home = os.homedir(), appData } = {}) {
  if (platform !== 'win32') return '';
  const base = appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/**
 * Startup 目录里哪些文件名算「活的自启入口」。
 * 锚点必须在结尾：改名成 PilotV.vbs.disabled 的入口本来就不再是 .vbs，Windows
 * 不会执行它，我们也不该把它报成待办 —— 所以不需要额外的 .disabled 黑名单，
 * 那道黑名单是死代码（写过的版本里它一次也没被命中过）。
 */
export function activeStartupEntries(names) {
  return (names || []).filter((name) => /\.(lnk|vbs)$/i.test(name));
}

/**
 * 会和计划任务互相重启的只有 PilotV 自己的第二套自启。
 * 把 Bitwarden.lnk 也报成「两套自启打架」是误报，而误报的代价是用户顺手把
 * 无关程序给关了 —— 那比漏报更难看的错。
 */
export function pilotStartupEntries(names, pattern = /pilot/i) {
  return activeStartupEntries(names).filter((name) => pattern.test(name));
}

/**
 * 自启的「满足」= 有计划任务 且 没有并存的 Startup 入口。
 * 「有一套」和「只有一套」是两个不同的结论：后者才是安全的。
 */
export function autostartSatisfied({ isWin = true, taskRegistered, startupNames } = {}) {
  if (!isWin) return taskRegistered === true;
  return taskRegistered === true && pilotStartupEntries(startupNames).length === 0;
}

/** 自启没满足时到底是哪种情况 —— 「缺」和「多」的修法完全相反。 */
export function autostartReason({ taskRegistered, startupNames } = {}) {
  const active = pilotStartupEntries(startupNames);
  if (taskRegistered !== true) {
    return { kind: active.length ? 'duplicate' : 'missing', detail: '计划任务未注册' };
  }
  if (active.length > 0) {
    return { kind: 'duplicate', detail: `Startup 下还有 ${active.join(', ')}，两套自启会互相重启对方` };
  }
  return { kind: 'ok', detail: '只有一套自启' };
}

/**
 * 插件装没装，按内容判，不按「目录存在」判。
 * 目录在但里面是上一版，是最难查的一种「装好了」：面板照常显示，行为却是旧的。
 * readers 由调用方注入，让「装齐 / 缺文件 / 内容不一致」三种判定不碰真家目录就能测。
 */
export function judgePluginInstall({ files, readSource, readTarget }) {
  const src = typeof readSource === 'function' ? readSource : () => null;
  const read = typeof readTarget === 'function' ? readTarget : () => null;
  const missing = [];
  const stale = [];
  for (const file of files || []) {
    const wanted = src(file);
    if (wanted === null || wanted === undefined) {
      // 源里没有的文件不该被要求安装：硬拷过去就成了仓库外的幽灵副本。
      missing.push(`${file}(源缺失)`);
      continue;
    }
    const have = read(file);
    if (have === null || have === undefined) missing.push(file);
    else if (have !== wanted) stale.push(file);
  }
  return { installed: missing.length === 0 && stale.length === 0, missing, stale };
}

/** 四服务是否都在听：少一个都不算起，只起一半是最常见的假正常。 */
export function judgeServices(results) {
  const required = SERVICES.filter((entry) => entry.required);
  const down = required.filter((entry) => !(results || []).some((r) => r.port === entry.port && r.ok));
  return { up: down.length === 0, down: down.map((entry) => entry.port) };
}

/* ------------------------------------------- 事实采集 */

const PLACEHOLDER = /REPLACE_[A-Z_]+/;
const UI_DIR = 'pilotdeck-mobile/upstream-official/ui';

const existsFile = (file) => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};
const readIfPossible = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};
const run = (command, args, timeoutMs = 8000) => new Promise((resolve) => {
  execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error }));
});

/** 探测工具的缺席或崩溃是「没探到」，不是「不满足」，更不能把整条命令带崩。 */
async function safeRun(runCommand, command, args, timeoutMs) {
  try {
    return await runCommand(command, args, timeoutMs);
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error?.message || error), spawned: false };
  }
}

/**
 * 本机实况。约定同 deploy：探不到就是未知（null），不是「不满足」。
 * 一台刚 clone 完的机器和一台 ssh 不通的机器，在计划里必须长得不一样。
 */
export async function collectFacts({ root = REPO_ROOT, platform = process.platform, home = os.homedir(), appData, timeoutMs = 3000, runCommand = run, probe = probeTcp } = {}) {
  const notes = [];
  const facts = {};
  const ui = path.join(root, UI_DIR);

  const venvReady = fs.existsSync(path.join(root, '.venv'));
  const depsReady = fs.existsSync(path.join(root, 'pilotdeck-mobile/upstream-official/node_modules'));
  const distFile = path.join(ui, 'dist', 'index.html');
  const distReady = existsFile(distFile);
  facts.runtimeReady = venvReady && depsReady && distReady;
  if (!facts.runtimeReady) {
    notes.push(`运行时就位情况：venv=${venvReady} 依赖=${depsReady} ui/dist=${distReady}`);
  }
  try {
    facts.uiDistMtime = fs.statSync(distFile).mtime.toISOString().slice(0, 16).replace('T', ' ');
  } catch { facts.uiDistMtime = null; }

  const certFile = process.env.PILOTV_TLS_CERT || path.join(home, '.pilotdeck', 'tls', 'pilotv-fullchain.pem');
  const cert = certExpiry(certFile);
  facts.certDaysRemaining = typeof cert.daysRemaining === 'number' ? cert.daysRemaining : null;
  // 文件不存在是「看到了它不在」，属于已知不满足；读不出格式才是没探到。
  // 把缺证书说成未知，setup 就不会催人去签 —— 而它恰好是安卓装 PWA 的硬前置。
  facts.certReady = typeof cert.daysRemaining === 'number'
    ? cert.daysRemaining > 0
    : (cert.error === 'ENOENT' ? false : null);
  if (cert.error === 'ENOENT') notes.push(`没有证书文件（${certFile}）`);
  if (facts.certReady === null && cert.error && cert.error !== 'ENOENT') {
    notes.push(`证书读不出有效期（${cert.error}）：续期脚本大概也会栽在这里`);
  }

  const publicFile = path.join(ui, 'public', 'devices.json');
  const distManifest = path.join(ui, 'dist', 'devices.json');
  const pair = compareManifestPair(publicFile, distManifest);
  const sourceText = readIfPossible(publicFile);
  // 「两份一致」不等于「清单可用」：还不含模板占位符才算数，否则设备下拉是空的。
  facts.manifestInSync = pair.reason === 'already-in-sync' && sourceText !== null && !PLACEHOLDER.test(sourceText);
  if (pair.reason !== 'already-in-sync') notes.push(`设备清单：${pair.reason}`);

  const sourceDir = pluginSourceDir({ root });
  const targetDir = pluginTargetDir({ home });
  const manifestText = readIfPossible(path.join(sourceDir, 'manifest.json'));
  if (!manifestText) {
    facts.pluginInstalled = null;
    notes.push(`仓库里没有 plugins-src/${PLUGIN_NAME}/manifest.json，插件是否在位无法判断`);
  } else {
    let manifest = null;
    try { manifest = JSON.parse(manifestText); } catch { manifest = null; }
    const install = pluginInstallPlan({ manifest });
    const judged = judgePluginInstall({
      files: install.files,
      readSource: (file) => readIfPossible(path.join(sourceDir, file)),
      readTarget: (file) => readIfPossible(path.join(targetDir, file)),
    });
    facts.pluginInstalled = judged.installed;
    if (!judged.installed) {
      notes.push(`插件 ${PLUGIN_NAME}：缺 ${judged.missing.length ? judged.missing.join(', ') : '无'}；版本不一致 ${judged.stale.length ? judged.stale.join(', ') : '无'}`);
    }
  }

  const isWin = platform === 'win32';
  let taskRegistered;
  if (isWin) {
    const query = await safeRun(runCommand, 'schtasks.exe', ['/query', '/tn', 'PilotV-Startup'], timeoutMs + 4000);
    // 只有 schtasks 明确答「找不到」才算未注册；它自己挂了是未知，不是没装。
    taskRegistered = query.ok ? true : (/cannot find|找不到|ERROR:.*1060/i.test(`${query.stderr}${query.stdout}`) ? false : null);
  } else {
    const query = await safeRun(runCommand, 'systemctl', ['--user', 'is-enabled', 'pilotv.service']);
    taskRegistered = query.ok ? query.stdout.trim() === 'enabled' : null;
  }
  const dir = startupDir({ platform, home, appData });
  let startupNames = [];
  if (dir) {
    try { startupNames = fs.readdirSync(dir); } catch (error) { notes.push(`读不到 Startup 目录（${error.code || error.message}）：自启是否唯一无法判断`); }
  }
  facts.autostartInstalled = taskRegistered === null ? null : autostartSatisfied({ isWin, taskRegistered, startupNames });
  const autostart = autostartReason({ taskRegistered, startupNames });
  if (autostart.kind !== 'ok') notes.push(`自启：${autostart.detail}`);

  const probes = await Promise.all(SERVICES.filter((entry) => entry.required)
    .map((entry) => probe({ host: '127.0.0.1', port: entry.port, timeoutMs }).then((r) => ({ port: entry.port, ok: r.ok }))));
  const services = judgeServices(probes);
  facts.servicesUp = services.up;
  if (!services.up) notes.push(`没在听的端口：${services.down.join(', ')}`);

  // doctor 自己没被跑过之前，「体检通过」这件事是未确认，不是 true 也不是 false。
  facts.doctorClean = null;
  return { facts, notes, autostart, plugin: { sourceDir, targetDir } };
}

/* ------------------------------------------- 执行 */

/**
 * 允许 --apply 代跑的只有这三步：幂等、可逆、不需要提权。
 *   manifest 覆盖一份只由源文件决定的 json；plugin 覆盖用户目录里仓库自己产出的
 *   几个文件；verify 只读。
 * 证书要动 TLS、自启要动登录配置、起服务会拉起四个常驻进程 —— 这三件事的副作用
 * 远大于「省一次手敲」，CLI 打印命令让人自己决定。替人改自启正是当年那套
 * 「计划任务 + Startup 快捷方式」互相重启的来路。
 */
export const APPLYABLE_STEPS = ['manifest', 'plugin', 'verify'];

export function isApplyable(key) {
  return APPLYABLE_STEPS.includes(key);
}

/** 只拷 manifest 点名的文件：多拷一个，下次升级就有仓库外还在生效的幽灵副本。 */
export function installPluginFiles({ files, sourceDir, targetDir, log = () => {} }) {
  const copied = [];
  const failed = [];
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const from = path.join(sourceDir, file);
    const to = path.join(targetDir, file);
    try {
      const content = fs.readFileSync(from);
      fs.writeFileSync(to, content);
      copied.push(file);
      log(`  写入 ${file}`);
    } catch (error) {
      failed.push({ file, error: error.code || error.message });
      log(`  失败 ${file}: ${error.code || error.message}`);
    }
  }
  return { copied, failed };
}

/**
 * 执行器。返回 { attempted, done, deferred }：deferred 是「这一步 CLI 不代跑」，
 * 它不是失败，把它记成失败会让人以为 --apply 出了 bug。
 */
export async function applyPlan({ steps, facts, root = REPO_ROOT, home = os.homedir(), log = () => {}, runCommand = run, deps = {} } = {}) {
  // doctor / fixManifest 可注入：测试不能为了验证编排去探线上端口，
  // 更不能为了让测试变绿而写真实仓库的 dist。
  const loadFix = deps.fixManifest || (async (opts) => (await import('./doctor-command.mjs')).fixManifest(opts));
  const loadDoctor = deps.runDoctor || (async (opts) => (await import('./doctor-command.mjs')).runDoctor(opts));
  const attempted = [];
  const done = [];
  const deferred = [];
  const failed = [];

  for (const entry of steps.filter((stepEntry) => stepEntry.action === 'run')) {
    if (!isApplyable(entry.key)) {
      deferred.push(entry.key);
      log(`跳过 ${entry.key}（CLI 不代跑这一步${entry.command ? `，请手动执行：${entry.command}` : ''}）`);
      continue;
    }
    attempted.push(entry.key);
    if (entry.key === 'manifest') {
      const fixed = await loadFix({ root });
      log(`  ${fixed.summary}`);
      (fixed.ok ? done : failed).push({ key: 'manifest', detail: fixed.summary });
      continue;
    }
    if (entry.key === 'plugin') {
      const sourceDir = pluginSourceDir({ root });
      const targetDir = pluginTargetDir({ home });
      const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
      const install = pluginInstallPlan({ manifest });
      const result = installPluginFiles({ files: install.files, sourceDir, targetDir, log });
      if (result.failed.length === 0) done.push({ key: 'plugin', detail: `${result.copied.length} 个文件 -> ${targetDir}` });
      else failed.push({ key: 'plugin', detail: `${result.failed.map((f) => `${f.file}:${f.error}`).join(', ')}` });
      continue;
    }
    if (entry.key === 'verify') {
      const report = await loadDoctor({ root });
      facts.doctorClean = report.exitCode === 0;
      const failedNames = report.findings.filter((f) => f.severity === 'fail').map((f) => f.id);
      log(`  doctor: ${facts.doctorClean ? '没有失败项' : `失败项 ${failedNames.join(', ')}`}`);
      (facts.doctorClean ? done : failed).push({ key: 'verify', detail: failedNames.join(', ') || '通过' });
    }
  }
  return { attempted, done, deferred, failed };
}

/**
 * pilotv setup 主流程。
 * @param {{apply?:boolean,root?:string,home?:string,json?:boolean,color?:boolean,timeoutMs?:number}} options
 */
export async function runSetup(options = {}) {
  const root = options.root || REPO_ROOT;
  const home = options.home || os.homedir();
  const collected = await collectFacts({
    root, home, appData: options.appData,
    timeoutMs: Number(options.timeoutMs) || 3000,
    runCommand: options.runCommand, probe: options.probe, platform: options.platform,
  });
  const steps = planSetup({ facts: collected.facts, platform: options.platform || process.platform });
  const verdict = setupVerdict(steps);

  const lines = [formatSetupPlan(steps, { color: options.color === true })];
  if (collected.notes.length) lines.push('', '探测备注：', ...collected.notes.map((note) => `  - ${note}`));

  const pending = steps.filter((entry) => entry.action === 'run');
  if (!options.apply) {
    lines.push('', pending.length === 0
      ? '无需改动。'
      : `未执行。${pending.filter((entry) => isApplyable(entry.key)).length} 项可由 --apply 代跑，`
        + `${pending.filter((entry) => !isApplyable(entry.key)).length} 项需你手动确认（自启/证书/起服务会改动本机常驻状态）。`);
    return { ok: verdict.ok, dryRun: true, steps, facts: collected.facts, notes: collected.notes, summary: lines.join('\n'), exitCode: 0 };
  }

  lines.push('', '开始执行（只跑幂等且不需要提权的步骤）：');
  const applied = await applyPlan({
    steps, facts: collected.facts, root, home,
    log: options.log || ((text) => lines.push(text)),
    runCommand: options.runCommand, deps: options.deps || {},
  });
  lines.push('', `已执行 ${applied.done.length} 项，跳过 ${applied.deferred.length} 项，失败 ${applied.failed.length} 项。`);
  if (applied.failed.length) {
    lines.push(...applied.failed.map((item) => `  x ${item.key}: ${item.detail}`));
    lines.push('  步骤都是幂等的，修掉原因后直接重跑。');
  }
  if (applied.deferred.length) {
    lines.push(`  仍需手动：${applied.deferred.join(', ')}（这些会改本机常驻状态，CLI 不代你做决定）`);
  }
  return {
    ok: applied.failed.length === 0, dryRun: false, steps, facts: collected.facts,
    notes: collected.notes, applied, summary: lines.join('\n'),
    exitCode: applied.failed.length ? 1 : 0,
  };
}
