// 用真实宿主代码验证插件能被加载 —— 不重写一份 validateManifest，
// 否则测的是我自己的复制品，不是 3001 实际会做的事。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateManifest } from '../../pilotdeck-mobile/upstream-official/ui/server/utils/plugin-loader.js';
import { startPluginServer } from '../../pilotdeck-mobile/upstream-official/ui/server/utils/plugin-process-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(HERE, '..', '..', 'plugins-src', 'gateway-keeper');

test('manifest: the real host validator accepts it', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, result.error);
});

test('manifest: every file the manifest points at exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
  for (const rel of [manifest.entry, manifest.server]) {
    assert.ok(fs.existsSync(path.join(PLUGIN_DIR, rel)), `${rel} 不存在，宿主会在运行期才发现`);
    assert.ok(!rel.includes('..'), '宿主会拒绝带 .. 的路径');
  }
});

test('entry: it is an ES module with mount/unmount, as the host loader imports it', async () => {
  // 宿主用 Blob URL import()，等价于按 ESM 加载且要求这两个导出。
  const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
  assert.equal(typeof mod.mount, 'function');
  assert.equal(typeof mod.unmount, 'function');
});

test('entry: the entry has no bare or relative imports (Blob URL cannot resolve them)', () => {
  const text = fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
  assert.match(text, /export async function mount/);
  assert.ok(!/^\s*import\s/m.test(text), 'Blob URL 里 import 会解析失败，面板只会显示「加载失败」');
});

test('server: the real host process manager gets a ready line and never spawns here', async () => {
  // 把插件拷到临时目录再跑，不能就地跑：就地跑会让 keeper 从自身位置找到真仓库。
  // env 靠不住：宿主只传 PATH/HOME/NODE_ENV/PLUGIN_NAME，而 Windows 上 os.homedir()
  // 在 HOME 不可信时会回落到真实 profile，候选扫描仍然会命中本机仓库。
  // 唯一可控的是插件目录内的 keeper.json，所以这里用它开 dryRun：
  // 判定照算、日志照报、但结构上不会 spawn。测试凌晨跑和现在跑结果一样。
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-keeper-'));
  const pluginCopy = path.join(stage, 'gateway-keeper');
  fs.mkdirSync(pluginCopy);
  for (const file of ['manifest.json', 'server.mjs', 'index.js', 'keeper-core.mjs']) {
    fs.copyFileSync(path.join(PLUGIN_DIR, file), path.join(pluginCopy, file));
  }
  fs.writeFileSync(path.join(pluginCopy, 'keeper.json'), JSON.stringify({ dryRun: true }), 'utf8');
  try {
    const port = await startPluginServer('gateway-keeper', pluginCopy, 'server.mjs');
    assert.ok(Number.isInteger(port) && port > 0, `宿主应拿到端口，收到 ${port}`);
    const status = await fetchStatus(port);
    assert.equal(status.lockPort, 18790);
    assert.equal(status.dryRun, true, 'dryRun 配置没生效，面板会说谎');
    assert.equal(status.spawnCount, 0, '这条测试绝不允许拉起真实 supervisor');
    // 锁被线上 supervisor 持有时判 idle，没人持有时判 dry-run；两者都不许动手。
    assert.ok(['idle', 'dry-run', 'cooldown', 'wait', 'blocked'].includes(status.lastAction),
      `不该出现真正的动作，收到 ${status.lastAction}`);
  } finally {
    const { stopAllPlugins } = await import('../../pilotdeck-mobile/upstream-official/ui/server/utils/plugin-process-manager.js');
    await stopAllPlugins();
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

function fetchStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/status`, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
  });
}
