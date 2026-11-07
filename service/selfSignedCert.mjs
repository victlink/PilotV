// 生成测试/初始化用的自签证书。
//
// 为什么单独成模块：之前它内联在 pilotv_gateway.test.mjs 里，只认 openssl。
// 结果是两个 TLS 用例在 Windows 开发机上长期 skip —— 也就是说「网关真的会用
// https 应答」这条行为在我们改转发协议时**没有任何本地验证**，只在 Linux CI 上跑。
// 而 P3 的 `pilotv setup` 同样要签发本地证书，正好共用。
//
// 能力链：openssl（Linux runner / 装了 Git for Windows 的机器）→ python cryptography
// （本机 .venv 之外的系统 python 里有）。两个都没有才 skip，并在原因里写清楚。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PY = `
import sys
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

key_path, cert_path = sys.argv[1], sys.argv[2]
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
now = datetime.now(timezone.utc)
cert = (
    x509.CertificateBuilder()
    .subject_name(name)
    .issuer_name(name)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - timedelta(days=1))
    .not_valid_after(now + timedelta(days=2))
    .add_extension(x509.SubjectAlternativeName([x509.IPAddress(__import__("ipaddress").IPv4Address("127.0.0.1"))]), critical=False)
    .sign(key, hashes.SHA256())
)
with open(key_path, "wb") as handle:
    handle.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
with open(cert_path, "wb") as handle:
    handle.write(cert.public_bytes(serialization.Encoding.PEM))
`;

function probe(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** 找到能用的证书工具；找不到返回 null，调用方据此 skip 并说明原因。 */
export function detectCertTool() {
  if (probe('openssl', ['version'])) return 'openssl';
  for (const candidate of ['python', 'python3']) {
    if (probe(candidate, ['-c', 'import cryptography'])) return candidate;
  }
  return null;
}

export function tlsCapability() {
  const tool = detectCertTool();
  return tool
    ? { ok: true, tool }
    : { ok: false, reason: '需要 openssl 或带 cryptography 的 python 才能签发自签证书' };
}

/**
 * 在 dir 里生成一份自签证书（仅测试/内网初始化用，不做任何信任设置）。
 * @returns {{ key: string, cert: string, tool: string }}
 */
export function createSelfSignedCert(dir, options = {}) {
  const key = options.keyPath || path.join(dir, 'k.pem');
  const cert = options.certPath || path.join(dir, 'c.pem');
  const tool = options.tool || detectCertTool();
  if (!tool) throw new Object.assign(new Error(tlsCapability().reason), { code: 'NO_CERT_TOOL' });

  if (tool === 'openssl') {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return { key, cert, tool };
  }

  const script = path.join(dir, `__selfsigned-${process.pid}.py`);
  fs.writeFileSync(script, PY);
  try {
    execFileSync(tool, [script, key, cert], { stdio: 'ignore' });
  } finally {
    try { fs.rmSync(script, { force: true }); } catch { /* 清不掉也不影响结果 */ }
  }
  return { key, cert, tool };
}