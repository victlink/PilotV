import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildToolManifest,
  createToolHandlers,
  doctorPayload,
  exportPayload,
  resolveExportOptions,
  allowedVerifyHosts,
  assertVerifyBase,
  sdkCandidatePaths,
  sdkNotFoundError,
  toToolError,
  toToolResult,
  verifyPayload,
} from './mcp-tools.mjs';

const ROOT = path.join(process.cwd(), 'repo-root-fixture');
const ALLOWED_DIR = path.join(ROOT, 'review', 'exports');

function textOf(result) {
  assert.equal(result.content.length, 1);
  return result.content[0].text;
}

/* ------------------------------------------------------- 工具面形状 */

test('manifest: exactly the three read-only tools are exposed', () => {
  const names = buildToolManifest().map((tool) => tool.name).sort();
  // 白名单而不是黑名单：以后有人把 deploy / fix-manifest 包进来，这里必须变红。
  assert.deepEqual(names, ['pilotv_doctor', 'pilotv_export_artifacts', 'pilotv_verify_live']);
});

test('manifest: every tool is describable and schema-typed', () => {
  for (const tool of buildToolManifest()) {
    assert.ok(tool.name.startsWith('pilotv_'), `${tool.name} 需要前缀`);
    assert.ok(tool.description.length > 120, `${tool.name} 说明太短，模型不会知道什么时候用`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(Array.isArray(tool.inputSchema.required), `${tool.name} 缺 required`);
  }
});

test('manifest: no tool accepts a credential-shaped argument', () => {
  for (const tool of buildToolManifest()) {
    for (const key of Object.keys(tool.inputSchema.properties)) {
      assert.doesNotMatch(key, /user|password|token|secret|key/i, `${tool.name}.${key} 会把凭据带进模型上下文`);
    }
  }
});

/* ------------------------------------------------------- 只读约束 */

test('doctor: refuses the write switch instead of performing it', async () => {
  let called = 0;
  const handlers = createToolHandlers({ runDoctor: async () => { called += 1; return { findings: [], exitCode: 0 }; } });
  const result = await handlers.pilotv_doctor({ fixManifest: true });
  assert.equal(result.isError, true);
  assert.equal(called, 0, '体检本身都不该跑，何况写盘');
  assert.match(textOf(result), /fix-manifest/);
});

test('doctor: passes the timeout through and keeps severity plus fix', async () => {
  let seen;
  const handlers = createToolHandlers({
    runDoctor: async (options) => {
      seen = options;
      return {
        exitCode: 1,
        findings: [
          { id: 'ports:gateway', severity: 'fail', title: '网关端口', detail: '没人监听', fix: '先起服务' },
          { id: 'tls:expiry', severity: 'warn', title: '证书', detail: '还剩 20 天' },
          { id: 'healthz', severity: 'pass', title: '健康', detail: 'ok' },
          { id: 'weird', severity: 'other', title: '不该计入', detail: '?' },
        ],
      };
    },
  });
  const result = await handlers.pilotv_doctor({ timeoutMs: 1234 });
  assert.equal(seen.timeoutMs, 1234);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.counts, { pass: 1, warn: 1, fail: 1 });
  assert.equal(payload.findings.length, 4, '明细不能因为精简就丢条目');
  assert.equal(payload.findings[0].fix, '先起服务', '没有 fix 的项，模型就只知道坏了不知道怎么修');
  assert.ok(payload.findings[1].fix === undefined, 'undefined 不该被序列化成字段');
});

test('doctor: warn without fail is not reported as broken', async () => {
  const handlers = createToolHandlers({
    runDoctor: async () => ({
      exitCode: 0,
      findings: [
        { id: 'a', severity: 'warn', title: 'A', detail: 'd' },
        { id: 'b', severity: 'pass', title: 'B', detail: 'd' },
      ],
    }),
  });
  const payload = JSON.parse(textOf(await handlers.pilotv_doctor({})));
  assert.equal(payload.ok, true);
  assert.match(payload.verdict, /提醒/);
});

