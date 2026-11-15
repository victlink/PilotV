/**
 * 资源感知的任务总调度器（TaskMaster 核心）。
 *
 * 要解决的问题
 * ------------
 * 2026-11-15 实测：咖啡机 / 新风机 / 车顶架三个长 CAD 任务的自动推进
 * 反复「跑一会儿就自己停住」。账本（`~/.pilotdeck/commander-loops/history.jsonl`）
 * 与运行日志（`AppData/Local/PilotV/repo/.run/web.log`）给出的停机原因分布：
 *
 *   | 原因                          | 次数 | 触发者                        |
 *   | ----------------------------- | ---- | ----------------------------- |
 *   | `repeated_thinking`           |  6   | turnStallGuard 熔断           |
 *   | `turn_timeout`（4h 墙钟兜底） |  3   | turnStallGuard 熔断           |
 *   | `turn_idle`（30min 静默）     |  2   | turnStallGuard 熔断           |
 *   | `repeated_tool_failure`       |  1   | turnStallGuard 熔断           |
 *   | `verdict_marker_missing`      |  3   | 判定轮读不出 verdict           |
 *   | `max_recoveries`              |  7   | 恢复守护用尽 5 次预算          |
 *
 * 关键事实：**熔断一命中就把循环归档成终态 `waiting_user`，
 * 恢复守护按设计永不续跑**（`commanderLoopStore.isRecoverableNow` 里
 * `stopReason === NO_PROGRESS_STOP_REASON` 直接 return false）。所以
 * 「任务停住」不是崩溃，也不是资源不够，是 PilotV 自己的护栏按设计
 * 终止了循环 —— 而这个设计在「机器很挤 + 任务是长 CAD」的现实里过于乐观。
 *
 * 同时，旧护栏对资源一无所知：
 *   - `turn_timeout` 是**绝对**墙钟，任务有进展也停；
 *   - `turn_idle` 只看「有没有进展」，看不见「这台机器挤到 FreeCAD 脚本
 *     开始 OOM、工具超时」，于是把**环境慢**误判成**模型卡住**；
 *   - 并发闸门 `maxConcurrent=1` 是**静态**串行：新风机为等咖啡机的
 *     4 小时墙钟，从 02:31 排到 06:35，中间既没有进度也没有解释。
 *
 * 这个调度器的定位
 * ----------------
 * 不替代熔断，而是给熔断一个**资源上下文**，并把「终止」改写成
 * 「可恢复的暂停」：
 *
 *   1. **准入**：按当前余量决定还能不能再开一个任务，开多少个；
 *   2. **排队**：排队的任务有明确的队列位置与预计等待，不再是黑洞；
 *   3. **监督**：区分「环境慢 / 临时故障 / 真的卡住」，前者暂停后自动续跑，
 *      后者才终止；
 *   4. **调配**：压力高时让低优先级任务让路，而不是让所有任务一起撞墙；
 *   5. **预算**：熔断的墙钟 / 静默预算按资源状态伸缩，机器挤就放宽，
 *      机器空就收紧。
 *
 * 纯逻辑：采样在 `resourceMonitor.js`，落盘在 `resourceSchedulerStore.js`，
 * 本文件只做判定，便于直接单测。
 */

/** 任务状态。`paused` 是这套调度器的核心：可恢复，不是终态。 */
export const TASK_STATUS = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    PAUSED: 'paused',
    DONE: 'done',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

/** 熔断原因的分类，决定是「暂停后自动续跑」还是「终止」。 */
export const STALL_CATEGORY = Object.freeze({
    /** 机器挤 / 临时故障：换个策略再来一次，不该判死刑。 */
    RESOURCE: 'resource',
    /** 网络 / 网关 / 模型侧临时错误：稍后重试。 */
    TRANSIENT: 'transient',
    /** 模型层面真的在复读同一个东西：需要换策略，仍可续跑但要限量。 */
    LOGIC: 'logic',
});

