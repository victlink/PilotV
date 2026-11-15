/**
 * 调度器账本：任务队列的落盘与重启恢复。
 *
 * 为什么要有落盘
 * --------------
 * 调度器把「熔断」改写成「暂停后自动续跑」之后，**任务的连续性就变成了
 * 一个跨进程的承诺**：进程重启、gateway 崩了、被 supervisor 换 pid 之后，
 * 排队中的任务不该凭空消失。否则「自动续跑」只在进程活着时有效，
 * 而 2026-11-13 的事故恰恰就是 gateway 崩了导致任务停在半截。
 *
 * 设计沿用 `commanderLoopStore.js` 的既有约定（产品规则「明文可审计」）：
 *   - 纯 JSON，人能直接读；
 *   - 原子写（临时文件 + rename），恢复守护不会读到半截；
 *   - 坏文件改名留证，不静默删除；
 *   - 终态追加到 `history.jsonl` 后删除 running 文件 —— 删除是
 *     「不会再自动恢复」的唯一凭据，所以必须先 append 成功。
 *
 * 与 commander 账本的区别：调度器账本记的是**队列**而不是**循环**。
 * 一个任务在调度器账本里的生命周期是
 * `queued → running → paused → queued → … → done`，只有真正结束才进历史。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { resolvePilotHome, sanitizeSessionIdForPath } from '../utils/pilotPaths.js';

export const RESOURCE_SCHEDULER_SCHEMA = 1;
export const RESOURCE_SCHEDULER_DIR_NAME = 'taskmaster';

export function getTaskmasterDir(home = resolvePilotHome()) {
    return path.join(home, RESOURCE_SCHEDULER_DIR_NAME);
}

/**
 * 文件名用 hash 后缀，避免 `web:s_x` 与 `web-s_x` sanitize 成同名后互相覆盖。
 */
export function taskmasterFileName(taskId) {
    const safe = sanitizeSessionIdForPath(String(taskId ?? 'task')).slice(0, 32);
    const digest = createHash('sha256').update(String(taskId ?? '')).digest('hex').slice(0, 16);
    return `${safe}-${digest}.json`;
}

function taskFilePath(taskId, home) {
    return path.join(getTaskmasterDir(home), taskmasterFileName(taskId));
}

/** 内存任务 → 账本记录（纯函数）。 */
export function toStoredTask(task, { now = Date.now() } = {}) {
    return {
        schema: RESOURCE_SCHEDULER_SCHEMA,
        id: task.id,
        sessionKey: task.sessionKey ?? task.id,
        projectPath: task.projectPath ?? null,
        goal: task.goal ?? '',
        priority: task.priority ?? 0,
        status: task.status ?? 'queued',
        cost: { ...(task.cost ?? {}) },
        enqueuedAt: task.enqueuedAt ?? now,
        startedAt: task.startedAt ?? null,
        lastProgressAt: task.lastProgressAt ?? null,
        progressCount: task.progressCount ?? 0,
        attempts: task.attempts ?? 0,
        pauseCount: task.pauseCount ?? 0,
        pauseReason: task.pauseReason ?? null,
        pauseHint: task.pauseHint ?? null,
        resumeHint: task.resumeHint ?? null,
        resumeAt: task.resumeAt ?? null,
        stopReason: task.stopReason ?? null,
        lastStall: task.lastStall ?? null,
        updatedAt: now,
    };
}

/** 账本记录 → 调度器任务（纯函数）。 */
export function fromStoredTask(record) {
    return {
        id: record.id,
        sessionKey: record.sessionKey ?? record.id,
        projectPath: record.projectPath ?? null,
        goal: record.goal ?? '',
        priority: record.priority ?? 0,
        status: record.status ?? 'queued',
        cost: { ...(record.cost ?? {}) },
        enqueuedAt: record.enqueuedAt ?? Date.now(),
        startedAt: record.startedAt ?? null,
        lastProgressAt: record.lastProgressAt ?? null,
        progressCount: record.progressCount ?? 0,
        attempts: record.attempts ?? 0,
        pauseCount: record.pauseCount ?? 0,
        pauseReason: record.pauseReason ?? null,
        pauseHint: record.pauseHint ?? null,
        resumeHint: record.resumeHint ?? null,
        resumeAt: record.resumeAt ?? null,
        stopReason: record.stopReason ?? null,
        lastStall: record.lastStall ?? null,
    };
}

/** 原子写。 */
export function saveTask(task, { home, now = Date.now() } = {}) {
    const dir = getTaskmasterDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const record = toStoredTask(task, { now });
    const target = taskFilePath(record.id, home);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    try {
        fs.renameSync(tmp, target);
    } catch {
        // Windows 上少数文件系统不允许 rename 覆盖，退化为直接写目标文件。
        try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
        fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
    return record;
}

function isValidRecord(record) {
    return record
        && typeof record === 'object'
        && record.schema === RESOURCE_SCHEDULER_SCHEMA
        && typeof record.id === 'string'
        && record.id.length > 0;
}

/**
 * 读账本目录。
 *
 * `pending` —— 还在队列里（queued / paused），重启后应当继续排队；
 * `finished` —— 已经结束但文件没删干净（append 成功、删除失败），清掉即可；
 * `corrupted` —— 坏文件，改名留证。
 */
export function readTaskRecords({ home } = {}) {
    const dir = getTaskmasterDir(home);
    const pending = [];
    const finished = [];
    const corrupted = [];
    let files;
    try {
        files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
        return { pending, finished, corrupted };
    }
    const now = Date.now();
    for (const name of files) {
        const filePath = path.join(dir, name);
        let record;
        try {
            record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            corrupted.push(filePath);
            try { fs.renameSync(filePath, `${filePath}.bad-${now}`); } catch { /* ignore */ }
            continue;
        }
        if (!isValidRecord(record)) {
            corrupted.push(filePath);
            try { fs.renameSync(filePath, `${filePath}.bad-${now}`); } catch { /* ignore */ }
            continue;
        }
        if (record.status === 'done' || record.status === 'failed' || record.status === 'cancelled') {
            finished.push(record);
            continue;
        }
        pending.push(record);
    }
    pending.sort((a, b) => (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
    return { pending, finished, corrupted };
}

/** 归档：先追加历史，再删 running 文件。 */
export function archiveTask(task, { home, now = Date.now(), status = 'done', reason = null } = {}) {
    const dir = getTaskmasterDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const record = toStoredTask(task, { now });
    record.status = status;
    record.stopReason = reason ?? task.stopReason ?? null;
    record.archivedAt = new Date(now).toISOString();
    fs.appendFileSync(path.join(dir, 'history.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    try { fs.rmSync(taskFilePath(record.id, home), { force: true }); } catch { /* ignore */ }
    return record;
}

/** 只删账本，不写历史。 */
export function deleteTask(taskId, { home } = {}) {
    try { fs.rmSync(taskFilePath(taskId, home), { force: true }); } catch { /* ignore */ }
}
