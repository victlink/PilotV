/**
 * 自动推进（commander loop）的磁盘账本与恢复判据。
 *
 * 为什么要有这份文件
 * ------------------
 * 旧实现把 `state.commanderLoop` 只放在 3001 进程的内存里。gateway（18789）
 * 因 V8 cppgc 断言崩溃时，WebSocket 断连 → `runChatViaGateway` 在 catch 里
 * 吞掉异常 → 循环 `finally` 清空内存状态 → supervisor 把 gateway 拉起来，
 * 但没有任何人记得「这个任务还没跑完」。表现就是界面上的自动推进开关还亮着，
 * 任务却停在一半。人可能已经接管，所以旧注释说「重启不自动续跑是刻意的」；
 * 但**用户明确打开自动推进**时，人已经授权继续跑，进程崩溃不该撤销这个授权。
 *
 * 这里的做法：把用户明确开启的循环逐轮落盘（明文 JSON，可审计），进程重启、
 * gateway 断连或 supervisor 换 pid 之后，由 UI server 的恢复守护读回账本，
 * 从下一轮判定继续。只有「正常结束 / 用户接管 / 达到上限 / 放弃恢复」才归档删除。
 *
 * 纯逻辑（转换、判据、恢复选项）与 fs I/O 分开，前者可直接单测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { COMMANDER_DEFAULT_LIMITS } from './commanderLoop.js';
import { NO_PROGRESS_STOP_REASON } from './turnStallGuard.js';
import { resolvePilotHome, sanitizeSessionIdForPath } from '../utils/pilotPaths.js';

export const COMMANDER_LOOP_SCHEMA = 2;
export const COMMANDER_LOOP_DIR_NAME = 'commander-loops';

/** 恢复守护的默认节奏。环境变量可覆盖，见 `commanderRecoveryConfig`。 */
export const COMMANDER_RECOVERY_DEFAULTS = Object.freeze({
    scanIntervalMs: 20_000,
    /** 账本还在写（说明内存里可能正在跑）时，不要抢着恢复。 */
    runningGraceMs: 90_000,
    /** 明确标记为 interrupted 的，等 gateway 喘口气即可重试。 */
    interruptedGraceMs: 15_000,
    maxRecoveryAttempts: 5,
    /** 超过一天没人动过的账本不再自动恢复，避免几个月前的任务突然开跑。 */
    staleMs: 24 * 60 * 60 * 1000,
    /** 同时跑的自动推进循环数；1 = 全局串行，直接消除双会话高并发。 */
    maxConcurrentLoops: 1,
});

export function commanderRecoveryConfig(env = process.env) {
    const int = (name, fallback) => {
        const value = Number.parseInt(String(env[name] ?? '').trim(), 10);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
        scanIntervalMs: int('PILOTV_COMMANDER_RECOVERY_SCAN_MS', COMMANDER_RECOVERY_DEFAULTS.scanIntervalMs),
        runningGraceMs: int('PILOTV_COMMANDER_RECOVERY_GRACE_MS', COMMANDER_RECOVERY_DEFAULTS.runningGraceMs),
        interruptedGraceMs: int('PILOTV_COMMANDER_RECOVERY_INTERRUPTED_GRACE_MS', COMMANDER_RECOVERY_DEFAULTS.interruptedGraceMs),
        maxRecoveryAttempts: int('PILOTV_COMMANDER_MAX_RECOVERIES', COMMANDER_RECOVERY_DEFAULTS.maxRecoveryAttempts),
        staleMs: int('PILOTV_COMMANDER_RECOVERY_STALE_MS', COMMANDER_RECOVERY_DEFAULTS.staleMs),
        maxConcurrentLoops: int('PILOTV_COMMANDER_MAX_CONCURRENT', COMMANDER_RECOVERY_DEFAULTS.maxConcurrentLoops),
    };
}

export function getCommanderLoopDir(home = resolvePilotHome()) {
    return path.join(home, COMMANDER_LOOP_DIR_NAME);
}

/**
 * 文件名用 hash 而不是 sanitize 后的 sessionKey：`web:s_x` 与 `web-s_x`
 * 会被 sanitize 成同一个名字，撞车就会覆盖另一个任务的账本。
 */
export function commanderLoopFileName(sessionKey) {
    const safe = sanitizeSessionIdForPath(String(sessionKey ?? 'session')).slice(0, 32);
    const digest = createHash('sha256').update(String(sessionKey ?? '')).digest('hex').slice(0, 16);
    return `${safe}-${digest}.json`;
}

