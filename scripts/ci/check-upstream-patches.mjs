#!/usr/bin/env node
// 上游补丁通道门禁：patches/ 里的每张 patch 必须能被 `git apply` 校验通过。
//
// 为什么要有这道门：这三处修复是手工改进 vendor 的，没有任何机制会在上游更新后
// 提醒我们。历史上它们被覆盖过一次，表现是「gateway 偶尔整体退出」，查了两天才
// 发现是修复没了。verify_windows.ps1 当时用的是「在文件里搜一句注释」，那个办法
// 有两个致命问题：① 它搜的是 pilotdeck.ts 里的字符串，而守卫后来被抽到了
// runtimeCrashGuards.ts，于是它一直报 FAIL，而没人知道那次 FAIL 是真的还是脚本
// 自己过期了；② 注释在只能证明「有人写过这句话」，不能证明这段代码还在、还是对的。
// 现在改成拿 patch 本身做校验：能对得上才算在位。
//
// 三态判定（这很重要，只有「过 / 不过」的话，报错等于没说）：
//   applied   反向 apply 通过 —— patch 与工作区逐字节吻合。
//   missing   正向 apply 通过 —— 修复被上游覆盖回去了，重放即可。
//   drifted   两个方向都不通过 —— 上游改动了这块，patch 需要重新生成。
// 只有 applied 算通过。missing 和 drifted 都要红，但修法不同，所以分开报。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PATCH_DIR = 'patches';

/** patch 文件名 → 稳定 key。`0001-crash-guards.patch` → `crash-guards`。 */
export function patchKey(file) {
  return path.posix.basename(file).replace(/^\d+-/, '').replace(/\.patch$/, '');
}

export function listPatchFiles(root) {
  const dir = path.join(root, PATCH_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.patch')).sort();
}

function gitApplyCheck(root, args) {
  try {
    execFileSync('git', ['apply', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** 对单张 patch 做三态判定。 */
export function classifyPatch(root, file) {
  const rel = `${PATCH_DIR}/${file}`;
  if (gitApplyCheck(root, ['--reverse', '--check', '-p1', rel])) return 'applied';
  if (gitApplyCheck(root, ['--check', '-p1', rel])) return 'missing';
  return 'drifted';
}

export function evaluate(entries) {
  const problems = [];
  if (entries.length === 0) {
    problems.push(`patches/ 里一张 patch 都没有。要么补丁通道没落地，要么目录被误删。`);
  }
  // 白名单而不是黑名单：判定函数以后多返回一种状态时，黑名单会把它悄悄放过去。
  const applied = entries.filter((e) => e.state === 'applied');
  const notApplied = entries.filter((e) => e.state !== 'applied');
  const missing = entries.filter((e) => e.state === 'missing');
  const drifted = entries.filter((e) => e.state === 'drifted');
  const unknown = notApplied.filter((e) => e.state !== 'missing' && e.state !== 'drifted');
  if (missing.length > 0) {
    problems.push(`${missing.length} 张补丁未落地（上游覆盖）：${missing.map((e) => e.key).join(', ')}`);
  }
  if (drifted.length > 0) {
    problems.push(`${drifted.length} 张补丁与当前代码对不上（上游改动过这块）：${drifted.map((e) => e.key).join(', ')}`);
  }
  if (unknown.length > 0) {
    problems.push(`${unknown.length} 张补丁状态无法判读：${unknown.map((e) => `${e.key}=${e.state}`).join(', ')}`);
  }
  return { ok: problems.length === 0, entries, applied, missing, drifted, unknown, problems };
}

export function formatText(result) {
  const lines = [`上游补丁通道：${result.entries.length} 张 patch`];
  for (const entry of result.entries) {
    const mark = entry.state === 'applied' ? 'ok  ' : 'FAIL';
    lines.push(`${mark} ${entry.key}  ${entry.state}  ${entry.file}`);
  }
  if (result.ok) {
    lines.push('全部已落地 —— OK');
    return lines.join('\n');
  }
  for (const problem of result.problems) lines.push(`FAIL ${problem}`);
  if (result.missing.length > 0) {
    lines.push(`     怎么办：git apply -p1 ${PATCH_DIR}/<对应 patch>，然后跑 UP 的回归测试`);
  }
  if (result.drifted.length > 0) {
    lines.push('     怎么办：上游改动了这段代码，patch 需要按新代码重新生成（别硬改 patch 文本）');
  }
  return lines.join('\n');
}

export function run(root = process.cwd()) {
  const entries = listPatchFiles(root).map((file) => ({
    key: patchKey(file),
    file,
    state: classifyPatch(root, file),
  }));
  return evaluate(entries);
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