export const RESOURCE_SCHEDULER_DEFAULTS = Object.freeze({
    /** 总开关。关掉后调度器只观察，不改变任何既有行为。 */
    enabled: true,
    /** 同时运行的任务数上限。默认跟随 `PILOTV_COMMANDER_MAX_CONCURRENT`。 */
    maxConcurrent: 1,
    /** 单个任务默认占用的内存估值（MB）。 */
    taskRamMb: 1024,
    /** 单个任务默认占用的显存估值（MB）。 */
    taskVramMb: 0,
    /** 单个任务默认占用的「满负荷 CPU 核」估值。 */
    taskCpuWeight: 1,
    /**
     * 空闲内存地板：低于此值就不再接纳新任务。
     * 与资源监视器的地板是同一个概念，但调度器要自己持有一份，
     * 因为准入判定不能依赖「刚好采到了什么」。
     */
    memFloorBytes: 2 * 1024 * 1024 * 1024,
    /** 一个任务最多被暂停多少次。超过就判失败，避免无限复活。 */
    maxPauseAttempts: 3,
    /** 暂停后的退避基数（毫秒），按暂停次数指数增长。 */
    pauseBackoffMs: 30_000,
    /** 熔断墙钟预算在「机器很挤」时的放大倍数。 */
    turnBudgetScaleSaturated: 2,
    /** 熔断静默预算在「机器很挤」时的放大倍数。 */
    idleBudgetScaleSaturated: 2,
    /** 熔断墙钟预算在「机器很空」时的收紧倍数。 */
    turnBudgetScaleIdle: 1,
});

