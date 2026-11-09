// pilotv doctor —— 把 verify_windows.ps1 + verify_loop.py 里那些「早就写好但没人跑」
// 的检查合成一条命令。设计约束三条：
//   * 只读：不改配置、不重启服务、不写盘（写属于 --fix 或网关启动流程）
//   * 快：默认并发探测，整套跑完应在数秒内；慢的检查没人会跑第二次
//   * 可机读：--json 给 CI 和别的 agent 用；退出码只由 fail 决定

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeProbeError, evaluateCertExpiry, evaluateHealthz, evaluateLogSize,
  evaluateManifestSync, evaluatePorts, evaluateUpstreamPatches, formatText, summarize,
} from './doctor.mjs';
import { certExpiry, compareManifestPair, listListeners, logSizes, probeHttp, probeTcp } from './probes.mjs';
import { classifyPatch, patchKey } from '../scripts/ci/check-upstream-patches.mjs';
import { readDeviceManifest, syncDeviceManifestSync } from '../service/deviceManifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/** 这台机器上四个必需服务 + 两个可选。端口是唯一事实来源。 */
export const EXPECTED_PORTS = [
  { port: 3001, name: 'PilotV 后端', required: true },
  { port: 18789, name: 'agent gateway', required: true },
  { port: 5186, name: '前端网关', required: true },
  { port: 8799, name: '成果台', required: true },
  { port: 8801, name: '成果台 MCP 侧车', required: false },
  { port: 18790, name: 'supervisor 单实例锁', required: false },
];

// 补丁是否在位，改由 patches/ 里的 patch 本身判定（git apply --check），不再
// 在源码里搜注释。搜注释这件事上过一次当：守卫从 pilotdeck.ts 抽到
// runtimeCrashGuards.ts 之后，verify_windows.ps1 还在按旧文件搜旧字符串，
// 于是一直报一个假 FAIL —— 而没人能判断那次 FAIL 是真的还是脚本自己过期了。
export const UPSTREAM_PATCHES = [
  '0001-crash-guards.patch',
  '0002-partial-summary.patch',
  '0003-tolerant-decoder.patch',
];

/**
 * @param {{ root?: string, json?: boolean, color?: boolean, timeoutMs?: number }} options
 */
