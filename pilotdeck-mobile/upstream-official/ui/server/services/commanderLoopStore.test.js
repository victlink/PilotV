import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommanderState, noteDispatch, settleCommanderState } from './commanderLoop.js';
import {
    COMMANDER_LOOP_SCHEMA,
    archiveCommanderLoop,
    buildResumeOptions,
    commanderLoopFileName,
    commanderRecoveryConfig,
    fromStoredLoop,
    isIncompleteTurn,
    isRecoverableNow,
    readLoopRecords,
    sanitizeLoopContext,
    saveCommanderLoop,
    toStoredLoop,
} from './commanderLoopStore.js';
import { COMMANDER_RECOVERY_DEFAULTS } from './commanderLoopStore.js';

const tempHomes = [];
function tempHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-commander-'));
    tempHomes.push(home);
    return home;
}
afterEach(() => {
    while (tempHomes.length) {
        fs.rmSync(tempHomes.pop(), { recursive: true, force: true });
    }
});

function makeLoop(overrides = {}) {
    return createCommanderState({
        sessionKey: 'web-s_test',
        goal: '把 CAD 装配导成 STEP 并核对 BOM',
        acceptance: ['STEP 可打开', 'BOM 数量一致'],
        now: 1_000,
        limits: { maxIterations: 3 },
        ...overrides,
    });
}

describe('账本转换（纯逻辑）', () => {
    it('往返保留进度与预算，恢复时只把状态重置为 running', () => {
        const loop = makeLoop();
        noteDispatch(loop, { instruction: '修 build_assembly.py' }, { now: 2_000 });
        loop.verdicts.push({ iteration: 1, status: 'continue', ok: true, at: 'now' });
        const record = toStoredLoop(loop, { projectPath: 'C:/work/coffee', autoDrive: true }, { now: 3_000 });

        expect(record.schema).toBe(COMMANDER_LOOP_SCHEMA);
        expect(record.iteration).toBe(1);
        expect(record.limits.maxIterations).toBe(3);
        expect(record.acceptance).toEqual(['STEP 可打开', 'BOM 数量一致']);
        expect(record.context.projectPath).toBe('C:/work/coffee');
        expect(record.updatedAt).toBe(3_000);

        const restored = fromStoredLoop(record);
        expect(restored.status).toBe('running');
        expect(restored.iteration).toBe(1);
        expect(restored.lastInstruction).toBe('修 build_assembly.py');
        expect(restored.limits.maxIterations).toBe(3);
        expect(restored.instructionCounts['0']).toBeUndefined();
        expect(Object.keys(restored.instructionCounts)).toHaveLength(1);
        expect(restored.verdicts).toHaveLength(1);
        expect(restored.recoveryCount).toBe(1);
        expect(restored.startedAt).toBe(1_000);
    });

    it('恢复时预算不重置：第二次恢复仍叠加 recoveryCount', () => {
        const first = toStoredLoop(makeLoop(), {}, { now: 10 });
        const second = toStoredLoop(fromStoredLoop(first), {}, { now: 20 });
        expect(fromStoredLoop(second).recoveryCount).toBe(2);
        expect(fromStoredLoop(second).startedAt).toBe(first.startedAt);
    });

    it('context 只留白名单且能 JSON 序列化', () => {
        const circular = {};
        circular.self = circular;
        const clean = sanitizeLoopContext({
            projectPath: '/work/fan',
            autoDrive: true,
            images: ['data:...'],
            onInputAccepted: () => {},
            circular,
            writer: { send() {} },
        });
        expect(clean).toEqual({ projectPath: '/work/fan', autoDrive: true });
        expect(() => JSON.stringify(clean)).not.toThrow();
    });

    it('恢复 options 带上会话、开关与完成条件', () => {
        const record = toStoredLoop(makeLoop(), { projectPath: '/work/fan', cwd: '/work/fan' }, { now: 5 });
        const options = buildResumeOptions(record);
        expect(options.sessionKey).toBe('web-s_test');
        expect(options.autoDrive).toBe(true);
        expect(options.commanderResume).toBe(true);
        expect(options.projectPath).toBe('/work/fan');
        expect(options.acceptance).toEqual(['STEP 可打开', 'BOM 数量一致']);
    });

    it('冒号与连字符形式的会话 key 不会撞同一个文件', () => {
        expect(commanderLoopFileName('web:s_x')).not.toBe(commanderLoopFileName('web-s_x'));
    });
});

describe('内部判定轮结果判据', () => {
    it('只有 turn_completed + completed 才算这一轮真的跑完', () => {
        expect(isIncompleteTurn({
            sawTurnCompleted: true, turnFinishReason: 'completed', sawGatewayError: false,
        })).toBe(false);
        expect(isIncompleteTurn({
            sawTurnCompleted: false, turnFinishReason: 'gateway_bridge_error', sawGatewayError: false,
        })).toBe(true);
        expect(isIncompleteTurn({
            sawTurnCompleted: false, turnFinishReason: 'gateway_stream_ended', sawGatewayError: false,
        })).toBe(true);
        expect(isIncompleteTurn({ sawTurnCompleted: true, turnFinishReason: 'completed', sawGatewayError: true })).toBe(true);
        expect(isIncompleteTurn(undefined)).toBe(true);
    });
});