function intFromEnv(env, name, fallback) {
    const raw = String(env?.[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function floatFromEnv(env, name, fallback) {
    const raw = String(env?.[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bytesFromEnv(env, name, fallback) {
    const raw = String(env?.[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readResourceSchedulerConfig(env = process.env) {
    const rawEnabled = String(env?.PILOTV_SCHEDULER ?? '').trim().toLowerCase();
    const enabled = rawEnabled === ''
        ? RESOURCE_SCHEDULER_DEFAULTS.enabled
        : !['0', 'false', 'no', 'off', 'disabled'].includes(rawEnabled);
    return {
        enabled,
        // 与旧的并发闸门共享同一个变量语义：默认 1 = 全局串行。
        maxConcurrent: intFromEnv(env, 'PILOTV_SCHEDULER_MAX_CONCURRENT',
            intFromEnv(env, 'PILOTV_COMMANDER_MAX_CONCURRENT', RESOURCE_SCHEDULER_DEFAULTS.maxConcurrent)),
        taskRamMb: intFromEnv(env, 'PILOTV_SCHEDULER_TASK_RAM_MB', RESOURCE_SCHEDULER_DEFAULTS.taskRamMb),
        taskVramMb: intFromEnv(env, 'PILOTV_SCHEDULER_TASK_VRAM_MB', RESOURCE_SCHEDULER_DEFAULTS.taskVramMb),
        taskCpuWeight: floatFromEnv(env, 'PILOTV_SCHEDULER_TASK_CPU_WEIGHT', RESOURCE_SCHEDULER_DEFAULTS.taskCpuWeight),
        memFloorBytes: bytesFromEnv(env, 'PILOTV_SCHEDULER_MEM_FLOOR_MB', RESOURCE_SCHEDULER_DEFAULTS.memFloorBytes),
        maxPauseAttempts: intFromEnv(env, 'PILOTV_SCHEDULER_MAX_PAUSE_ATTEMPTS', RESOURCE_SCHEDULER_DEFAULTS.maxPauseAttempts),
        pauseBackoffMs: intFromEnv(env, 'PILOTV_SCHEDULER_PAUSE_BACKOFF_MS', RESOURCE_SCHEDULER_DEFAULTS.pauseBackoffMs),
        turnBudgetScaleSaturated: floatFromEnv(env, 'PILOTV_SCHEDULER_TURN_SCALE_SATURATED', RESOURCE_SCHEDULER_DEFAULTS.turnBudgetScaleSaturated),
        turnBudgetScaleIdle: floatFromEnv(env, 'PILOTV_SCHEDULER_TURN_SCALE_IDLE', RESOURCE_SCHEDULER_DEFAULTS.turnBudgetScaleIdle),
    };
}

/** 资源不足的典型症状：OOM、被杀、超时。见到这些就是「环境慢」而不是「模型卡住」。 */
const RESOURCE_SYMPTOMS = [
    'out of memory', 'outofmemory', 'enomem', 'oom',
    'not enough memory', 'insufficient memory', 'cannot allocate memory',
    'memoryerror', 'bad_alloc', 'killed', 'killed process',
    'timed out', 'timeout', 'etimedout', 'spawn e',
    'resource temporarily unavailable', 'too many open files',
    'heap out of memory', 'allocation failed',
];

/**
 * 把熔断信息分类。
 *
 * @param {object} stall  `{ code, detail }`，来自 turnStallGuard。
 * @param {object} [resources] 当前资源快照（含 headroom）。
 * @returns {{category: string, resumable: boolean, reason: string, hint: string}}
 */
export function classifyStall(stall, resources = null) {
    const code = String(stall?.code ?? '').trim();
    const detail = stall?.detail ?? {};
    const saturated = Boolean(resources?.headroom?.saturated);
    const pressure = resources?.headroom?.pressure ?? 'normal';

    const hintFor = (hint) => hint;

    switch (code) {
        case 'turn_timeout':
            // 绝对墙钟到顶。机器挤的时候这多半是「跑得慢」而不是「没进展」，
            // 所以饱和时归为 resource：放宽预算后续跑，而不是终止。
            return saturated
                ? {
                    category: STALL_CATEGORY.RESOURCE,
                    resumable: true,
                    reason: `turn_timeout_under_load(${pressure})`,
                    hint: hintFor('上一轮触到墙钟上限，但机器当时资源紧张；已放宽预算，请从上次中断处继续，不要从头重做。'),
                }
                : {
                    category: STALL_CATEGORY.LOGIC,
                    resumable: true,
                    reason: 'turn_timeout',
                    hint: hintFor('上一轮触到墙钟上限。请先说明已完成到哪一步、剩下什么，再从断点继续，不要重复已做过的步骤。'),
                };

        case 'turn_idle':
            // 静默超时：没有工具在飞、也没有进展。若机器当时很挤，
            // 「没进展」很可能是工具在排队等资源，而不是模型在发呆。
            return saturated
                ? {
                    category: STALL_CATEGORY.RESOURCE,
                    resumable: true,
                    reason: `turn_idle_under_load(${pressure})`,
                    hint: hintFor('上一轮长时间没有进展，当时机器资源紧张；已让出资源，请重试并把大任务拆成更小的步骤。'),
                }
                : {
                    category: STALL_CATEGORY.LOGIC,
                    resumable: true,
                    reason: 'turn_idle',
                    hint: hintFor('上一轮长时间没有产生任何进展。请直接执行下一个具体动作，不要重复分析。'),
                };

        case 'repeated_thinking':
        case 'repeated_subagent_thinking':
            return {
                category: STALL_CATEGORY.LOGIC,
                resumable: true,
                reason: code,
                hint: hintFor('上一轮一直在重复同一段分析。请换一条路：换工具、换脚本、换验证方式，不要再重复上一次的尝试。'),
            };

        case 'repeated_tool_failure': {
            const text = [
                detail?.fingerprint,
                detail?.message,
                detail?.errorCode,
            ].filter(Boolean).join(' ').toLowerCase();
            const resourceish = RESOURCE_SYMPTOMS.some((symptom) => text.includes(symptom));
            return resourceish
                ? {
                    category: STALL_CATEGORY.RESOURCE,
                    resumable: true,
                    reason: 'repeated_tool_failure_resource',
                    hint: hintFor('上一轮工具连续失败，错误像是资源不足（内存 / 进程数 / 超时）。已释放资源，请缩小单次任务规模后重试。'),
                }
                : {
                    category: STALL_CATEGORY.LOGIC,
                    resumable: true,
                    reason: 'repeated_tool_failure',
                    hint: hintFor('同一个工具调用连续失败。请贴出实际错误、改用另一条路径，或先手工验证这一步再重试。'),
                };
        }

        case 'turn_token_budget':
            return {
                category: STALL_CATEGORY.LOGIC,
                resumable: true,
                reason: 'turn_token_budget',
                hint: hintFor('上一轮用完了单轮 token 预算。请把结论落到文件里，新一轮从文件继续，不要重新推导。'),
            };

        case 'agent_tool_error_loop':
            return {
                category: STALL_CATEGORY.LOGIC,
                resumable: true,
                reason: 'agent_tool_error_loop',
                hint: hintFor('工具调用陷入参数校验死循环。请换一种调用方式，或先用只读方式确认参数格式。'),
            };

        default:
            return {
                category: STALL_CATEGORY.TRANSIENT,
                resumable: true,
                reason: code || 'unknown',
                hint: hintFor('上一轮意外中断。已记账，稍后自动续跑，请接着上次的进度继续。'),
            };
    }
}

/**
 * 熔断预算按资源状态伸缩。
 *
 * 这是修「有进展也停」的关键：旧护栏的 4 小时是**绝对**墙钟，
 * 机器挤的时候一个 FreeCAD 构建就可能吃掉几十分钟。机器挤 → 放宽；
 * 机器空 → 保持原值（不放宽，避免空转也被当成「在干活」）。
 */
export function scaleTurnBudgets(base, resources = null, config = RESOURCE_SCHEDULER_DEFAULTS) {
    const pressure = resources?.headroom?.pressure ?? 'normal';
    const saturated = pressure === 'high' || pressure === 'critical';
    const turnScale = saturated
        ? config.turnBudgetScaleSaturated
        : config.turnBudgetScaleIdle;
    const idleScale = saturated
        ? config.turnBudgetScaleSaturated
        : 1;
    return {
        maxTurnWallClockMs: Math.round(Number(base?.maxTurnWallClockMs ?? 0) * turnScale),
        maxIdleMs: Math.round(Number(base?.maxIdleMs ?? 0) * idleScale),
        scale: { turn: turnScale, idle: idleScale, pressure },
    };
}

/**
 * 调度器。
 *
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {() => number} [options.now]
 * @param {(task: object) => void} [options.onChange] 状态变化回调（用于落盘 / 广播）
 */
export function createResourceScheduler({
    config = readResourceSchedulerConfig(),
    now = () => Date.now(),
    onChange = null,
} = {}) {
    /** @type {Map<string, object>} */
    const tasks = new Map();
    let resources = null;
    let pump = null;
    let changeHandler = typeof onChange === 'function' ? onChange : null;

    const notify = (task, event) => {
        if (typeof changeHandler !== 'function') return;
        try {
            changeHandler(task, event);
        } catch { /* 落盘失败不该拖垮调度 */ }
    };

    const costOf = (task) => ({
        ramMb: Number(task?.cost?.ramMb ?? config.taskRamMb),
        vramMb: Number(task?.cost?.vramMb ?? config.taskVramMb),
        cpuWeight: Number(task?.cost?.cpuWeight ?? config.taskCpuWeight),
    });

    /**
     * 这个任务现在能不能开？
     *
     * 三个条件全过才允许：并发没到顶、**资源装得下**。
     * 「装得下」按内存与显存的绝对余量算：任务预估占用 + 地板余量
     * 必须小于当前可用内存。
     *
     * 注意这里**不判断** `config.enabled` —— 「调度器关掉」等于
     * 「没有资源限制」，那是 `gate` 那一层的语义。这里只回答
     * 「按资源算，装不装得下」。
     */
    const canAdmit = (task, snapshot = resources) => {
        if (!task) return false;
        if (task.status !== TASK_STATUS.QUEUED) return false;
        if (runningCount() >= config.maxConcurrent) return false;

        const headroom = snapshot?.headroom;
        if (!headroom) return true; // 没有采样数据时不阻塞（宁跑也不要卡死）

        const cost = costOf(task);
        const memFreeMb = (Number(snapshot?.memFreeBytes ?? 0)) / (1024 * 1024);
        // 地板余量：即使任务本身只要 512 MB，机器也得留得住地板那份，
        // 否则一个「小任务」就能把机器榨干。
        const memFloorMb = Number(config.memFloorBytes ?? 0) / (1024 * 1024);
        if (memFreeMb > 0) {
            const reserve = Math.max(memFloorMb, cost.ramMb);
            if (memFreeMb < reserve) return false;
        }
        const vramFreeMb = snapshot?.vram
            ? (Number(snapshot.vram.totalBytes) - Number(snapshot.vram.usedBytes)) / (1024 * 1024)
            : null;
        if (vramFreeMb !== null && cost.vramMb > 0 && vramFreeMb < cost.vramMb) return false;
        if (headroom.cpuIdleCores !== undefined && cost.cpuWeight > headroom.cpuIdleCores) return false;
        return true;
    };

    const runningCount = () => {
        let count = 0;
        for (const task of tasks.values()) if (task.status === TASK_STATUS.RUNNING) count += 1;
        return count;
    };

    const queuedList = () => {
        // 优先级高的先来；同优先级按入队时间 FIFO。
        return [...tasks.values()]
            .filter((task) => task.status === TASK_STATUS.QUEUED)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
    };

    return {
        get config() { return config; },
        get resources() { return resources; },

        setResources(snapshot) {
            resources = snapshot ? { ...snapshot } : null;
            notify(null, 'resources');
            // 资源变了就重新看一眼队列：之前因为挤而排队的任务现在可能能开了。
            if (typeof pump === 'function') pump();
        },

        /** 由外部（并发闸门）注入「队列重试」钩子。 */
        setPump(fn) { pump = typeof fn === 'function' ? fn : null; },

        /** 替换状态变化回调（落盘 / 广播）。 */
        setOnChange(fn) { changeHandler = typeof fn === 'function' ? fn : null; },

        register(input = {}) {
            const id = String(input.id ?? input.sessionKey ?? '').trim();
            if (!id) return null;
            const timestamp = now();
            const existing = tasks.get(id);
            if (existing) {
                existing.goal = input.goal ?? existing.goal;
                existing.projectPath = input.projectPath ?? existing.projectPath;
                existing.priority = input.priority ?? existing.priority;
                existing.cost = { ...existing.cost, ...(input.cost ?? {}) };
                notify(existing, 'updated');
                return existing;
            }
            const task = {
                id,
                sessionKey: input.sessionKey ?? id,
                projectPath: input.projectPath ?? null,
                goal: input.goal ?? '',
                priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
                status: TASK_STATUS.QUEUED,
                cost: costOf(input),
                enqueuedAt: timestamp,
                startedAt: null,
                lastProgressAt: null,
                progressCount: 0,
                attempts: 0,
                pauseCount: 0,
                pauseReason: null,
                pauseHint: null,
                resumeAt: null,
                stopReason: null,
                lastStall: null,
            };
            tasks.set(id, task);
            notify(task, 'registered');
            return task;
        },

        get(id) { return tasks.get(String(id ?? '')) ?? null; },
        list() { return [...tasks.values()]; },

        /** 任务从「排队」变成「在跑」。由并发闸门放行时调用。 */
        markRunning(id) {
            const task = tasks.get(String(id ?? ''));
            if (!task) return null;
            task.status = TASK_STATUS.RUNNING;
            task.startedAt = now();
            task.attempts += 1;
            task.resumeAt = null;
            notify(task, 'running');
            return task;
        },

        /** 任务结束。`status` 决定进 done / failed / cancelled。 */
        release(id, { status = TASK_STATUS.DONE, reason = null } = {}) {
            const task = tasks.get(String(id ?? ''));
            if (!task) return null;
            task.status = status;
            task.stopReason = reason;
            task.finishedAt = now();
            notify(task, 'released');
            if (typeof pump === 'function') pump();
            return task;
        },

        unregister(id) {
            const key = String(id ?? '');
            const existed = tasks.delete(key);
            if (existed) notify(null, 'unregistered');
            return existed;
        },

        /** 观测到一次有效进展：清掉暂停标记，刷新心跳。 */
        observeProgress(id) {
            const task = tasks.get(String(id ?? ''));
            if (!task) return null;
            const timestamp = now();
            task.lastProgressAt = timestamp;
            task.progressCount += 1;
            return task;
        },

        /**
         * 任务熔断 / 中断时的统一入口。
         *
         * 返回 `{ resumable, task }`：
         *   - `resumable: true`  → 任务进入 `paused`，调度器会在资源允许时
         *                          自动把它放回队列（**不再终止**）；
         *   - `resumable: false` → 次数用尽或用户已接管，判失败。
         *
         * `countAttempt` 默认 true（熔断计入暂停预算）。**中断**类事件
         * （网关断连、模型错误）由命令循环账本的 `recoveryCount` 单独计次，
         * 所以传 false —— 两套预算各管各的，不会互相把任务提前判死。
         */
        pause(id, stall, { forced = false, countAttempt = true, reason = null, hint = null, resumeAt = null } = {}) {
            const task = tasks.get(String(id ?? ''));
            if (!task) return null;
            const classification = classifyStall(stall, resources);
            if (countAttempt) task.pauseCount += 1;
            task.pauseReason = reason ?? classification.reason;
            task.pauseHint = hint ?? classification.hint;
            task.lastStall = {
                code: stall?.code ?? null,
                category: classification.category,
                reason: classification.reason,
                at: new Date(now()).toISOString(),
                detail: stall?.detail ?? null,
            };
            const exhausted = countAttempt && task.pauseCount > config.maxPauseAttempts;
            if (!classification.resumable || exhausted || forced) {
                task.status = TASK_STATUS.FAILED;
                task.stopReason = exhausted
                    ? `${classification.reason}:pause_budget_exhausted`
                    : classification.reason;
                notify(task, 'failed');
                return { resumable: false, task, classification };
            }
            task.status = TASK_STATUS.PAUSED;
            // 指数退避：第一次 30s，第二次 60s，第三次 120s……
            const backoff = config.pauseBackoffMs * Math.pow(2, Math.max(0, task.pauseCount - 1));
            task.resumeAt = resumeAt ?? (now() + backoff);
            notify(task, 'paused');
            return { resumable: true, task, classification };
        },

        /**
         * 把到期且资源允许的暂停任务放回队列。
         * 返回被重新排队的任务列表。
         */
        resumePaused() {
            const timestamp = now();
            const resumed = [];
            for (const task of tasks.values()) {
                if (task.status !== TASK_STATUS.PAUSED) continue;
                if (task.resumeAt && timestamp < task.resumeAt) continue;
                if (task.pauseCount > config.maxPauseAttempts) continue;
                task.status = TASK_STATUS.QUEUED;
                task.resumeAt = null;
                resumed.push(task);
                notify(task, 'resumed');
            }
            if (resumed.length > 0 && typeof pump === 'function') pump();
            return resumed;
        },

        /** 压力过高时，让最低优先级的运行中任务让路。返回被让路的任务。 */
        yieldUnderPressure() {
            if (!resources?.headroom?.saturated) return [];
            const running = [...tasks.values()]
                .filter((task) => task.status === TASK_STATUS.RUNNING)
                .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
            if (running.length <= 1) return [];
            // 至少留一个在跑，全让光等于什么都不干。
            const victim = running[0];
            victim.status = TASK_STATUS.PAUSED;
            victim.pauseReason = 'yielded_under_pressure';
            victim.pauseHint = '机器资源紧张，本任务已主动让路，稍后自动续跑。';
            victim.resumeAt = now() + config.pauseBackoffMs;
            notify(victim, 'paused');
            return [victim];
        },

        canAdmit,
        runningCount,
        queuedList,

        /** 给 API / 界面的完整快照。 */
        snapshot() {
            const timestamp = now();
            return {
                enabled: config.enabled,
                config: { ...config },
                timestamp,
                resources: resources ? { ...resources } : null,
                counts: {
                    total: tasks.size,
                    running: runningCount(),
                    queued: queuedList().length,
                    paused: [...tasks.values()].filter((task) => task.status === TASK_STATUS.PAUSED).length,
                },
                tasks: [...tasks.values()].map((task) => ({ ...task })),
            };
        },
    };
}
