// 轮转模块的行为测试。重点不在「会不会改名」，
// 而在「出问题的时候会不会把宿主进程带下去」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_BYTES, historyPath, rotateDir, rotateFile, scanLogSizes } from './logRotation.mjs';

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('historyPath 沿用既有的 .prev.log 命名', () => {
  assert.equal(historyPath('/x/agent.log', 1), path.join('/x', 'agent.prev.log'));
  assert.equal(historyPath('/x/agent.log', 2), path.join('/x', 'agent.prev2.log'));
  // 非 .log 文件不猜扩展名，整名加后缀，避免把 foo.json 改写成 foo.1.bak 丢掉类型。
  assert.equal(historyPath('/x/out.txt', 1), path.join('/x', 'out.txt.1.bak'));
});

test('没超限就不动文件', async () => {
  const dir = await tempDir('pilotv-rot-');
  try {
    const file = path.join(dir, 'a.log');
    await fsp.writeFile(file, 'x'.repeat(100));
    const result = rotateFile(file, { maxBytes: 1024 });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, 'under-limit');
    assert.equal(fsSync.existsSync(file), true);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('超限就轮转，并留出空的原文件句柄位置', async () => {
  const dir = await tempDir('pilotv-rot-');
  try {
    const file = path.join(dir, 'a.log');
    await fsp.writeFile(file, 'x'.repeat(2048));
    const result = rotateFile(file, { maxBytes: 1000 });
    assert.equal(result.rotated, true);
    assert.equal(result.bytes, 2048);
    assert.equal(fsSync.existsSync(file), false, '原文件应当已改名，等待下一个 append 重建');
    assert.equal(fsSync.existsSync(historyPath(file, 1)), true);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('keep=2 时历史只留两份，最老的被挤掉', async () => {
  const dir = await tempDir('pilotv-rot-');
  try {
    const file = path.join(dir, 'a.log');
    for (let round = 1; round <= 4; round += 1) {
      await fsp.writeFile(file, String(round).repeat(2048));
      rotateFile(file, { maxBytes: 1000, keep: 2 });
    }
    assert.equal(fsSync.existsSync(historyPath(file, 1)), true);
    assert.equal(fsSync.existsSync(historyPath(file, 2)), true);
    assert.equal(fsSync.existsSync(historyPath(file, 3)), false, '超出 keep 的历史必须被清掉，否则轮转只是把磁盘问题改名而已');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('文件不存在 / 目录不可读都不抛异常', () => {
  assert.equal(rotateFile(path.join(os.tmpdir(), 'definitely-not-here-pilotv.log')).rotated, false);
  const missing = rotateDir(path.join(os.tmpdir(), 'definitely-not-here-pilotv'));
  assert.equal(missing.ok, false);
  assert.equal(missing.results.length, 0);
});

test('rotateDir 扫整个 .run，只动 .log，并跳过点名排除的文件', async () => {
  const dir = await tempDir('pilotv-rot-');
  try {
    await fsp.writeFile(path.join(dir, 'big.log'), 'x'.repeat(2048));
    await fsp.writeFile(path.join(dir, 'small.log'), 'x');
    await fsp.writeFile(path.join(dir, 'keep.log'), 'x'.repeat(2048));
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'x'.repeat(2048));
    const { results } = rotateDir(dir, { maxBytes: 1000, skip: ['keep.log'] });
    const byName = Object.fromEntries(results.map(entry => [path.basename(entry.file), entry.rotated]));
    assert.equal(byName['big.log'], true);
    assert.equal(byName['small.log'], false);
    assert.equal(byName['keep.log'], undefined, '被排除的文件不该出现在结果里');
    assert.equal(fsSync.existsSync(path.join(dir, 'keep.log')), true);
    assert.equal(fsSync.existsSync(path.join(dir, 'notes.txt')), true, '非 .log 文件不该被碰');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('scanLogSizes 从大到小点名，超限的标出来（doctor 的输入）', async () => {
  const dir = await tempDir('pilotv-rot-');
  try {
    await fsp.writeFile(path.join(dir, 'small.log'), 'x');
    await fsp.writeFile(path.join(dir, 'huge.log'), 'x'.repeat(4096));
    const files = scanLogSizes(dir, { maxBytes: 1000 });
    assert.deepEqual(files.map(entry => entry.name), ['huge.log', 'small.log']);
    assert.equal(files[0].overLimit, true);
    assert.equal(files[1].overLimit, false);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('默认上限是 5 MB（计划里定的口径）', () => {
  assert.equal(DEFAULT_MAX_BYTES, 5 * 1024 * 1024);
});
