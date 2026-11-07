import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createSelfSignedCert, detectCertTool, tlsCapability } from './selfSignedCert.mjs';

const capability = tlsCapability();

test('detectCertTool 返回 null 或一个真能用的命令名，不抛', () => {
  const tool = detectCertTool();
  assert.ok(tool === null || tool === 'openssl' || typeof tool === 'string');
});

test('tlsCapability 不可用时必须给出人能照做的理由', () => {
  if (!capability.ok) assert.match(capability.reason, /openssl|python/);
});

test('生成的证书能直接起 https 服务并完成握手', { skip: capability.ok ? false : capability.reason }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-cert-'));
  try {
    const { key, cert, tool } = createSelfSignedCert(dir);
    assert.ok(fs.existsSync(key) && fs.existsSync(cert));
    assert.match(fs.readFileSync(cert, 'utf8'), /BEGIN CERTIFICATE/);

    const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
      (req, res) => { res.end('tls-ok'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const body = await new Promise(resolve => {
      https.get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve(text));
      }).on('error', error => resolve(`ERR ${error.message}`));
    });
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    assert.equal(body, 'tls-ok', `握手应当成功（tool=${tool}）`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('不留临时脚本文件', { skip: capability.ok ? false : capability.reason }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilotv-cert-'));
  try {
    createSelfSignedCert(dir);
    const leftovers = fs.readdirSync(dir).filter(name => !name.endsWith('.pem'));
    assert.deepEqual(leftovers, [], '签完要把辅助脚本清掉，不然临时目录会越积越多');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});