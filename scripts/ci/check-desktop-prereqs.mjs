// 桌面端打包前置门禁（P3.2）。
//
// 为什么不是「直接把 electron 打包跑起来」：apps/desktop 在仓里只有 src/*.ts 和
// package.json —— package.json 里点名的 scripts/build-runtime.mjs、
// scripts/after-pack.cjs、resources/icons、resources/installer.nsh 一个都没随
// vendor 进来，node_modules 也不在（本机连 pnpm 都没有）。在这种仓库状态下宣布
// 「桌面端已打包」是假话。
//
// 所以这个门禁做两件真能做的事：
//   1. 抓漂移 —— package.json 的依赖声明和 pnpm-lock.yaml 的 importer 一旦不一致，
//      打出来的包用的是另一个版本的 electron，行为变了而没人看得出来。这类问题只有
//      机器能一直盯着。
//   2. 把「还缺什么」变成可比较的集合 —— 已知缺失进基线（否则门禁永远红，等于没有
//      门禁），新增缺失或出现漂移就失败。想真打包的那台机器上跑 --strict，装齐即绿。
//
// 三态沿用仓库里 check-upstream-patches 的口径：只有 ready 算通过。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 上游 desktop 打包链引用、但没随 vendor 进来的东西。
 * 记在这里而不是让它每次都变成「新发现」：基线的意义是「新增缺失才失败」。
 */
export const KNOWN_MISSING = [
  'apps/desktop/.runtime/app',
  'apps/desktop/resources/build-metadata.json',
  'apps/desktop/resources/entitlements.mac.plist',
  'apps/desktop/resources/git',
  'apps/desktop/resources/icons',
  'apps/desktop/resources/icons/icon.icns',
  'apps/desktop/resources/icons/icon.ico',
  'apps/desktop/resources/icons/icon.png',
  'apps/desktop/resources/icons/installer-icon.ico',
  'apps/desktop/resources/installer.nsh',
  'apps/desktop/resources/node',
  'apps/desktop/resources/rpm-after-remove.sh',
  'apps/desktop/scripts/after-pack.cjs',
  'apps/desktop/scripts/build-runtime.mjs',
  'apps/desktop/scripts/check-linux-build-host.mjs',
  'apps/desktop/scripts/check-windows-build-host.mjs',
  'apps/desktop/scripts/download-cua-driver.mjs',
  'apps/desktop/scripts/download-git-bash.mjs',
  'apps/desktop/scripts/download-node.mjs',
  'apps/desktop/scripts/download-playwright-browsers.mjs',
  'apps/desktop/scripts/normalize-linux-rpm-artifact.mjs',
  'apps/desktop/scripts/normalize-linux-x64-artifact.mjs',
];

/** package.json 里声明的依赖 vs lockfile importer 里的 specifier，逐条比。 */
export function diffDependencySpecifiers({ pkg, lockImporter }) {
  const drifted = [];
  const missing = [];
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, specifier] of Object.entries(pkg[section] || {})) {
      const declared = lockImporter?.[section]?.[name]?.specifier;
      if (declared === undefined) { missing.push(`${section}/${name}`); continue; }
      if (declared !== specifier) {
        drifted.push({ name, section, packageJson: specifier, lockfile: declared });
      }
    }
  }
  return { drifted, missing };
}

/**
 * 从 pnpm-lock.yaml 里取某个 importer 的依赖段。
 * 手写一个够用的窄解析器：只认「两空格 importer 名 / 四空格 section /
 * 六空格包名 / 八空格 specifier」这一种形状，不引入 yaml 依赖（CLI 的零依赖约束）。
 * 认不出来的形状返回 null，让上层判成「未知」而不是「一致」。
 */
