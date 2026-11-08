import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KNOWN_MISSING,
  desktopPrereqsExit,
  diffDependencySpecifiers,
  evaluateDesktopPrereqs,
  formatDesktopPrereqs,
  readLockImporter,
  referencedBuildArtifacts,
} from './check-desktop-prereqs.mjs';

const LOCK = [
  'lockfileVersion: 9.0',
  'importers:',
  '  apps/desktop:',
  '    dependencies:',
  '      electron-updater:',
  '        specifier: ^6.8.9',
  '        version: 6.8.9',
  '    devDependencies:',
  "      '@types/node':",
  '        specifier: ^25.0.0',
  '        version: 25.9.1',
  '      electron:',
  '        specifier: ^42.3.3',
  '        version: 42.11.1',
  '',
  '  ui:',
  '    dependencies:',
  '      react:',
  '        specifier: ^18.0.0',
  '',
  'packages:',
].join('\n');

/* ---------------------------------------- lockfile 解析 */

test('lock: 能读出 importer 的 specifier', () => {
  const importer = readLockImporter(LOCK, 'apps/desktop');
  assert.equal(importer.dependencies['electron-updater'].specifier, '^6.8.9');
  assert.equal(importer.devDependencies.electron.specifier, '^42.3.3');
  assert.equal(importer.devDependencies['@types/node'].specifier, '^25.0.0');
});

test('lock: 只取自己那段，不串到下一个 importer', () => {
  const importer = readLockImporter(LOCK, 'apps/desktop');
  assert.equal(importer.dependencies.react, undefined, 'ui 的依赖串进来了');
});

test('lock: 依赖段里冒出没见过的更深缩进时判未知，不交出一份残缺的解析结果', () => {
  // 少了这道守卫，解析器会「带着已解析的部分继续」，于是残缺结果被当成完整事实，
  // 依赖比对会得出「一致」——一次不会报错的假通过。
  const weird = [
    '  apps/desktop:',
    '    dependencies:',
    '      electron-updater:',
    '        specifier: ^6.8.9',
    '          unexpected: deep',
  ].join('\n');
  assert.equal(readLockImporter(weird, 'apps/desktop'), null);
});

test('lock: 没有这个 importer 时返回 null（判未知，不判一致）', () => {
  assert.equal(readLockImporter(LOCK, 'apps/ghost'), null);
  assert.equal(readLockImporter('', 'apps/desktop'), null);
  assert.equal(readLockImporter(undefined, 'apps/desktop'), null);
});

test('lock: 形状不认识时返回 null 而不是给一个「一致」的假结论', () => {
  const weird = ['  apps/desktop:', '    - electron-updater: ^6.8.9'].join('\n');
  assert.equal(readLockImporter(weird, 'apps/desktop'), null);
});

/* ---------------------------------------- 漂移检测 */

const PKG = {
  dependencies: { 'electron-updater': '^6.8.9' },
  devDependencies: { '@types/node': '^25.0.0', electron: '^42.3.3' },
};

test('drift: 声明与锁定一致时无漂移', () => {
  const diff = diffDependencySpecifiers({ pkg: PKG, lockImporter: readLockImporter(LOCK, 'apps/desktop') });
  assert.deepEqual(diff.drifted, []);
  assert.deepEqual(diff.missing, []);
});

test('drift: electron 版本被偷偷改掉必须报出来', () => {
  const pkg = structuredClone(PKG);
  pkg.devDependencies.electron = '^43.0.0';
  const diff = diffDependencySpecifiers({ pkg, lockImporter: readLockImporter(LOCK, 'apps/desktop') });
  assert.equal(diff.drifted.length, 1);
  assert.equal(diff.drifted[0].name, 'electron');
  assert.equal(diff.drifted[0].lockfile, '^42.3.3');
});

test('drift: 声明了但锁里没有算缺失，不能算一致', () => {
  const pkg = structuredClone(PKG);
  pkg.dependencies['new-thing'] = '^1.0.0';
  const diff = diffDependencySpecifiers({ pkg, lockImporter: readLockImporter(LOCK, 'apps/desktop') });
  assert.deepEqual(diff.missing, ['dependencies/new-thing']);
  assert.deepEqual(diff.drifted, []);
});

/* ---------------------------------------- 引用提取 */

test('refs: scripts 与 build 里引用的路径都要被看到', () => {
  const refs = referencedBuildArtifacts({
    scripts: { pack: 'node scripts/build-runtime.mjs && tsc -p tsconfig.json', x: 'PILOTDECK_DESKTOP_NODE_ARCH=arm64 node scripts/download-node.mjs' },
    build: {
      afterPack: 'scripts/after-pack.cjs',
      win: { icon: 'resources/icons/icon.ico' },
      nsis: { include: 'resources/installer.nsh' },
      extraResources: [{ from: 'resources/node', to: 'node' }],
    },
  });
  for (const want of ['scripts/build-runtime.mjs', 'scripts/download-node.mjs', 'scripts/after-pack.cjs', 'resources/icons/icon.ico', 'resources/installer.nsh', 'resources/node']) {
    assert.ok(refs.includes(want), `漏了 ${want}`);
  }
  assert.ok(refs.every((r, i) => i === 0 || refs[i - 1] <= r), '未排序，输出会抖');
});

