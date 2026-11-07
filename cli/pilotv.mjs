#!/usr/bin/env node
// pilotv —— 把一个仓库里 130 多个脚本收敛成一个入口。
//
// 为什么值得做这件事：脚本本身不是问题，「同一个检查有四个版本、每个版本 slightly
// 不一样、没有一个在 CI 里跑」才是问题。HANDOFF 里那句「新设备必然重复踩坑」的
// 结构性原因就在这里。这个 CLI 不重写它们的全部能力，先只做三件最常被需要的：
//   doctor        我现在到底好不好？（只读）
//   verify --live 真开一个浏览器走一遍关键路径，留截图当证据
//   deploy        把这套东西装到另一台设备（后续接）
//
// 零运行时依赖：网关、supervisor、侧车都是零依赖 node，CLI 跟着这个约束走，
// 否则它会变成「装 PilotV 还得先装一堆东西」的那个东西。

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const USAGE = `pilotv —— PilotV 统一入口

用法：
  pilotv doctor [--json] [--no-color]     只读体检：端口/健康/证书/清单/日志/上游补丁
                                          --fix-manifest 是唯一会写盘的开关（同步设备清单到 dist）
  pilotv verify --live [--base URL]       真 Chromium 走一遍登录→切设备→成果台，截图落 review/
  pilotv export --out FILE [--base URL]   成果清单导出为 xlsx（数字由代码算，不手抄）
  pilotv deploy <device> [--apply]        看这台设备还缺什么（默认只出计划，加 --apply 才下发）
                                          --no-ssh 只按端口探测；--dev-dir 远端开发目录
  pilotv --help                          

退出码：0 = 没有失败项（提醒不算失败）；1 = 有失败项；2 = 命令用法不对。
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--json') options.json = true;
    else if (token === '--no-color') options.color = false;
    else if (token === '--fix-manifest') options.fixManifest = true;
    else if (token === '--live') options.live = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { options[token.slice(2)] = next; i += 1; }
      else options[token.slice(2)] = true;
    } else options._.push(token);
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (!command || options.help || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }

  if (command === 'doctor') {
    const { runDoctor, fixManifest } = await import('./doctor-command.mjs');
    const { formatText } = await import('./doctor.mjs');
    // doctor 本体只读：写盘只能由显式的 --fix-manifest 触发，
    // 否则「自检通过」可能只是它自己把被检查的东西改过了。
    if (options.fixManifest) {
      const fixed = fixManifest({ root: options.root });
      process.stdout.write(`${fixed.summary}\n\n`);
    }
    const report = await runDoctor(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatText(report, { color: options.color !== false })}\n`);
    }
    return report.exitCode;
  }

  if (command === 'verify') {
    const { verifyLive } = await import('./verify-live.mjs');
    const result = await verifyLive(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.summary}\n`);
    return result.ok ? 0 : 1;
  }

  if (command === 'export') {
    const { exportArtifacts } = await import('./export-artifacts.mjs');
    const result = await exportArtifacts(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.summary}\n`);
    // 用法错（格式不认识）和跑挂了不是一回事：前者 2、后者 1，脚本才能分流。
    return result.exitCode ?? (result.ok ? 0 : 1);
  }

  if (command === 'deploy') {
    const { runDeploy } = await import('./deploy-command.mjs');
    const result = await runDeploy(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.summary}\n`);
    return result.exitCode ?? (result.ok ? 0 : 1);
  }

  process.stderr.write(`pilotv: 不认识的操作 "${command}"\n\n${USAGE}`);
  return 2;
}

// 只有被当成命令跑才执行；被 import（测试）时不产生任何副作用。
// 比较解析后的绝对路径：Windows 下 import.meta.url 与 argv[1] 的字面写法不一致，
// 直接比字符串会 Linux 正常、Windows 永远不执行（supervisor 已经踩过这个坑）。
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      // CLI 失败要把原因留全：只说「命令挂了」等于把排障交还给下一个人。
      console.error('[pilotv] 命令执行失败:', error);
      process.exitCode = 1;
    },
  );
}
