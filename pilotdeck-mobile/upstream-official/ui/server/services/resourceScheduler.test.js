import { describe, expect, it } from 'vitest';

import {
    RESOURCE_SCHEDULER_DEFAULTS,
    STALL_CATEGORY,
    TASK_STATUS,
    classifyStall,
    createResourceScheduler,
    readResourceSchedulerConfig,
    scaleTurnBudgets,
} from './resourceScheduler.js';

const GB = 1024 ** 3;

function makeScheduler(overrides = {}) {
    let clock = 1_000_000;
    return createResourceScheduler({
        config: { ...RESOURCE_SCHEDULER_DEFAULTS, ...overrides },
        now: () => clock,
    });
}

/** 一台「宽裕」的机器。 */
const roomy = {
    cpuPercent: 10,
    cpuCores: 16,
    memTotalBytes: 16 * GB,
    memFreeBytes: 12 * GB,
    vram: { totalBytes: 4 * GB, usedBytes: 0.5 * GB },
    headroom: { pressure: 'normal', saturated: false, cpuIdleCores: 14 },
};

/** 一台「挤」的机器：内存只剩 1 GB。 */
const cramped = {
    cpuPercent: 40,
    cpuCores: 16,
    memTotalBytes: 16 * GB,
    memFreeBytes: 1 * GB,
    vram: null,
    headroom: { pressure: 'high', saturated: true, cpuIdleCores: 9 },
};

describe('熔断分类', () => {
    it('重复思考归为 logic，但可恢复', () => {
        const result = classifyStall({ code: 'repeated_thinking', detail: {} }, roomy);
        expect(result.category).toBe(STALL_CATEGORY.LOGIC);
        expect(result.resumable).toBe(true);
    });

    it('机器挤时的静默超时归为 resource', () => {
        const result = classifyStall({ code: 'turn_idle', detail: {} }, cramped);
        expect(result.category).toBe(STALL_CATEGORY.RESOURCE);
    });

    it('机器空闲时的静默超时归为 logic', () => {
        const result = classifyStall({ code: 'turn_idle', detail: {} }, roomy);
        expect(result.category).toBe(STALL_CATEGORY.LOGIC);
    });

    it('工具失败提到 OOM 时归为 resource', () => {
        const result = classifyStall({
            code: 'repeated_tool_failure',
            detail: { fingerprint: 'bash|unknown|out of memory' },
        }, roomy);
        expect(result.category).toBe(STALL_CATEGORY.RESOURCE);
    });

    it('工具失败是参数错误时归为 logic', () => {
        const result = classifyStall({
            code: 'repeated_tool_failure',
            detail: { fingerprint: 'edit_file|invalid_tool_input|missing old_string' },
        }, roomy);
        expect(result.category).toBe(STALL_CATEGORY.LOGIC);
    });

    it('未知原因归为 transient', () => {
        const result = classifyStall({ code: 'something_new' }, roomy);
        expect(result.category).toBe(STALL_CATEGORY.TRANSIENT);
        expect(result.resumable).toBe(true);
    });

    it('每种分类都带一条可执行的提示', () => {
        for (const code of ['turn_timeout', 'turn_idle', 'repeated_thinking', 'repeated_tool_failure']) {
            const result = classifyStall({ code, detail: {} }, roomy);
            expect(result.hint.length).toBeGreaterThan(10);
        }
    });
});

describe('熔断预算伸缩', () => {
    const base = { maxTurnWallClockMs: 4 * 60 * 60 * 1000, maxIdleMs: 30 * 60 * 1000 };

    it('机器挤时放宽墙钟与静默预算', () => {
        const scaled = scaleTurnBudgets(base, cramped, RESOURCE_SCHEDULER_DEFAULTS);
        expect(scaled.maxTurnWallClockMs).toBe(base.maxTurnWallClockMs * 2);
        expect(scaled.maxIdleMs).toBe(base.maxIdleMs * 2);
    });

    it('机器空闲时保持默认，不给空转留口子', () => {
        const scaled = scaleTurnBudgets(base, roomy, RESOURCE_SCHEDULER_DEFAULTS);
        expect(scaled.maxTurnWallClockMs).toBe(base.maxTurnWallClockMs);
        expect(scaled.maxIdleMs).toBe(base.maxIdleMs);
    });

    it('没有资源信息时保持默认', () => {
        const scaled = scaleTurnBudgets(base, null, RESOURCE_SCHEDULER_DEFAULTS);
        expect(scaled.maxTurnWallClockMs).toBe(base.maxTurnWallClockMs);
    });
});