export function readLockImporter(lockText, importerPath) {
  const lines = String(lockText || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`  ${importerPath}:`));
  if (start === -1) return null;
  const result = {};
  let section = null;
  let pkg = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 2) break; // 下一个 importer
    const trimmed = line.trim();
    const key = trimmed.replace(/:$/, '').replace(/^'(.*)'$/, '$1');
    if (indent === 4 && (key === 'dependencies' || key === 'devDependencies')) {
      section = key;
      result[section] = {};
      pkg = null;
      continue;
    }
    if (indent === 6 && section) { pkg = key; continue; }
    if (indent === 8 && section && pkg) {
      // 「specifier: ^42.3.3」是键值行，不是新的包名：上一版把它当 key 比，
      // 于是所有依赖都「找不到」，门禁报出一个根本不存在的漂移。
      if (trimmed.startsWith('specifier:')) {
        // 注意不能比 key === 'specifier'：这一行的 key 里带着值，去掉行尾冒号
        // 之后它叫「specifier: ^42.3.3」，那样写会静默不赋值，又是一次假漂移。
        const value = trimmed.slice('specifier:'.length).trim().replace(/^'(.*)'$/, '$1');
        result[section][pkg] = { specifier: value };
      }
      continue;
    }
    if (indent !== 8) return null; // 形状超出预期：宁可判未知
  }
  return Object.keys(result).length ? result : null;
}

/** 从 package.json 的 scripts 与 build 配置里抽出被引用的仓内相对路径。 */
export function referencedBuildArtifacts(pkg) {
  const found = new Set();
  for (const script of Object.values(pkg.scripts || {})) {
    // 只认「node 后面跟着 scripts/ 下的一条路径」，不试图解析整条 shell：
    // 上游脚本里有 ENV=x node ...、umask 022 && node ...，按锚位解析必漏。
    for (const match of String(script).matchAll(/node\s+(scripts\/[\w.\-/]+\.(?:mjs|cjs|js))/g)) {
      found.add(match[1]);
    }
  }
  const build = pkg.build || {};
  if (typeof build.afterPack === 'string') found.add(build.afterPack);
  for (const target of [build.mac, build.win, build.linux, build.nsis, build.rpm]) {
    if (!target) continue;
    for (const key of ['icon', 'include', 'entitlements', 'entitlementsInherit', 'afterRemove', 'installerIcon', 'uninstallerIcon']) {
      if (typeof target[key] === 'string') found.add(target[key]);
    }
  }
  for (const entry of build.extraResources || []) {
    if (typeof entry?.from === 'string') found.add(entry.from);
  }
  return [...found].sort();
}

/**
 * 一次前置体检。返回 findings 数组，每条 { id, title, state, detail, fix }。
 * state: ready | missing | drifted —— 和 check-upstream-patches 同一种三态。
 */