/* ---------------------------------------- 前置评估 */

/** 造一台「什么都有」的假桌面端，再用 patch 破坏单点，验证每条判定都承重。 */
function makeTree({ lock = true, assets = true, deps = true, main = true, mutate } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-desktop-'));
  const desk = path.join(root, 'apps/desktop');
  fs.mkdirSync(path.join(desk, 'src'), { recursive: true });
  fs.mkdirSync(path.join(desk, 'resources/icons'), { recursive: true });
  const pkg = {
    name: 'pilotdeck-desktop', version: '1.0.0', main: 'dist/main.js',
    dependencies: { 'electron-updater': '^6.8.9' },
    devDependencies: { electron: '^42.3.3' },
    scripts: { pack: 'node scripts/build-runtime.mjs && electron-builder --dir' },
    build: {
      afterPack: 'scripts/after-pack.cjs',
      win: { icon: 'resources/icons/icon.ico', target: [{ target: 'nsis' }] },
      extraResources: [{ from: 'resources/node', to: 'node' }],
    },
  };
  if (mutate) mutate(pkg);
  fs.writeFileSync(path.join(desk, 'package.json'), JSON.stringify(pkg));
  if (main) fs.writeFileSync(path.join(desk, 'src/main.ts'), 'export {}');
  if (lock) fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), LOCK.replace('^42.3.3', '^42.3.3'));
  if (assets) {
    fs.mkdirSync(path.join(desk, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(desk, 'scripts/build-runtime.mjs'), '');
    fs.writeFileSync(path.join(desk, 'scripts/after-pack.cjs'), '');
    fs.writeFileSync(path.join(desk, 'resources/icons/icon.ico'), '');
    fs.writeFileSync(path.join(desk, 'resources/node'), '');
  }
  if (deps) {
    fs.mkdirSync(path.join(desk, 'node_modules/electron'), { recursive: true });
    fs.mkdirSync(path.join(desk, 'node_modules/electron-builder'), { recursive: true });
  }
  return root;
}

const stateOf = (findings, id) => findings.find((f) => f.id === id)?.state;

test('prereqs: 锁里有 importer 却没有依赖段时报 missing，不报 drifted', () => {
  // drifted 让人去重新出锁（版本对不上），missing 说明锁根本没描述这个包 ——
  // 两者的下一步动作不一样，不能糊在一起。
  const root = makeTree();
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters:\n  apps/desktop: {}\n');
  const findings = evaluateDesktopPrereqs({ root, platform: 'win32', pnpmAvailable: true });
  const lock = findings.find((f) => f.id === 'desktop:lock');
  assert.equal(lock.state, 'missing');
  assert.match(lock.detail, /没有 apps\/desktop 这个 importer/);
});

test('prereqs: 一切都齐时全 ready —— 门禁不是「永远红」', () => {
  const findings = evaluateDesktopPrereqs({ root: makeTree(), platform: 'win32', pnpmAvailable: true });
  for (const finding of findings) {
    assert.equal(finding.state, 'ready', `${finding.id} 应该 ready：${finding.detail}`);
  }
  assert.equal(desktopPrereqsExit(findings, { strict: true }), 0);
});

test('prereqs: 基线外的新缺失必须被单独点名，不能被已知项吞掉', () => {
  // 反例：如果所有缺失都往基线里塞，门禁就永远不会因为「新坏掉的东西」而红。
  const root = makeTree({ mutate: (pkg) => { pkg.scripts.pack = 'node scripts/brand-new-step.mjs && electron-builder --dir'; } });
  const findings = evaluateDesktopPrereqs({ root, platform: 'win32' });
  const assets = findings.find((f) => f.id === 'desktop:assets');
  assert.equal(assets.state, 'missing');
  assert.match(assets.detail, /^package.json 引用但不存在/);
  assert.match(assets.detail, /scripts\/brand-new-step\.mjs/);
});

test('prereqs: 已知未 vendor 的缺失如实标注，但不算新问题', () => {
  // 上游只 vendor 了 src 和 package.json。门禁若因此常红就等于没有门禁。
  const real = path.resolve('pilotdeck-mobile/upstream-official');
  const findings = evaluateDesktopPrereqs({ root: real, platform: 'win32', pnpmAvailable: false });
  const assets = findings.find((f) => f.id === 'desktop:assets');
  assert.match(assets.detail, /^已知未随 vendor 进来/, '真实仓库的缺失应归入已知基线');
  assert.ok(KNOWN_MISSING.length > 0);
});

test('prereqs: lock 漂移在严格与非严格下都失败', () => {
  const root = makeTree({ mutate: (pkg) => { pkg.devDependencies.electron = '^43.0.0'; } });
  const findings = evaluateDesktopPrereqs({ root, platform: 'win32', pnpmAvailable: true });
  assert.equal(stateOf(findings, 'desktop:lock'), 'drifted');
  assert.equal(desktopPrereqsExit(findings, { strict: true }), 1);
  assert.equal(desktopPrereqsExit(findings, { strict: false }), 1, '漂移不是「已知不完整」，任何时候都该拦');
});