/* ------------------------------------------------------- 凭据约束 */

test('verify: credential arguments are refused before anything launches', async () => {
  for (const key of ['user', 'username', 'password', 'token']) {
    let launched = 0;
    const handlers = createToolHandlers({ verifyLive: async () => { launched += 1; return { ok: true, steps: [] }; } });
    const result = await handlers.pilotv_verify_live({ [key]: 'x' });
    assert.equal(result.isError, true, `${key} 必须被拒`);
    assert.equal(launched, 0, `${key} 不该走到启动浏览器`);
  }
});

test('verify: base stays on loopback or a host listed in the manifest', () => {
  assert.equal(assertVerifyBase('http://127.0.0.1:3001', {}), 'http://127.0.0.1:3001');
  assert.equal(assertVerifyBase('https://marc-pc.tail2b98e5.ts.net:3001', { allowedHosts: ['marc-pc.tail2b98e5.ts.net'] }), 'https://marc-pc.tail2b98e5.ts.net:3001');
  assert.equal(assertVerifyBase('http://jx88:3001', { allowedHosts: ['jx88'] }), 'http://jx88:3001');
  assert.equal(assertVerifyBase('', { defaultBase: 'http://127.0.0.1:5186' }), 'http://127.0.0.1:5186');
  assert.throws(() => assertVerifyBase('http://evil.example.com', {}), /拒绝驱动/);
  assert.throws(() => assertVerifyBase('http://someone-elses-box.tail2b98e5.ts.net:3001', { allowedHosts: ['marc-pc.tail2b98e5.ts.net'] }), /拒绝驱动/,
    '同一个 tailnet 不等于可以随便驱动别人的机器');
  assert.throws(() => assertVerifyBase('not a url', {}), /合法 URL/);
  assert.throws(() => assertVerifyBase('file:///C:/Windows', {}), /只支持 http\/https/);
});

test('verify: keeps screenshots, since evidence beats prose', async () => {
  const handlers = createToolHandlers({
    verifyLive: async (options) => {
      assert.equal(options.cdpPort, 9417);
      return {
        ok: false,
        base: 'http://127.0.0.1:5186',
        fatal: 'unreachable',
        steps: [{ name: '服务可达', ok: false, detail: '没人监听', reason: 'ECONNREFUSED' }],
        screenshots: ['review\\a.png', 'review\\b.png'],
        consoleErrors: Array.from({ length: 40 }, (_, i) => `e${i}`),
        failedRequests: ['http://x/api'],
      };
    },
  });
  const payload = JSON.parse(textOf(await handlers.pilotv_verify_live({ cdpPort: 9417 })));
  assert.deepEqual(payload.screenshots, ['review\\a.png', 'review\\b.png']);
  assert.equal(payload.fatal, 'unreachable');
  assert.equal(payload.steps[0].reason, 'ECONNREFUSED', '「服务没起」和「页面坏了」必须分得开');
  assert.equal(payload.consoleErrors.length, 20, '刷屏的错误日志要截断，否则一次 verify 就吃掉整个上下文');
});

/* ------------------------------------------------------- 路径约束 */

test('export: an explicit output path is refused', () => {
  assert.throws(
    () => resolveExportOptions({ out: 'C:/Users/music/startup.bat' }, { repoRoot: ROOT }),
    /不支持 out/,
  );
});

test('export: outDir cannot escape review/exports', () => {
  assert.throws(() => resolveExportOptions({ outDir: 'C:/Windows' }, { repoRoot: ROOT }), /必须在/);
  assert.throws(() => resolveExportOptions({ outDir: path.join('review', '..', '..', 'evil') }, { repoRoot: ROOT }), /必须在/);
  assert.throws(() => resolveExportOptions({ outDir: path.join('review', 'exportsibling') }, { repoRoot: ROOT }), /必须在/,
    '前缀相同的兄弟目录不算在里面');
});