export function evaluateDesktopPrereqs({ root, platform = process.platform, pnpmAvailable } = {}) {
  const desktopDir = path.join(root, 'apps/desktop');
  const findings = [];
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };

  const pkg = readJson(path.join(desktopDir, 'package.json'));
  if (!pkg) {
    return [{
      id: 'desktop:package', title: 'apps/desktop/package.json', state: 'missing', category: 'repo',
      detail: '读不到（或不是合法 JSON）', fix: '桌面端入口都不在，打包无从谈起',
    }];
  }
  findings.push({ id: 'desktop:package', title: 'apps/desktop/package.json', state: 'ready', category: 'repo', detail: `${pkg.name} ${pkg.version}` });

  // 主入口：tsconfig 的 outDir/main 指的文件得真存在（或至少源文件在，能被 tsc 产出）。
  const mainField = typeof pkg.main === 'string' ? pkg.main : 'dist/main.js';
  const mainBuilt = fs.existsSync(path.join(desktopDir, mainField));
  const mainSource = fs.existsSync(path.join(desktopDir, 'src', `${mainField.replace(/^dist\//, '').replace(/\.js$/, '')}.ts`));
  findings.push(mainBuilt || mainSource
    ? { id: 'desktop:main', title: 'Electron 主进程入口', state: 'ready', category: 'repo', detail: mainBuilt ? `${mainField} 已编译` : 'src 在位，编译后产出入口' }
    : { id: 'desktop:main', title: 'Electron 主进程入口', state: 'missing', category: 'repo', detail: `既无 ${mainField} 也无对应 .ts 源`, fix: '检查 apps/desktop/src 是否完整 vendor' });

  // 依赖声明与 lockfile 必须一致：不一致意味着实际装的 electron 版本和声明不是一回事。
  const lockFile = path.join(root, 'pnpm-lock.yaml');
  let lockText = null;
  try { lockText = fs.readFileSync(lockFile, 'utf8'); } catch { lockText = null; }
  if (lockText === null) {
    findings.push({
      id: 'desktop:lock', title: 'pnpm-lock.yaml', state: 'missing', category: 'repo',
      detail: '没有锁文件，无法核对依赖版本', fix: '上游用 pnpm；缺锁文件时装出来的版本不可复现',
    });
  } else {
    const importer = readLockImporter(lockText, 'apps/desktop');
    if (!importer) {
      findings.push({
        id: 'desktop:lock', title: '依赖与 lockfile 一致性', state: 'missing', category: 'repo',
        detail: '锁文件里没有 apps/desktop 这个 importer（或形状不认识）',
        fix: '确认 pnpm-workspace.yaml 含 apps/desktop，并重新 pnpm install --lockfile-only',
      });
    } else {
      const diff = diffDependencySpecifiers({ pkg, lockImporter: importer });
      if (diff.drifted.length) {
        findings.push({
          id: 'desktop:lock', title: '依赖与 lockfile 一致性', state: 'drifted', category: 'repo',
          detail: diff.drifted.map((d) => `${d.name}: package.json=${d.packageJson} lock=${d.lockfile}`).join('; '),
          fix: '要么改 package.json 重新出锁，要么让 lock 追上声明 —— 别让 electron 版本偷偷变了',
        });
      } else if (diff.missing.length) {
        findings.push({
          id: 'desktop:lock', title: '依赖与 lockfile 一致性', state: 'drifted', category: 'repo',
          detail: `锁文件里找不到 ${diff.missing.join(', ')}`,
          fix: 'pnpm install --lockfile-only 后提交 lock',
        });
      } else {
        findings.push({ id: 'desktop:lock', title: '依赖与 lockfile 一致性', state: 'ready', category: 'repo', detail: '声明与锁定一致' });
      }
    }
  }

  // 打包链引用的脚本与资源。基线内的缺失是「已知这仓不完整」，基线外的是新问题。
  const referenced = referencedBuildArtifacts(pkg);
  const absent = referenced.filter((rel) => !fs.existsSync(path.join(desktopDir, rel)));
  const baselineMisses = absent.filter((rel) => KNOWN_MISSING.includes(`apps/desktop/${rel}`));
  const newMisses = absent.filter((rel) => !KNOWN_MISSING.includes(`apps/desktop/${rel}`));
  if (newMisses.length) {
    findings.push({
      id: 'desktop:assets', title: '打包脚本与资源', state: 'missing', category: 'repo', baseline: false,
      detail: `package.json 引用但不存在：${newMisses.join(', ')}`,
      fix: '这些是上游打包链的文件；要么补齐，要么别再被 scripts 引用',
    });
  } else if (baselineMisses.length) {
    findings.push({
      id: 'desktop:assets', title: '打包脚本与资源', state: 'missing', category: 'repo', baseline: true,
      detail: `已知未随 vendor 进来：${baselineMisses.join(', ')}`,
      fix: '本机不能打包是仓库状态决定的；要出安装包请在完整上游树上跑',
    });
  } else {
    findings.push({ id: 'desktop:assets', title: '打包脚本与资源', state: 'ready', category: 'repo', detail: `${referenced.length} 项引用全部在位` });
  }

  // 依赖装没装。node_modules 不在就是没装 —— 打包的第一步都迈不出去。
  const depsInstalled = fs.existsSync(path.join(desktopDir, 'node_modules', 'electron'))
    && fs.existsSync(path.join(desktopDir, 'node_modules', 'electron-builder'));
  findings.push(depsInstalled
    ? { id: 'desktop:deps', title: 'electron / electron-builder', state: 'ready', category: 'environment', detail: '已安装' }
    : { id: 'desktop:deps', title: 'electron / electron-builder', state: 'missing', category: 'environment', detail: 'apps/desktop/node_modules 里没有它们', fix: 'pnpm install --frozen-lockfile（需 pnpm 与网络）' });

  // Windows 目标只能在原生 Windows 上出（上游自己用 check-windows-build-host 把关）。
  const wantsWin = JSON.stringify(pkg.build?.win?.target || '').includes('nsis');
  if (wantsWin) {
    findings.push(platform === 'win32'
      ? { id: 'desktop:host', title: '构建宿主与目标匹配', state: 'ready', category: 'environment', detail: 'nsis 目标 + Windows 宿主' }
      : { id: 'desktop:host', title: '构建宿主与目标匹配', state: 'drifted', category: 'environment', detail: `目标是 nsis，宿主是 ${platform}`, fix: 'nsis 只能在原生 Windows 上打（上游同一条约束）' });
  }

  if (pnpmAvailable === false) {
    findings.push({
      id: 'desktop:pnpm', title: 'pnpm 可用', state: 'missing', category: 'environment',
      detail: 'PATH 上没有 pnpm', fix: '桌面端是 pnpm workspace 成员，装 pnpm 才能装依赖',
    });
  } else if (pnpmAvailable === true) {
    findings.push({ id: 'desktop:pnpm', title: 'pnpm 可用', state: 'ready', category: 'environment', detail: '已找到' });
  }

  return findings;
}