function loopFilePath(sessionKey, home) {
    return path.join(getCommanderLoopDir(home), commanderLoopFileName(sessionKey));
}

/** 只保留重建一轮判定所需、且能安全 JSON 序列化的字段。 */
const CONTEXT_KEYS = [
    'projectPath', 'cwd', 'autoDrive', 'acceptance', 'agentId',
    'modelSelection', 'modelOverride', 'provider', 'executionMode',
    'permissionMode', 'basePermissionMode', 'runMode', 'workspaceCwd',
];

export function sanitizeLoopContext(context = {}) {
    const clean = {};
    for (const key of CONTEXT_KEYS) {
        const value = context?.[key];
        if (value === undefined || value === null || typeof value === 'function') continue;
        try {
            JSON.stringify(value);
            clean[key] = value;
        } catch { /* 循环引用之类的，丢掉即可，不能让账本写不下去 */ }
    }
    return clean;
}

/** 内存 loop → 可落盘的账本记录（纯函数）。 */
export function toStoredLoop(loop, context = {}, { now = Date.now() } = {}) {
    return {
        schema: COMMANDER_LOOP_SCHEMA,
        sessionKey: loop.sessionKey,
        status: loop.status ?? 'running',
        goal: loop.goal ?? '',
        acceptance: Array.isArray(loop.acceptance) ? loop.acceptance.slice(0, 8) : [],
        mode: loop.mode === 'delegated' ? 'delegated' : 'self',
        commanderId: loop.commanderId ?? null,
        workerId: loop.workerId ?? null,
        limits: { ...COMMANDER_DEFAULT_LIMITS, ...(loop.limits ?? {}) },
        startedAt: loop.startedAt ?? now,
        createdAt: loop.createdAt ?? loop.startedAt ?? now,
        iteration: loop.iteration ?? 0,
        invalidVerdicts: loop.invalidVerdicts ?? 0,
        instructionCounts: { ...(loop.instructionCounts ?? {}) },
        lastInstruction: loop.lastInstruction ?? '',
        lastDispatchedAt: loop.lastDispatchedAt ?? null,
        // 只留最近 20 条：账本用于恢复，不用于审计全量，历史在 transcript 里。
        verdicts: (Array.isArray(loop.verdicts) ? loop.verdicts : []).slice(-20),
        stopReason: loop.stopReason ?? null,
        lastError: loop.lastError ?? null,
        interruptedAt: loop.interruptedAt ?? null,
        endedAt: loop.endedAt ?? null,
        recoveryCount: loop.recoveryCount ?? 0,
        context: sanitizeLoopContext(context),
        updatedAt: now,
    };
}

/** 账本记录 → 可以直接喂给 `runCommanderLoop` 的 loop 对象（纯函数）。 */
export function fromStoredLoop(record) {
    const counts = Object.create(null);
    for (const [key, value] of Object.entries(record?.instructionCounts ?? {})) {
        if (Number.isFinite(value)) counts[key] = value;
    }
    return {
        version: 1,
        sessionKey: record.sessionKey,
        goal: record.goal ?? '',
        acceptance: Array.isArray(record.acceptance) ? [...record.acceptance] : [],
        mode: record.mode === 'delegated' ? 'delegated' : 'self',
        commanderId: record.commanderId ?? null,
        workerId: record.workerId ?? null,
        limits: { ...COMMANDER_DEFAULT_LIMITS, ...(record.limits ?? {}) },
        startedAt: record.startedAt ?? Date.now(),
        createdAt: record.createdAt ?? record.startedAt ?? Date.now(),
        iteration: record.iteration ?? 0,
        invalidVerdicts: record.invalidVerdicts ?? 0,
        instructionCounts: counts,
        lastInstruction: record.lastInstruction ?? '',
        lastDispatchedAt: record.lastDispatchedAt ?? null,
        verdicts: Array.isArray(record.verdicts) ? [...record.verdicts] : [],
        // 恢复时一律重新跑起来；终态由这一轮重新判定。
        status: 'running',
        stopReason: null,
        lastError: null,
        interruptedAt: null,
        recoveryCount: (record.recoveryCount ?? 0) + 1,
    };
}

/** 恢复一轮判定所需的 options（纯函数）。 */
export function buildResumeOptions(record) {
    return {
        ...sanitizeLoopContext(record?.context ?? {}),
        sessionId: record.sessionKey,
        sessionKey: record.sessionKey,
        // 显式标记：这条链是恢复出来的，日志与状态帧里要说清楚。
        commanderResume: true,
        autoDrive: true,
        acceptance: Array.isArray(record.acceptance) ? [...record.acceptance] : [],
    };
}