test('export: the allowed directory and format are settled', () => {
  assert.deepEqual(resolveExportOptions({}, { repoRoot: ROOT }), { format: 'xlsx', outDir: ALLOWED_DIR });
  assert.deepEqual(
    resolveExportOptions({ format: 'csv', outDir: path.join('review', 'exports', 'nov'), base: 'http://127.0.0.1:8799' }, { repoRoot: ROOT }),
    { format: 'csv', outDir: path.join(ALLOWED_DIR, 'nov'), base: 'http://127.0.0.1:8799' },
  );
  assert.throws(() => resolveExportOptions({ format: 'pdf' }, { repoRoot: ROOT }), /只认 xlsx/);
});

test('export: totals survive the trip so a human question can be answered', async () => {
  const handlers = createToolHandlers({
    repoRoot: ROOT,
    exportArtifacts: async (options) => {
      assert.equal(options.outDir, ALLOWED_DIR);
      return {
        ok: true, file: path.join(ALLOWED_DIR, 'x.xlsx'), format: 'xlsx',
        totals: { total: 278, byStatus: { approved: 5 } },
        sheets: [{ name: '明细', rows: 278 }], complete: true, pages: 2,
      };
    },
  });
  const payload = JSON.parse(textOf(await handlers.pilotv_export_artifacts({})));
  assert.deepEqual(payload.totals, { total: 278, byStatus: { approved: 5 } });
  assert.equal(payload.complete, true);
  assert.equal(payload.pages, 2);
});

test('export: a failed export comes back as a tool error, not a crash', async () => {
  const handlers = createToolHandlers({
    exportArtifacts: async () => ({ ok: false, summary: '读取成果清单失败：ECONNREFUSED', exitCode: 1 }),
  });
  const result = await handlers.pilotv_export_artifacts({});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /ECONNREFUSED/);
});

/* ------------------------------------------------------- 设备清单面 */

test('verify allowlist: it comes from the device manifest, deduped and tolerant', () => {
  assert.deepEqual(
    allowedVerifyHosts([
      { name: 'marc-pc', origin: 'http://marc-pc.tail2b98e5.ts.net:3001' },
      { name: 'jx88', origin: 'http://ai-jx88.tail2b98e5.ts.net:3001' },
      { name: 'dup', origin: 'http://marc-pc.tail2b98e5.ts.net:3002' },
    ]),
    ['marc-pc.tail2b98e5.ts.net', 'ai-jx88.tail2b98e5.ts.net'],
  );
});

test('verify allowlist: a broken manifest degrades to loopback-only, not to "allow anything"', () => {
  assert.deepEqual(allowedVerifyHosts([{ name: 'x', origin: 'not a url' }]), []);
  assert.deepEqual(allowedVerifyHosts([{ name: 'x' }]), []);
  assert.deepEqual(allowedVerifyHosts(), []);
  assert.throws(() => assertVerifyBase('http://marc-pc.tail2b98e5.ts.net:3001', { allowedHosts: allowedVerifyHosts([{ origin: 'oops' }]) }),
    /拒绝驱动/);
});

test('verify: the allowlist actually reaches the handler', async () => {
  let launched = 0;
  const handlers = createToolHandlers({
    allowedVerifyHosts: ['jx88'],
    verifyLive: async () => { launched += 1; return { ok: true, steps: [], screenshots: [] }; },
  });
  const ok = await handlers.pilotv_verify_live({ base: 'http://jx88:3001' });
  assert.equal(ok.isError, undefined);
  assert.equal(launched, 1);
  const bad = await handlers.pilotv_verify_live({ base: 'http://someone-else:3001' });
  assert.equal(bad.isError, true);
  assert.equal(launched, 1, '被拒的那次不能已经把浏览器起来了');
});

