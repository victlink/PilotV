// fixManifest 是唯一会写盘的 doctor 路径，所以它的边界要用真文件测：
// 内容一致不许动 mtime（幂等）、dist 不存在不许擅自替 vite 造目录、
// 源清单有问题时一个字都不写。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fixManifest } from './doctor-command.mjs';

const GOOD = JSON.stringify({
  devices: [{ name: 'marc-pc', origin: 'http://marc-pc.tail2b98e5.ts.net:3001', artifactsPort: 8799 }],
}, null, 2) + '\n';

function makeRoot({ dist = true, source = GOOD } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-fixmf-'));
  const ui = path.join(root, 'pilotdeck-mobile', 'upstream-official', 'ui');
  fs.mkdirSync(path.join(ui, 'public'), { recursive: true });
  fs.writeFileSync(path.join(ui, 'public', 'devices.json'), source);
  if (dist) {
    fs.mkdirSync(path.join(ui, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(ui, 'dist', 'devices.json'), '{"devices":[]}\n');
  }
  return { root, distFile: path.join(ui, 'dist', 'devices.json') };
}

test('fixManifest：不一致 -> 写盘，内容变成源清单的规范化结果', () => {
  const { root, distFile } = makeRoot();
  try {
    const result = fixManifest({ root });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(distFile, 'utf8')).devices,
      [{ name: 'marc-pc', origin: 'http://marc-pc.tail2b98e5.ts.net:3001', artifactsPort: 8799 }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixManifest：已经一致 -> 不写盘（重跑第二遍没有副作用）', () => {
  const { root, distFile } = makeRoot();
  try {
    fixManifest({ root });
    const before = fs.statSync(distFile);
    const written = before.mtimeMs;
    const again = fixManifest({ root });
    assert.equal(again.finding.severity, 'pass');
    assert.match(again.summary, /未写盘/);
    assert.equal(fs.statSync(distFile).mtimeMs, written, '内容一致时连 mtime 都不该变');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixManifest：dist 还没构建 -> 报失败而不是替 vite 造一个 dist', () => {
  const { root } = makeRoot({ dist: false });
  try {
    const result = fixManifest({ root });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.finding.severity, 'fail');
    assert.equal(fs.existsSync(path.join(root, 'pilotdeck-mobile/upstream-official/ui/dist')), false,
      '擅自造 dist 会把「没构建」这个事实藏起来');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixManifest：源清单有问题 -> 一个字都不写', () => {
  const { root, distFile } = makeRoot({ source: JSON.stringify({ devices: [{ name: 'x', origin: 'http://REPLACE_ME:3001' }] }) });
  try {
    const before = fs.readFileSync(distFile, 'utf8');
    const result = fixManifest({ root });
    assert.equal(result.finding.severity, 'warn');
    assert.equal(fs.readFileSync(distFile, 'utf8'), before, '源清单可疑时绝不能把脏数据同步出去');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixManifest：源清单整个读不到 -> 失败并说明原因，不抛异常', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-fixmf-'));
  try {
    const result = fixManifest({ root });
    assert.equal(result.ok, false);
    assert.match(result.summary, /未写盘/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixManifest：落盘走「临时文件 + rename」，绝不直接覆盖目标', () => {
  // 直接 writeFileSync(target) 的表现是：写一半掉电或被杀，dist 里剩半份 JSON，
  // 前端读到语法错误的清单 —— 比同步失败难查得多。
  const { root, distFile } = makeRoot();
  const writes = [];
  const renames = [];
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  fs.writeFileSync = (target, ...rest) => {
    writes.push(path.basename(String(target)));
    return originalWrite.call(fs, target, ...rest);
  };
  fs.renameSync = (from, to) => {
    renames.push([path.basename(String(from)), String(to)]);
    return originalRename.call(fs, from, to);
  };
  try {
    assert.equal(fixManifest({ root }).ok, true);
    assert.equal(writes.length, 1, '只该有一次写入');
    assert.notEqual(writes[0], 'devices.json', '写的一定不能是目标文件本身');
    assert.match(writes[0], /^devices\.json\.tmp-\d+$/);
    assert.deepEqual(renames, [[writes[0], distFile]], '再由 rename 原子地换成目标');
  } finally {
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
