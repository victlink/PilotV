/**
 * 调度器运行时：把资源采样、调度决策、账本落盘接在一起。
 *
 * 分层（每层都能单独单测）：
 *
 *   resourceMonitor.js      只采样，产出事实
 *        │  setResources()
 *        ▼
 *   resourceScheduler.js    只决策，产出状态
 *        │  onChange()
 *        ▼
 *   resourceSchedulerStore.js 只落盘
 *
 * 本文件是唯一的粘合层，负责：
 *   - 采样 → 决策 → 落盘 的单向数据流；
 *   - 给并发闸门提供**准入闸**（`gate`）：机器装不下就不放行；
 *   - 资源变化时 `pump()` 队列，让「腾出空间了」能自动放行排队任务；
 *   - 进程重启后从账本把排队中的任务读回来。
 *
 * 失败原则：调度器是**旁路增强**，不是主链路。任何异常都不许影响
 * 自动推进本身的正确性 —— 采样失败就按「没有资源信息」处理（不阻塞），
 * 落盘失败就记一笔继续跑（最坏情况是这次重启后队列丢了）。
 */

import { createResourceMonitor } from './resourceMonitor.js';
import {
    createResourceScheduler,
    readResourceSchedulerConfig,
    TASK_STATUS,
} from './resourceScheduler.js';
import {
    archiveTask,
    readTaskRecords,
    saveTask,
    deleteTask,
} from './resourceSchedulerStore.js';
import { resolvePilotHome } from '../utils/pilotPaths.js';

export function createTaskmasterService({
    env = process.env,
    home = resolvePilotHome(),
    now = () => Date.now(),
    monitor: injectedMonitor = null,
    scheduler: injectedScheduler = null,
} = {}) {
    const staticConfig = readResourceSchedulerConfig(env);
    const monitor = injectedMonitor ?? createResourceMonitor({ env, now });
    const scheduler = injectedScheduler ?? createResourceScheduler({ config: staticConfig, now });

    let started = false;
    let unsubscribe = null;
    /** 账本写失败不阻塞任务，只记最近一次错误供排查。 */
    let lastPersistError = null;

    const persist = (task) => {
        if (!task || !task.id) return;
        try {
            saveTask(task, { home, now: now() });
            lastPersistError = null;
        } catch (error) {
            lastPersistError = error?.message || String(error);
        }
    };

    const archive = (task, status, reason) => {
        if (!task || !task.id) return;
        try {
            archiveTask(task, { home, now: now(), status, reason });
        } catch (error) {
            lastPersistError = error?.message || String(error);
        }
    };

    // 决策变化 → 落盘。终态任务写历史并删账本。
    scheduler.setResources?.(monitor.lastSample ?? null);
    const handleChange = (task, event) => {
        if (!task) return;
        if (event === 'released' || event === 'failed') {
            archive(task, task.status, task.stopReason);
        } else if (event === 'unregistered') {
            deleteTask(task.id, { home });
        } else {
            persist(task);
        }
    };
    scheduler.setOnChange?.(handleChange);

    const service = {
        /**
         * 生效配置。
         *
         * `enabled` 是**运行时开关**：每次访问都重新读环境变量，
         * 所以 `PILOTV_SCHEDULER=0` 能立刻把调度器关掉，不必重启 3001
         * —— 出问题时「立刻关掉」比「改完配置等重启」重要得多。
         * 其余阈值（地板余量、暂停预算、退避）在启动时读一次。
         */
        get config() {
            const live = readResourceSchedulerConfig(env);
            return { ...staticConfig, enabled: live.enabled };
        },
        monitor,
        scheduler,

        get lastPersistError() { return lastPersistError; },
        get resources() { return monitor.lastSample ?? null; },

        /**
         * 并发闸门的**准入闸**：返回 true 表示「现在可以开这个任务」。
         * 没有采样数据时一律放行（不因为监视器坏了就卡住所有任务）。
         */
        gate(meta) {
            if (!service.config.enabled) return true;
            const snapshot = monitor.lastSample;
            if (!snapshot) return true;
            const task = meta?.taskId
                ? scheduler.get(meta.taskId)
                : null;
            if (!task) return true;
            return scheduler.canAdmit(task, snapshot);
        },

        /** 资源变化 → 更新决策 → 重新看一眼队列。 */
        onResources(snapshot) {
            scheduler.setResources(snapshot);
            // 到期的暂停任务重新排队。
            scheduler.resumePaused();
            // 压力过高时让低优先级任务让路。
            scheduler.yieldUnderPressure();
            // 队列里装得下的任务现在可以开了。
            scheduler.pump?.();
            service.pumpSlots?.();
        },

        /** 注册一个自动推进任务（幂等）。 */
        registerTask(input) {
            const task = scheduler.register(input);
            if (task) persist(task);
            return task;
        },

        /** 任务被放行、开始跑。 */
        markRunning(taskId) {
            const task = scheduler.markRunning(taskId);
            if (task) persist(task);
            return task;
        },

        /** 观测到一次有效进展。 */
        observeProgress(taskId) {
            const task = scheduler.observeProgress(taskId);
            if (task) persist(task);
            return task;
        },

        /**
         * 熔断 / 中断的统一入口。
         *
         * 返回 `{ resumable, task, classification }`：
         *   - `resumable: true` → 任务**没有终止**，进入 paused，等资源允许后
         *     自动续跑（这是与旧行为最大的差别）；
         *   - `resumable: false` → 暂停次数用尽，判失败。
         */
        handleStall(taskId, stall, options = {}) {
            const result = scheduler.pause(taskId, stall, options);
            if (!result) return null;
            persist(result.task);
            return result;
        },
        /** 任务正常结束。 */
        releaseTask(taskId, { status = TASK_STATUS.DONE, reason = null } = {}) {
            const task = scheduler.release(taskId, { status, reason });
            if (task) archive(task, status, reason);
            service.pumpSlots?.();
            return task;
        },

        /** 从账本把排队中的任务读回来（进程重启后调用）。 */
        restore() {
            const { pending, finished, corrupted } = readTaskRecords({ home });
            for (const record of finished) {
                try { deleteTask(record.id, { home }); } catch { /* ignore */ }
            }
            for (const record of pending) {
                const restored = scheduler.register({
                    id: record.id,
                    sessionKey: record.sessionKey,
                    projectPath: record.projectPath,
                    goal: record.goal,
                    priority: record.priority,
                    cost: record.cost,
                });
                if (!restored) continue;
                // 恢复出来的任务一律回到 queued；pauseCount 保留，
                // 这样「已经暂停过 3 次」的任务不会因为重启就被无限复活。
                restored.status = TASK_STATUS.QUEUED;
                restored.pauseCount = record.pauseCount ?? 0;
                restored.progressCount = record.progressCount ?? 0;
                restored.attempts = record.attempts ?? 0;
                restored.enqueuedAt = record.enqueuedAt ?? now();
                persist(restored);
            }
            return { restored: pending.length, corrupted: corrupted.length };
        },

        start() {
            if (started) return service;
            started = true;
            service.restore();
            unsubscribe = monitor.subscribe((snapshot) => service.onResources(snapshot));
            monitor.start();
            service.onResources(monitor.lastSample);
            return service;
        },

        stop() {
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
            }
            monitor.stop();
            started = false;
            return service;
        },

        get running() { return started; },

        snapshot() {
            return {
                ...scheduler.snapshot(),
                resources: monitor.lastSample ?? null,
                lastPersistError,
                monitorRunning: monitor.running,
            };
        },
    };

    return service;
}
