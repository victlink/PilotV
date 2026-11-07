// pilotv deploy 的命令层：采集事实 -> 出计划 -> （显式 --apply 才）下发执行。
//
// 默认只出计划。部署是这台机器上少数会改远端状态的动作，一条「顺手就做了」的
// 命令足以让人不敢在自己机器上跑它；而计划本身已经回答了 90% 的「这台还缺什么」。
//
// 事实分三种：满足 / 不满足 / 没探到。设备离线时把一切判成「不满足」是撒谎 ——
// 它可能什么都不缺，只是没开机。没探到的东西照「要执行」处理（宁可多跑一次幂等
// 脚本），但文案里必须写明是未确认，不能伪装成观测结果。

import { execFile } from 'node:child_process';
import process from 'node:process';

import { probeHttp, probeTcp } from './probes.mjs';
import { buildRemoteCommand, judgeArtifactsProbe, judgeSelfCheck, formatPlan, planDeployment, resolveDevice, deviceFromManifest, shellQuote } from './deploy.mjs';
import { readDeviceManifest } from '../service/deviceManifest.mjs';

export const DEFAULT_REPO_URL = 'git@github.com:VICTLINK/PilotV.git';
const SSH_TIMEOUT_MS = 12000;

/**
 * 远端只读体检：只看装没装、在不在，一个字节都不写。
 *
 * 服务定义按平台两处找：Mac 是 launchd 的 plist，Linux/NAS 是 systemd 的 unit。
 * 只看文件在不在，不 start、不 reload —— 那是改变状态的动作，不属于探测。
 * 路径一律走 DEV_DIR 变量并加引号，devDir 带空格才不会把一条命令拆成三条。
 */
export function buildRemoteProbeScript(devDir) {
  return [
    'set -u',
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin:$PATH"',
    `DEV_DIR=${shellQuote(devDir)}`,
    'UI="$DEV_DIR/pilotdeck-mobile/upstream-official/ui"',
    'for c in git node npm python3; do command -v "$c" >/dev/null 2>&1 || echo "MISSING=$c"; done',
    'command -v node >/dev/null 2>&1 && echo "NODE=$(node -v)"',
    'if [ -d "$DEV_DIR/.git" ]; then echo REPO=yes; else echo REPO=no; fi',
    'if [ -f "$UI/dist/index.html" ]; then echo DIST=yes; else echo DIST=no; fi',
    'if [ -d "$UI/node_modules" ]; then echo DEPS=yes; else echo DEPS=no; fi',
    'if ls "$HOME/Library/LaunchAgents/"*pilotv* >/dev/null 2>&1'
      + ' || ls /etc/systemd/system/*pilotv* "$HOME/.config/systemd/user/"*pilotv* >/dev/null 2>&1; '
      + 'then echo SERVICE=yes; else echo SERVICE=no; fi',
    'echo DONE',
  ].join('\n');
}
/** 把远端体检输出解析成 facts 片段。认不出的输出 -> 未知，而不是「一切正常」。 */
export function parseRemoteProbe(output) {
  const text = String(output || '');
  if (!/DONE/.test(text)) return { ok: false };
  const missing = [...text.matchAll(/^MISSING=(\S+)$/gm)].map((m) => m[1]);
  const nodeVersion = /NODE=(\S+)/.exec(text)?.[1] || '';
  return {
    ok: true,
    commandsOk: missing.length === 0,
    commands: ['git', 'node', 'npm', 'python3'].filter((c) => !missing.includes(c)),
    missingCommands: missing,
    nodeVersion,
    repoReady: /REPO=yes/.test(text),
    repoExists: /REPO=(yes|no)/.test(text),
    uiDistReady: /DIST=yes/.test(text),
    depsReady: /DEPS=yes/.test(text),
    serviceReady: /SERVICE=yes/.test(text),
  };
}

function runSsh({ host, script, timeoutMs = SSH_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    // BatchMode：需要输密码就直接失败。一条自检命令卡在密码提示上，
    // 表现是「命令转圈不返回」，比干脆的失败难查得多。
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'bash -s'],
      { input: script, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, stdout: stdout || '', error }));
  });
}