export async function runDoctor(options = {}) {
  const root = options.root || REPO_ROOT;
  const timeoutMs = options.timeoutMs ?? 4000;
  const findings = [];

  // 端口与 HTTP 探活并行跑：串行等 6 个超时最坏要 24 秒，没人受得了。
  const [listeners, healthz, devicesApi] = await Promise.all([
    listListeners(EXPECTED_PORTS.map(entry => entry.port)),
    // /healthz 属于 agent gateway(18789)。5186 是前端网关，它会把未知路径当
    // 前端路由交给 SPA，回一坨 HTML 加 200 —— 探错端口会得到一个假健康。
    probeHttp('http://127.0.0.1:18789/healthz', { timeoutMs }),
    probeHttp('https://127.0.0.1:5186/api/pilotv/devices', { timeoutMs }),
  ]);
  findings.push(...evaluatePorts(EXPECTED_PORTS, listeners));

  // 5186 是 HTTPS：探一下实际协议，别再靠文档猜。
  const plain = await probeHttp('http://127.0.0.1:5186/health', { timeoutMs });
  if (plain.status === 200) {
    findings.push({
      id: 'gateway:tls', title: '前端网关强制 HTTPS', severity: 'fail',
      detail: 'http:// 也能通，说明 TLS 没生效',
      fix: '安卓装 PWA 需要安全上下文：配 PILOTV_TLS_CERT/PILOTV_TLS_KEY 后重启',
    });
  } else if (plain.error) {
    const verdict = describeProbeError(plain.error, 'http://127.0.0.1:5186');
    findings.push({ id: 'gateway:tls', title: '前端网关只监听 HTTPS', severity: 'pass', detail: `明文端口如预期不通（${verdict.code}）` });
  } else {
    findings.push({ id: 'gateway:tls', title: '前端网关强制 HTTPS', severity: 'pass', detail: `http:// 返回 ${plain.status}` });
  }

  // /healthz 与设备接口
  if (healthz.error) {
    const verdict = describeProbeError(healthz.error, 'http://127.0.0.1:18789/healthz');
    findings.push({ id: 'healthz', title: '网关健康明细', severity: verdict.severity, detail: verdict.detail, fix: verdict.fix });
  } else {
    findings.push(evaluateHealthz(healthz.body, healthz.status, { rawText: healthz.text || "" }));
  }
  findings.push(devicesApi.status === 200
    ? { id: 'api:devices', title: '设备接口 /api/pilotv/devices', severity: 'pass', detail: `HTTP 200，${Array.isArray(devicesApi.body?.devices) ? devicesApi.body.devices.length : '?'} 台` }
    : { id: 'api:devices', title: '设备接口 /api/pilotv/devices', severity: 'fail', detail: `HTTP ${devicesApi.status || '不通'}`, fix: '看网关日志；设备接口是切换器的前提' });

  // 设备清单：源清单本身 + 两份是否一致
  const publicFile = path.join(root, 'pilotdeck-mobile/upstream-official/ui/public/devices.json');
  const distFile = path.join(root, 'pilotdeck-mobile/upstream-official/ui/dist/devices.json');
  const parsed = readDeviceManifest(publicFile);
  if (parsed.problems.length > 0) {
    findings.push({
      id: 'devices:source', title: '设备清单内容', severity: 'warn',
      detail: parsed.problems.join('; ').slice(0, 300),
      fix: '改完 ui/public/devices.json 要重启 5186',
    });
  } else {
    findings.push({ id: 'devices:source', title: '设备清单内容', severity: 'pass', detail: `${parsed.devices.length} 台，无占位符` });
  }
  findings.push(evaluateManifestSync(compareManifestPair(publicFile, distFile)));

  // 三处上游补丁
  findings.push(evaluateUpstreamPatches(readPatches(root, UPSTREAM_PATCHES)));

  // 证书
  const certFile = process.env.PILOTV_TLS_CERT
    // 和 start-windows.ps1 里的 $TlsDir 保持一致；两处不一致就等于每次换机器都要重查。
    || path.join(os.homedir(), '.pilotdeck', 'tls', 'pilotv-fullchain.pem');
  const cert = certExpiry(certFile);
  if (cert.daysRemaining === null && cert.error === 'ENOENT') {
    findings.push({ id: 'tls:expiry', title: '网关证书', severity: 'warn', detail: `没找到证书文件（${certFile}）`, fix: '未启用 TLS，或用 PILOTV_TLS_CERT 指到实际位置' });
  } else if (cert.daysRemaining === null) {
    findings.push({ id: 'tls:expiry', title: '网关证书', severity: 'warn', detail: `读不出有效期（${cert.error || '格式不认识'}）`, fix: '证书不是标准 PEM/X.509，续期脚本大概也会栽在这里' });
  } else {
    findings.push(evaluateCertExpiry(cert.daysRemaining, cert.notBeforeDays));
  }

  // 日志体积：1.82 GB 那次的教训是「只盯着一个文件」
  const sizes = logSizes(path.join(root, '.run'));
  if (sizes.length === 0) {
    findings.push({ id: 'log:total', title: '运行日志', severity: 'warn', detail: '.run 下没有 .log（没起过？还是在别的目录）' });
  } else {
    const worst = sizes[0];
    findings.push(evaluateLogSize(worst.name, worst.bytes));
    const bigOnes = sizes.filter(entry => entry.bytes > 5 * 1024 * 1024).length;
    if (bigOnes > 1) {
      findings.push({ id: 'log:many', title: '多个日志同时超尺寸', severity: 'warn', detail: `${bigOnes} 个超过 5 MB`, fix: '轮转可能整体没生效，不只是某一个文件' });
    }
  }

  // 网关进程是不是在反复重启：PID 变了就是重启过
  const gateway = listeners.filter(entry => entry.port === 18789);
  if (gateway.length === 1) {
    await sleep(1500);
    const after = await listListeners([18789]);
    const same = after.length === 1 && after[0].pid === gateway[0].pid;
    findings.push(same
      ? { id: 'gateway:stable', title: '网关 PID 稳定', severity: 'pass', detail: `pid ${gateway[0].pid} 未变` }
      : { id: 'gateway:stable', title: '网关 PID 稳定', severity: 'fail', detail: `1.5 秒内从 ${gateway[0].pid} 变成 ${after.map(a => a.pid).join(',') || '没了'}`, fix: '在反复重启：看 .run/agent.log 末尾与退避计数' });
  }

  return summarize(findings);
}

function readPatches(root, patches) {
  // 同步即可：git apply --check 本身是同步的，三张 patch 也花不了多少时间。
  return patches.map((file) => {
    const state = classifyPatch(root, file);
    return { key: patchKey(file), file, state, present: state === 'applied' };
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export { formatText };


/**
 * 把 ui/public/devices.json 同步到 ui/dist/devices.json。
 *
 * 为什么 doctor 自己不写盘、这件事要单独开一个 --fix：自检工具为了「让检查
 * 通过」去改被检查的东西，检查就再也不能信了。所以 doctor 默认只读，写这个动作
 * 必须显式要求。写本身复用网关启动时那份实现（内容一致就不动、临时文件 + rename
 * 原子落盘、dist 目录不存在时不擅自替 vite 造一个）。
 */
export function fixManifest(options = {}) {
  const root = options.root || REPO_ROOT;
  const sourceFile = path.join(root, 'pilotdeck-mobile/upstream-official/ui/public/devices.json');
  const targetFile = path.join(root, 'pilotdeck-mobile/upstream-official/ui/dist/devices.json');
  const result = syncDeviceManifestSync(sourceFile, targetFile, { createTargetDir: options.createTargetDir === true });
  const finding = evaluateManifestSync(result);
  return {
    ok: finding.severity === 'pass',
    from: sourceFile,
    to: targetFile,
    finding,
    exitCode: finding.severity === 'fail' ? 1 : 0,
    summary: result.synced
      ? `已同步：${sourceFile} -> ${targetFile}`
      : `未写盘（${finding.detail}）\n       怎么办：${finding.fix || ''}`,
  };
}