const ICONS = { ready: 'ok  ', missing: 'MISS', drifted: 'DRIFT' };

/** 人话输出。与 check-upstream-patches 同一种形状，方便 CI 里一起读。 */
export function formatDesktopPrereqs(findings, { color = false } = {}) {
  const paint = (text, kind) => {
    if (!color) return text;
    const code = { ready: '32', missing: '31', drifted: '33' }[kind];
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  const lines = [];
  for (const finding of findings) {
    const head = `${ICONS[finding.state] || '?   '} ${finding.id}  ${finding.title}  ${finding.state}`;
    lines.push(finding.state === 'ready' ? paint(head, 'ready') : paint(head, finding.state));
    lines.push(`     ${finding.detail}`);
    if (finding.state !== 'ready' && finding.fix) lines.push(`     怎么办：${finding.fix}`);
  }
  const blockers = findings.filter((f) => f.state !== 'ready');
  lines.push('');
  lines.push(blockers.length === 0
    ? paint('桌面端打包前置齐备 —— 可以跑 pnpm --filter pilotdeck-desktop dist:*', 'ready')
    : paint(`前置未齐备（${blockers.length} 项），本机不能出安装包`, 'missing'));
  return lines.join('\n');
}

/**
 * 退出码。strict：非 ready 即失败 —— 那是「我要真打包」的口径。
 * 非 strict（CI 默认）：只有「仓库内容类」且不在已知基线里的问题失败 ——
 * 即锁漂移、以及新出现却没入库的打包文件。装没装 pnpm/electron 属于构建环境，
 * 本机/CI 没有它们是常态，报出来但不拦；否则门禁第一天就红，等于没有门禁。
 */
export function desktopPrereqsExit(findings, { strict = true } = {}) {
  if (strict) return findings.every((f) => f.state === 'ready') ? 0 : 1;
  const blocking = findings.filter((f) => f.state !== 'ready'
    && f.category === 'repo' && f.baseline !== true);
  return blocking.length ? 1 : 0;
}

/* ------------------------------------------- CLI 入口 */

async function pnpmAvailable() {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', ['pnpm'],
      { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(!error && String(stdout).trim().length > 0));
  });
}

async function main(argv) {
  const root = path.resolve(HERE, '../../pilotdeck-mobile/upstream-official');
  const strict = argv.includes('--strict');
  const asJson = argv.includes('--json');
  const findings = evaluateDesktopPrereqs({
    root: argv.find((a) => a.startsWith('--root='))?.slice(7) || root,
    pnpmAvailable: await pnpmAvailable(),
  });
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ root, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`桌面端打包前置 · ${root}\n\n${formatDesktopPrereqs(findings, { color: !argv.includes('--no-color') })}\n`);
    if (!strict) {
      process.stdout.write('（非 --strict：只把「漂移」和「基线外的新增缺失」当失败；已知未 vendor 的项不拦 CI）\n');
    }
  }
  return desktopPrereqsExit(findings, { strict: strict || argv.includes('--strict') });
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (error) => { console.error('[check-desktop-prereqs] 检查失败:', error); process.exitCode = 1; });
}