export async function gatherFacts({ device, devDir, ssh = true, timeoutMs = 4000 }) {
  const facts = {};
  const notes = [];

  const [gateway, artifacts] = await Promise.all([
    probeTcp({ host: device.host, port: device.gatewayPort, timeoutMs }),
    probeTcp({ host: device.host, port: device.artifactsPort, timeoutMs }),
  ]);
  facts.gatewayListening = gateway.ok;
  facts.artifactsListening = artifacts.ok;

  if (artifacts.ok) {
    const health = await probeHttp(`http://${device.host}:${device.artifactsPort}/api/artifacts/health`, { timeoutMs });
    const judged = judgeArtifactsProbe({ status: health.status, bodyOk: !!health.body && health.body.ok === true });
    facts.sidecarReady = judged.ready;
    if (judged.note) notes.push(judged.note);
  } else {
    facts.sidecarReady = null;
    notes.push(`成果台端口 ${device.artifactsPort} 没探到监听：${artifacts.error?.code || '未知原因'}`);
  }

  // 网关是不是 HTTPS 只能试：明文敲 TLS 端口会 EPROTO，那恰恰说明证书在用。
  if (gateway.ok) {
    const plain = await probeHttp(`http://${device.host}:${device.gatewayPort}/`, { timeoutMs });
    const code = plain.error?.code || '';
    facts.certReady = code === 'EPROTO' || String(plain.headers?.location || '').startsWith('https');
    facts.gatewayProbe = { status: plain.status || 0, code };
  } else {
    facts.certReady = null;
  }

  // 服务定义这类事实只有登进去才看得到。ssh 不通就标未知，别猜。
  Object.assign(facts, { commandsOk: null, repoReady: null, uiDistReady: null, depsReady: null, serviceReady: null });
  if (ssh) {
    const probe = await runSsh({ host: device.host, script: buildRemoteProbeScript(devDir) });
    const parsed = parseRemoteProbe(probe.stdout);
    if (parsed.ok) {
      Object.assign(facts, parsed);
    } else {
      notes.push(`登不上 ${device.host}，远端依赖/仓库/构建状态未确认（部署脚本本身幂等，会自己补）`);
    }
  } else {
    notes.push('已跳过 ssh 探测（--no-ssh）：远端依赖/仓库/构建状态未确认');
  }

  // 「起来了」= 网关端口通 且 成果台健康。两个都要，只起一半是最常见的假正常。
  facts.selfCheckOk = judgeSelfCheck({ gatewayListening: facts.gatewayListening, sidecarReady: facts.sidecarReady });
  return { facts, notes };
}

export async function runDeploy(options = {}) {
  const manifestFile = options.manifest || 'pilotdeck-mobile/upstream-official/ui/public/devices.json';
  let manifest;
  try {
    manifest = readDeviceManifest(manifestFile);
  } catch (error) {
    return { ok: false, exitCode: 1, summary: `读设备清单失败：${error.message}`, error };
  }

  const devices = (manifest.devices || []).map(deviceFromManifest).filter(Boolean);
  const resolved = resolveDevice(devices, options._?.[0] || options.device);
  if (resolved.error) return { ok: false, exitCode: 2, summary: resolved.error };

  const devDir = options.devDir || '~/PilotV';
  const { facts, notes } = await gatherFacts({
    device: resolved.device, devDir, ssh: options.ssh !== false,
    timeoutMs: Number(options.timeoutMs) || 4000,
  });
  const plan = planDeployment({ device: resolved.device, facts, devDir });
  const command = buildRemoteCommand({
    repoUrl: options.repoUrl || process.env.PILOTV_REPO_URL || DEFAULT_REPO_URL,
    devDir, device: resolved.device,
  });

  const lines = [formatPlan(plan)];
  if (notes.length) lines.push('', '探测备注：', ...notes.map((n) => `  - ${n}`));

  if (!options.apply) {
    lines.push('', plan.noop
      ? '无需改动。要执行请加 --apply。'
      : `未执行。确认无误后加 --apply 下发（会走 ssh，并在那台机器上跑 scripts/deploy_pilotv_device.sh）。`);
    return { ok: true, plan, notes, remote: command.remote, dryRun: true, summary: lines.join('\n'), exitCode: 0 };
  }

  if (options.ssh === false) {
    return { ok: false, exitCode: 2, summary: '--apply 需要 ssh；当前带了 --no-ssh。', plan };
  }

  lines.push('', '开始下发（输出透传）：');
  const applied = await runSsh({ host: resolved.device.host, script: command.remote, timeoutMs: Number(options.applyTimeoutMs) || 900000 });
  lines.push(applied.stdout.trim() || '(无输出)');
  if (applied.error) {
    lines.push('', `下发失败：${applied.error.killed ? '超时被终止' : applied.error.message}`,
      '远端脚本是幂等的，修掉原因后可以直接重跑。');
    return { ok: false, exitCode: 1, plan, summary: lines.join('\n') };
  }
  lines.push('', '下发完成。再跑一次 `pilotv deploy <device>` 应显示「已经是目标状态」。');
  return { ok: true, plan, summary: lines.join('\n'), exitCode: 0 };
}