describe('任务队列与准入', () => {
    it('并发上限为 1 时第二个任务排队', () => {
        const scheduler = makeScheduler({ maxConcurrent: 1 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a', goal: '甲' });
        scheduler.register({ id: 'b', goal: '乙' });
        expect(scheduler.canAdmit(scheduler.get('a'), roomy)).toBe(true);
        scheduler.markRunning('a');
        expect(scheduler.canAdmit(scheduler.get('b'), roomy)).toBe(false);
        expect(scheduler.queuedList().map((task) => task.id)).toEqual(['b']);
    });

    it('内存不足时新任务一律不放行', () => {
        const scheduler = makeScheduler({ maxConcurrent: 2, taskRamMb: 1024 });
        scheduler.setResources(cramped);
        scheduler.register({ id: 'a' });
        expect(scheduler.canAdmit(scheduler.get('a'), cramped)).toBe(false);
    });

    it('内存宽裕时放行', () => {
        const scheduler = makeScheduler({ maxConcurrent: 2, taskRamMb: 1024 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a' });
        expect(scheduler.canAdmit(scheduler.get('a'), roomy)).toBe(true);
    });

    it('优先级高的先排队到前面', () => {
        const scheduler = makeScheduler({ maxConcurrent: 1 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'low', priority: 0 });
        scheduler.register({ id: 'high', priority: 10 });
        expect(scheduler.queuedList().map((task) => task.id)).toEqual(['high', 'low']);
    });

    it('同优先级按入队时间 FIFO', () => {
        const scheduler = makeScheduler({ maxConcurrent: 1 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'first' });
        scheduler.register({ id: 'second' });
        expect(scheduler.queuedList().map((task) => task.id)).toEqual(['first', 'second']);
    });
});

describe('暂停与恢复', () => {
    it('熔断后进入 paused 而不是终止', () => {
        const scheduler = makeScheduler();
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a' });
        scheduler.markRunning('a');
        const result = scheduler.pause('a', { code: 'repeated_thinking', detail: {} });
        expect(result.resumable).toBe(true);
        expect(scheduler.get('a').status).toBe(TASK_STATUS.PAUSED);
    });

    it('暂停次数用尽后判失败', () => {
        const scheduler = makeScheduler({ maxPauseAttempts: 2 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a' });
        scheduler.markRunning('a');
        scheduler.pause('a', { code: 'repeated_thinking' });
        scheduler.markRunning('a');
        scheduler.pause('a', { code: 'repeated_thinking' });
        scheduler.markRunning('a');
        const third = scheduler.pause('a', { code: 'repeated_thinking' });
        expect(third.resumable).toBe(false);
        expect(scheduler.get('a').status).toBe(TASK_STATUS.FAILED);
    });

    it('中断不计入暂停预算（由账本的恢复次数单独管）', () => {
        const scheduler = makeScheduler({ maxPauseAttempts: 1 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a' });
        scheduler.markRunning('a');
        const result = scheduler.pause('a', { code: 'gateway_bridge_error' }, { countAttempt: false });
        expect(result.resumable).toBe(true);
        expect(scheduler.get('a').pauseCount).toBe(0);
    });

    it('退避时间未到不自动恢复', () => {
        const scheduler = makeScheduler({ pauseBackoffMs: 30_000 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a' });
        scheduler.markRunning('a');
        scheduler.pause('a', { code: 'repeated_thinking' });
        expect(scheduler.resumePaused()).toHaveLength(0);
    });

    it('退避时间到了自动放回队列', () => {
        let clock = 1_000_000;
        const scheduler = createResourceScheduler({
            config: { ...RESOURCE_SCHEDULER_DEFAULTS, pauseBackoffMs: 1_000 },
            now: () => clock,
        });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a' });
        scheduler.markRunning('a');
        scheduler.pause('a', { code: 'repeated_thinking' });
        clock += 1_500;
        const resumed = scheduler.resumePaused();
        expect(resumed).toHaveLength(1);
        expect(scheduler.get('a').status).toBe(TASK_STATUS.QUEUED);
    });

    it('压力高时让最低优先级的运行任务让路，但至少留一个在跑', () => {
        const scheduler = makeScheduler({ maxConcurrent: 3 });
        scheduler.setResources(cramped);
        scheduler.register({ id: 'a', priority: 10 });
        scheduler.register({ id: 'b', priority: 1 });
        scheduler.markRunning('a');
        scheduler.markRunning('b');
        const yielded = scheduler.yieldUnderPressure();
        expect(yielded).toHaveLength(1);
        expect(yielded[0].id).toBe('b');
        expect(scheduler.get('a').status).toBe(TASK_STATUS.RUNNING);
    });

    it('只有一个任务在跑时不让路（全让光等于什么都不干）', () => {
        const scheduler = makeScheduler({ maxConcurrent: 3 });
        scheduler.setResources(cramped);
        scheduler.register({ id: 'a' });
        scheduler.markRunning('a');
        expect(scheduler.yieldUnderPressure()).toHaveLength(0);
    });

    it('资源宽裕时不让路', () => {
        const scheduler = makeScheduler({ maxConcurrent: 3 });
        scheduler.setResources(roomy);
        scheduler.register({ id: 'a' });
        scheduler.register({ id: 'b' });
        scheduler.markRunning('a');
        scheduler.markRunning('b');
        expect(scheduler.yieldUnderPressure()).toHaveLength(0);
    });
});

describe('配置读取', () => {
    it('默认开启，并发上限跟随旧的并发闸门变量', () => {
        const config = readResourceSchedulerConfig({ PILOTV_COMMANDER_MAX_CONCURRENT: '2' });
        expect(config.enabled).toBe(true);
        expect(config.maxConcurrent).toBe(2);
    });

    it('PILOTV_SCHEDULER=0 关闭调度器', () => {
        expect(readResourceSchedulerConfig({ PILOTV_SCHEDULER: '0' }).enabled).toBe(false);
    });

    it('调度器自己的并发变量优先于旧变量', () => {
        const config = readResourceSchedulerConfig({
            PILOTV_COMMANDER_MAX_CONCURRENT: '2',
            PILOTV_SCHEDULER_MAX_CONCURRENT: '3',
        });
        expect(config.maxConcurrent).toBe(3);
    });
});