describe('恢复判据', () => {
    const base = { sessionKey: 'web-s_test', status: 'running', recoveryCount: 0, updatedAt: 1_000 };

    it('账本刚写过（内存循环可能还在跑）时不抢', () => {
        expect(isRecoverableNow(base, { now: 1_000 + 1_000 })).toBe(false);
    });

    it('静默超过 grace 且网关可用时恢复', () => {
        expect(isRecoverableNow(base, {
            now: 1_000 + COMMANDER_RECOVERY_DEFAULTS.runningGraceMs + 1,
        })).toBe(true);
    });

    it('interrupted 只需短 grace', () => {
        expect(isRecoverableNow({ ...base, status: 'interrupted' }, {
            now: 1_000 + COMMANDER_RECOVERY_DEFAULTS.interruptedGraceMs + 1,
        })).toBe(true);
    });

    it('人已接管 / 网关没好 / 恢复次数用尽 / 账本过期 / 终态都不恢复', () => {
        const now = 1_000 + COMMANDER_RECOVERY_DEFAULTS.runningGraceMs + 1;
        expect(isRecoverableNow(base, { now, activeSessionKeys: new Set(['web-s_test']) })).toBe(false);
        expect(isRecoverableNow(base, { now, gatewayReady: false })).toBe(false);
        expect(isRecoverableNow({ ...base, recoveryCount: 5 }, { now })).toBe(false);
        expect(isRecoverableNow({ ...base, status: 'done' }, { now })).toBe(false);
        expect(isRecoverableNow(base, {
            now: 1_000 + COMMANDER_RECOVERY_DEFAULTS.staleMs + 1,
        })).toBe(false);
    });

    it('无进展熔断归档的账本永不自动恢复（包括归档删除失败时）', () => {
        const now = 1_000 + COMMANDER_RECOVERY_DEFAULTS.runningGraceMs + 1;
        const stalled = { ...base, stopReason: 'no_progress_stall' };
        expect(isRecoverableNow(stalled, { now })).toBe(false);
        expect(isRecoverableNow({ ...stalled, status: 'interrupted' }, { now })).toBe(false);
    });

    it('环境变量可覆盖默认节奏', () => {
        const cfg = commanderRecoveryConfig({
            PILOTV_COMMANDER_RECOVERY_GRACE_MS: '500',
            PILOTV_COMMANDER_MAX_CONCURRENT: '2',
        });
        expect(cfg.runningGraceMs).toBe(500);
        expect(cfg.maxConcurrentLoops).toBe(2);
        expect(cfg.maxRecoveryAttempts).toBe(COMMANDER_RECOVERY_DEFAULTS.maxRecoveryAttempts);
    });
});

describe('账本落盘与归档', () => {
    it('逐轮覆盖写、可读回 running 账本', () => {
        const home = tempHome();
        const loop = makeLoop();
        const context = { projectPath: '/work/fan', autoDrive: true };
        saveCommanderLoop(loop, context, { home, now: 1_000 });
        noteDispatch(loop, { instruction: '继续导出' }, { now: 2_000 });
        saveCommanderLoop(loop, context, { home, now: 2_000 });

        const { recoverable } = readLoopRecords({ home, now: 2_001 });
        expect(recoverable).toHaveLength(1);
        expect(recoverable[0].iteration).toBe(1);
        expect(recoverable[0].updatedAt).toBe(2_000);
        expect(recoverable[0].context.projectPath).toBe('/work/fan');
    });

    it('归档写明文历史并删掉 running 文件，之后不再出现在待恢复列表', () => {
        const home = tempHome();
        const loop = makeLoop();
        settleCommanderState(loop, { type: 'finish', summary: '目标达成' });
        archiveCommanderLoop(loop, { projectPath: '/work/fan' }, {
            home, now: 9_000, status: loop.status, reason: loop.stopReason,
        });
        const history = path.join(home, 'commander-loops', 'history.jsonl');
        expect(fs.existsSync(history)).toBe(true);
        const lines = fs.readFileSync(history, 'utf8').trim().split('\n').map(JSON.parse);
        expect(lines[0].status).toBe('done');
        expect(lines[0].archivedAt).toBeTruthy();
        expect(readLoopRecords({ home, now: 9_001 }).recoverable).toHaveLength(0);
    });

    it('无进展账本即使还留在目录里，也不会被列为可恢复', () => {
        const home = tempHome();
        const loop = makeLoop();
        loop.stopReason = 'no_progress_stall';
        saveCommanderLoop(loop, { projectPath: '/work/fan' }, { home, now: 1_000 });
        const now = 1_000 + COMMANDER_RECOVERY_DEFAULTS.runningGraceMs + 1;
        expect(readLoopRecords({ home, now }).recoverable).toHaveLength(0);
        expect(readLoopRecords({ home, now }).stale).toHaveLength(0);
    });

    it('坏 JSON 被隔离留证，不影响其它账本；过期账本单独归到 stale', () => {
        const home = tempHome();
        const dir = path.join(home, 'commander-loops');
        fs.mkdirSync(dir, { recursive: true });
        const loop = makeLoop();
        saveCommanderLoop(loop, { projectPath: '/work/fan' }, { home, now: 1_000 });
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
        const now = 1_000 + COMMANDER_RECOVERY_DEFAULTS.staleMs + 1;
        const result = readLoopRecords({ home, now });
        expect(result.corrupted).toHaveLength(1);
        expect(result.stale).toHaveLength(1);
        expect(result.recoverable).toHaveLength(0);
        expect(fs.readdirSync(dir).filter((f) => f.includes('.bad-'))).toHaveLength(1);
        expect(files).toHaveLength(1);
    });
});