test('prereqs: 只剩已知缺失时非严格放过、严格拦住', () => {
  // makeTree 缺的那四项都在基线里（上游确实没 vendor），所以这是真实的「已知不完整」。
  const findings = evaluateDesktopPrereqs({
    root: makeTree({ assets: false }), platform: 'win32', pnpmAvailable: true,
  });
  const notReady = findings.filter((f) => f.state !== 'ready');
  assert.deepEqual(notReady.map((f) => f.id), ['desktop:assets']);
  assert.equal(notReady[0].baseline, true);
  assert.equal(desktopPrereqsExit(findings, { strict: false }), 0, '已知不完整不该让 CI 常红');
  assert.equal(desktopPrereqsExit(findings, { strict: true }), 1, '要真打包时它就是失败');
});

test('prereqs: 基线外的新缺失在两种模式下都拦', () => {
  const findings = evaluateDesktopPrereqs({
    root: makeTree({ mutate: (pkg) => { pkg.scripts.dist = 'node scripts/brand-new-step.mjs'; } }),
    platform: 'win32', pnpmAvailable: true,
  });
  const assets = findings.find((f) => f.id === 'desktop:assets');
  assert.equal(assets.baseline, false);
  assert.equal(desktopPrereqsExit(findings, { strict: false }), 1);
  assert.equal(desktopPrereqsExit(findings, { strict: true }), 1);
});

test('prereqs: 没有 package.json 时直接短路，不拿 null 继续算', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-empty-'));
  const findings = evaluateDesktopPrereqs({ root, platform: 'win32' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'desktop:package');
  assert.equal(desktopPrereqsExit(findings, { strict: true }), 1);
});

test('prereqs: 非 Windows 宿主打 nsis 要报漂移（上游同一条约束）', () => {
  const findings = evaluateDesktopPrereqs({ root: makeTree(), platform: 'darwin', pnpmAvailable: true });
  assert.equal(stateOf(findings, 'desktop:host'), 'drifted');
  assert.match(findings.find((f) => f.id === 'desktop:host').detail, /darwin/);
});

test('prereqs: 依赖没装 / pnpm 没有 都各报一条，不合并成「环境不行」', () => {
  const findings = evaluateDesktopPrereqs({ root: makeTree({ deps: false }), platform: 'win32', pnpmAvailable: false });
  assert.equal(stateOf(findings, 'desktop:deps'), 'missing');
  assert.equal(stateOf(findings, 'desktop:pnpm'), 'missing');
});

test('format: 默认不注入控制字符，开启后每项状态都上色', () => {
  const findings = evaluateDesktopPrereqs({ root: makeTree(), platform: 'win32', pnpmAvailable: true });
  const plain = formatDesktopPrereqs(findings);
  assert.ok(!plain.includes('\u001b'), '默认不能带 ANSI');
  const colored = formatDesktopPrereqs(findings, { color: true });
  assert.ok(colored.includes('\u001b['));
});

test('format: 结论句区分「齐备」与「未齐备」', () => {
  const ok = evaluateDesktopPrereqs({ root: makeTree(), platform: 'win32', pnpmAvailable: true });
  assert.match(formatDesktopPrereqs(ok), /前置齐备/);
  const bad = evaluateDesktopPrereqs({ root: makeTree({ deps: false }), platform: 'win32' });
  assert.match(formatDesktopPrereqs(bad), /前置未齐备（\d+ 项）/);
});

test('prereqs: 构建环境缺失（没装 electron / 没 pnpm）不拦 CI', () => {
  // 仓库内容是好的，只是这台机器不是打包机。让 CI 常红的门禁第一天就会被关掉。
  const findings = evaluateDesktopPrereqs({
    root: makeTree({ deps: false }), platform: 'win32', pnpmAvailable: false,
  });
  const notReady = findings.filter((f) => f.state !== 'ready');
  assert.deepEqual(notReady.map((f) => f.id).sort(), ['desktop:deps', 'desktop:pnpm']);
  assert.ok(notReady.every((f) => f.category === 'environment'));
  assert.equal(desktopPrereqsExit(findings, { strict: false }), 0);
  assert.equal(desktopPrereqsExit(findings, { strict: true }), 1);
});

test('prereqs: 每条结论都带 category，否则退出码会静默漏判', () => {
  // 漏标 category 的 finding 既不算 repo 也不算 environment：非严格下永远不拦。
  for (const tree of [{}, { assets: false }, { deps: false }, { lock: false }, { main: false }]) {
    const findings = evaluateDesktopPrereqs({ root: makeTree(tree), platform: 'win32', pnpmAvailable: true });
    for (const finding of findings) {
      assert.ok(['repo', 'environment'].includes(finding.category), `${finding.id} 的 category 缺失：${finding.category}`);
    }
  }
});