test('handlers: a thrown error becomes a tool error, never a dead connection', async () => {
  const boom = async () => { throw new Error('服务没起'); };
  const handlers = createToolHandlers({ runDoctor: boom, verifyLive: boom, exportArtifacts: boom });
  for (const name of ['pilotv_doctor', 'pilotv_verify_live', 'pilotv_export_artifacts']) {
    const result = await handlers[name]({});
    assert.equal(result.isError, true, name + ' 必须把异常挪成工具结果');
    assert.match(textOf(result), /服务没起/, name + ' 要把原因留给模型');
  }
});

test('handlers: a missing arguments object is treated as empty, not a crash', async () => {
  let seen;
  const handlers = createToolHandlers({ runDoctor: async (options) => { seen = options; return { findings: [], exitCode: 0 }; } });
  const result = await handlers.pilotv_doctor(undefined);
  assert.equal(result.isError, undefined);
  assert.equal(seen.timeoutMs, undefined);
});

test('verify: host matching ignores case on both sides', () => {
  // 清单里的主机名大小写和实际访问的不一致是常事（Windows 主机名）。
  // 归一化没做好的表现不是报错，是把自己的设备当成外人拒掉，难排。
  assert.equal(assertVerifyBase('http://JX88:3001', { allowedHosts: ['jx88'] }), 'http://jx88:3001');
  assert.equal(assertVerifyBase('http://jx88:3001', { allowedHosts: ['JX88'] }), 'http://jx88:3001');
  assert.deepEqual(
    allowedVerifyHosts([{ origin: 'http://Marc-PC.Tail2B98E5.ts.net:3001' }]),
    ['marc-pc.tail2b98e5.ts.net'],
  );
});

/* ------------------------------------------------------- 协议壳形状 */

test('results: payload travels as JSON text, errors stay on the connection', () => {
  const ok = toToolResult({ a: 1 });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(ok)), { a: 1 });
  const bad = toToolError('nope');
  assert.equal(bad.isError, true);
  assert.equal(textOf(bad), 'nope', '错误必须是纯文本，别让人去解一层 JSON');
});

test('sdk lookup: the configured source comes first and no empty paths appear', () => {
  const withBoth = sdkCandidatePaths({
    env: { PILOTDECK_SRC: path.join('D:', 'PilotDeck-src') },
    homedir: () => path.join('C:', 'Users', 'music'),
  });
  assert.equal(withBoth[0], path.join('D:', 'PilotDeck-src', 'node_modules', '@modelcontextprotocol', 'sdk'));
  assert.ok(withBoth.every((entry) => entry && !entry.includes('undefined')));
  const homeOnly = sdkCandidatePaths({ env: {}, homedir: () => path.join('C:', 'Users', 'music') });
  assert.ok(homeOnly.some((entry) => entry.startsWith(path.join('C:', 'Users', 'music'))));
  assert.ok(homeOnly.every((entry) => !entry.startsWith(path.join('', 'node_modules'))));
});

test('sdk lookup: the POSIX-only candidate stays off Windows', () => {
  const win = sdkCandidatePaths({ env: {}, homedir: () => path.join('C:', 'Users', 'music'), sep: '\\' });
  assert.ok(!win.some((entry) => entry.includes('opt')), '在 Windows 上出现 \opt\PilotDeck 只会让报错信息更难读');
  const nix = sdkCandidatePaths({ env: {}, homedir: () => '/home/marc', sep: '/' });
  assert.ok(nix.includes(path.join('/opt', 'PilotDeck', 'node_modules', '@modelcontextprotocol', 'sdk')));
});

test('sdk lookup: the failure message lists what it tried', () => {
  const message = sdkNotFoundError(['/a/sdk', '/b/sdk']);
  assert.match(message, /PILOTDECK_SRC/);
  assert.ok(message.includes('/a/sdk') && message.includes('/b/sdk'), '得告楚找过哪里，否则换设备的人会去查网络');
});

test('exportPayload: a missing file is visible as null, not omitted', () => {
  assert.equal(exportPayload({ ok: false, summary: 'x' }).file, null);
  assert.equal(verifyPayload({ ok: true }).screenshots.length, 0);
});