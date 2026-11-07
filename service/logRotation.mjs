// 日志轮转：把「一个日志能把磁盘写满」这件事从制度上消掉。
//
// 起因：HANDOFF-Windows #3.1 记录了一次 autostart 死循环，.run/autostart.log
// 长到 1.82 GB。当时只有 autostart 那一条路径有轮转，其它 .run/*.log 全裸奔；
// 而真正需要的不是「给某个文件加轮转」，是「任何写日志的地方都默认有上限」。
//
// 设计约束：
//   1. 绝不抛异常。调用方是守护进程和启动器，轮转失败只是磁盘治理没做成，
//      不该顺手把被守护的服务搞挂。所有失败都变成返回值里的 reason。
//   2. Windows 上正在被占用的文件改名会 EPERM/EBUSY。这是常态而不是异常：
//      网关进程自己握着 agent.log。跳过它，下一轮再试。
//   3. 命名沿用既有的 .prev.log，兼容 HANDOFF 里已经存在的排障习惯。

import fs from 'node:fs';
import path from 'node:path';

/** 单个日志文件的上限。5 MB 够装下几千条结构化行，又不至于吃掉磁盘。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** 轮转后保留几份历史。两份 = 出事时能对比「上一轮」和「这一轮」。 */
export const DEFAULT_KEEP = 2;

/** .run/agent.log 的历史文件叫 .run/agent.prev.log / .prev2.log。 */
export function historyPath(file, index) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (!base.toLowerCase().endsWith('.log')) {
    return path.join(dir, `${base}.${index}.bak`);
  }
  const stem = base.slice(0, -4);
  return path.join(dir, index === 1 ? `${stem}.prev.log` : `${stem}.prev${index}.log`);
}

/**
 * 需要就轮转一个文件。返回 { rotated, reason?, bytes? }，永不抛。
 */
export function rotateFile(file, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_KEEP;
  let bytes;
  try {
    bytes = fs.statSync(file).size;
  } catch (error) {
    return { rotated: false, reason: error.code === 'ENOENT' ? 'missing' : error.code || String(error) };
  }
  if (bytes <= maxBytes) return { rotated: false, reason: 'under-limit', bytes };

  // 从最老的一份往后挪，先把超出保留份数的删掉。
  try {
    for (let index = keep; index >= 1; index -= 1) {
      const from = historyPath(file, index);
      if (index === keep) {
        try { fs.rmSync(from, { force: true }); } catch { /* 没有历史文件 */ }
        continue;
      }
      const to = historyPath(file, index + 1);
      try { fs.renameSync(from, to); } catch { /* 这一份不存在或被占用 */ }
    }
    fs.renameSync(file, historyPath(file, 1));
    return { rotated: true, bytes };
  } catch (error) {
    // 被占用（Windows）或权限问题：保持原文件不动，下一轮再来。
    return { rotated: false, reason: error.code || String(error), bytes };
  }
}

/**
 * 轮转一个目录下所有匹配的日志。启动器和 doctor 用它做「兜底清扫」：
 * 就算某个服务自己忘了轮转，磁盘也不会被写满。
 */
export function rotateDir(dir, options = {}) {
  const pattern = options.pattern || /\.log$/i;
  const skip = options.skip || [];
  const skipped = new Set(skip.map(file => path.basename(file)));
  const results = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return { ok: false, reason: error.code || String(error), results };
  }
  for (const entry of entries) {
    if (!pattern.test(entry) || skipped.has(entry)) continue;
    const file = path.join(dir, entry);
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch { continue; }
    results.push({ file, ...rotateFile(file, options) });
  }
  return { ok: true, results };
}

/** doctor 用：把目录下各日志的体积摊开来看，超限的点名。 */
export function scanLogSizes(dir, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const pattern = options.pattern || /\.log$/i;
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!pattern.test(entry)) continue;
      const file = path.join(dir, entry);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) files.push({ file, name: entry, bytes: stat.size, overLimit: stat.size > maxBytes });
      } catch { /* 读不了就跳过 */ }
    }
  } catch { return files; }
  return files.sort((a, b) => b.bytes - a.bytes);
}