/**
 * 内部判定轮是否真的跑完了。
 *
 * `runChatViaGateway` 会把 gateway 断连**吞在 catch 里**并返回，调用方只看
 * 返回值才知道。旧循环没检查，于是断连后拿旧 transcript 继续解析 verdict，
 * 甚至继续派发 —— 这是"崩了之后停在半截"的直接原因之一。
 */
export function isIncompleteTurn(result) {
    if (!result || typeof result !== 'object') return true;
    if (result.sawGatewayError === true || result.sawTurnCompleted !== true) return true;
    return result.turnFinishReason !== 'completed';
}

/**
 * 一条账本此刻是否该被恢复（纯函数，恢复守护与单测共用）。
 */
export function isRecoverableNow(record, {
    now = Date.now(),
    activeSessionKeys = new Set(),
    gatewayReady = true,
    config = COMMANDER_RECOVERY_DEFAULTS,
} = {}) {
    if (!record || !record.sessionKey) return false;
    // 无进展熔断归档的账本永不再自动恢复（即使归档删除失败也拦住）。
    if (record.stopReason === NO_PROGRESS_STOP_REASON) return false;
    if (record.status !== 'running' && record.status !== 'interrupted') return false;
    if (!gatewayReady) return false;
    if (activeSessionKeys.has(record.sessionKey)) return false;
    if ((record.recoveryCount ?? 0) >= config.maxRecoveryAttempts) return false;
    if (now - (record.updatedAt ?? 0) > config.staleMs) return false;
    const grace = record.status === 'interrupted'
        ? config.interruptedGraceMs
        : config.runningGraceMs;
    return now - (record.updatedAt ?? 0) >= grace;
}

/** 原子写账本：临时文件 + rename，避免恢复守护读到半截 JSON。 */
export function saveCommanderLoop(loop, context, { home, now = Date.now() } = {}) {
    const dir = getCommanderLoopDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const record = toStoredLoop(loop, context, { now });
    const target = loopFilePath(record.sessionKey, home);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    try {
        fs.renameSync(tmp, target);
    } catch (error) {
        // Windows 上少数文件系统不允许 rename 覆盖；退化为直接写目标文件，
        // 读侧对坏 JSON 有容错（见 readLoopRecords）。
        try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
        fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
    return record;
}

function isValidRecord(record) {
    return record
        && typeof record === 'object'
        && record.schema === COMMANDER_LOOP_SCHEMA
        && typeof record.sessionKey === 'string'
        && record.sessionKey.length > 0
        && typeof record.goal === 'string';
}

/**
 * 读账本目录。坏文件不删（改名留证），陈旧账本单独返回让调用方归档。
 */
export function readLoopRecords({ home, now = Date.now(), config = COMMANDER_RECOVERY_DEFAULTS } = {}) {
    const dir = getCommanderLoopDir(home);
    const recoverable = [];
    const stale = [];
    const corrupted = [];
    let files;
    try {
        files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
        return { recoverable, stale, corrupted };
    }
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
        if (record.stopReason === NO_PROGRESS_STOP_REASON) continue;
        if (record.status !== 'running' && record.status !== 'interrupted') continue;
        if (now - (record.updatedAt ?? 0) > config.staleMs
            || (record.recoveryCount ?? 0) >= config.maxRecoveryAttempts) {
            stale.push(record);
        } else {
            recoverable.push(record);
        }
    }
    recoverable.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    return { recoverable, stale, corrupted };
}

/**
 * 归档：追加一行明文历史（产品规则「明文可审计」），再删掉 running 文件。
 * 删除是"不会再自动恢复"的唯一凭据，所以必须先 append 成功。
 */
export function archiveCommanderLoop(loop, context, {
    home,
    now = Date.now(),
    status = 'done',
    reason = null,
} = {}) {
    const dir = getCommanderLoopDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const record = toStoredLoop(loop, context, { now });
    record.status = status;
    record.stopReason = reason ?? loop.stopReason ?? null;
    record.archivedAt = new Date(now).toISOString();
    fs.appendFileSync(
        path.join(dir, 'history.jsonl'),
        `${JSON.stringify(record)}\n`,
        'utf8',
    );
    try { fs.rmSync(loopFilePath(record.sessionKey, home), { force: true }); } catch { /* ignore */ }
    return record;
}

/** 只删账本，不写历史（例如用户明确取消自动推进）。 */
export function deleteCommanderLoop(sessionKey, { home } = {}) {
    try { fs.rmSync(loopFilePath(sessionKey, home), { force: true }); } catch { /* ignore */ }
}
