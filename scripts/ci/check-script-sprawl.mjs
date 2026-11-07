#!/usr/bin/env node
// 脚本蔓延门禁：scripts/ 顶层的一次性脚本数量不许超过基线，且不许留下
// 指向已归档脚本的断链。
//
// 为什么单独设一道门：计划审计里「130+ 个一次性脚本」不是洁癖问题 —— 同一个
// 检查有四个版本、每个 slightly 不一样、没有一个在 CI 里跑，新设备来了必然
// 重复踩坑。P2 把它们收进 pilotv CLI 并归档了 97 个；没有这道门，半年后这里
// 会长回原样，而这轮的投入就只剩一份归档。
//
// 两道检查都按「门禁必须会红」设计：
//   1) 顶层脚本数 > BASELINE 就失败。基线是实数，不是「大约 40」。
//   2) 归档后仍有人按 scripts/<旧名> 引用 = 断链。这类引用不会报错，
//      只会在半年后某个人照着文档敲命令时得到「文件不存在」。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-11-08：P2 归档 97 个之后实测 40 个。要往下调随时可以，往上调要说清理由。
export const BASELINE = 40;
export const ARCHIVE_DIR = 'scripts/_archive';
const SCRIPTS_DIR = 'scripts';

// 这些目录里的东西不参与「引用」判定：归档内容互相提到彼此是正常的，
// 依赖/虚拟环境/构建产物不是我们的文档。
const SKIP_REF_PREFIXES = [`${ARCHIVE_DIR}/`, '.venv/', 'node_modules/', 'pilotdeck-mobile/upstream-official/node_modules/'];

function trackedFiles(root) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

export function countTopLevelScripts(files) {
  return files.filter((f) => f.startsWith(`${SCRIPTS_DIR}/`) && path.posix.dirname(f) === SCRIPTS_DIR);
}

export function archivedNames(files) {
  return new Set(files.filter((f) => f.startsWith(`${ARCHIVE_DIR}/`)).map((f) => path.posix.basename(f)));
}

/**
 * 找出仍然按老路径引用已归档脚本的文件。
 * 归档目录内部除外 —— 它们彼此之间的用法示例已经一并改过。
 */
export function findBrokenArchiveRefs(files, isArchived, readFile) {
  const broken = [];
  for (const file of files) {
    if (SKIP_REF_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    // 归档文件自身按新路径被引用是正常的；但按「旧路径」引用就是断链。
    let text;
    try { text = readFile(file); } catch { continue; }
    for (const name of isArchived) {
      if (text.includes(`${SCRIPTS_DIR}/${name}`) && !text.includes(`${ARCHIVE_DIR}/${name}`)) {
        broken.push({ file, target: `${SCRIPTS_DIR}/${name}` });
      } else if (text.includes(`${SCRIPTS_DIR}/${name}`)) {
        // 两种路径都出现过：逐行看，出现旧路径的那一行才算断链。
        text.split('\n').forEach((line, index) => {
          if (line.includes(`${SCRIPTS_DIR}/${name}`) && !line.includes(`${ARCHIVE_DIR}/${name}`)) {
            broken.push({ file, target: `${SCRIPTS_DIR}/${name}`, line: index + 1 });
          }
        });
      }
    }
  }
  return broken;
}

export function evaluate({ count, baseline = BASELINE, broken }) {
  const problems = [];
  if (count > baseline) {
    problems.push(`scripts/ 顶层有 ${count} 个脚本，基线是 ${baseline}。`);
  }
  if (broken.length > 0) {
    problems.push(`${broken.length} 处引用指向已归档脚本的旧路径。`);
  }
  return { ok: problems.length === 0, count, baseline, broken, problems };
}

export function formatText(result) {
  const lines = [`脚本蔓延：scripts/ 顶层 ${result.count} 个（基线 ${result.baseline}）`];
  if (result.ok) {
    lines.push(`归档 ${result.archivedCount ?? 0} 个，无断链 —— OK`);
    return lines.join('\n');
  }
  for (const problem of result.problems) lines.push(`FAIL ${problem}`);
  if (result.count > result.baseline) {
    lines.push('     怎么办：能并进 pilotv 子命令的并进去（doctor / verify / export / deploy）；');
    lines.push('     确实要留的，落到具体服务的测试或 scripts/_archive/，别在顶层攒新的。');
  }
  for (const hit of result.broken.slice(0, 20)) {
    lines.push(`FAIL ${hit.file}${hit.line ? `:${hit.line}` : ''} 还在引用 ${hit.target}`);
  }
  return lines.join('\n');
}

export function run(root = process.cwd()) {
  const files = trackedFiles(root);
  const current = countTopLevelScripts(files);
  const archived = archivedNames(files);
  const broken = findBrokenArchiveRefs(files, archived, (file) => fs.readFileSync(path.join(root, file), 'utf8'));
  const result = evaluate({ count: current.length, broken });
  result.archivedCount = archived.size;
  return result;
}

// 比较解析后的绝对路径：Windows 下 import.meta.url 与 argv[1] 的字面写法不一致，
// 直接拼 file:// 前缀会永远不相等，脚本变成「只能被 import、不能直接跑」。
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const result = run();
  process.stdout.write(`${formatText(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}