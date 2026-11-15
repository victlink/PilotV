/**
 * 任务总调度（TaskMaster）HTTP 接口。
 *
 * 为什么要有这组接口
 * ------------------
 * 2026-11-15 的排查里，最难判断的一件事是「任务到底停在哪一步」：
 * 界面只显示「自动推进开关还亮着，但任务不动了」，日志里散落着
 * `turn stall (repeated_thinking)` / `commander loop abandoned` 这类行，
 * 用户看不到队列位置、看不到当前机器还剩多少余量、也看不到任务在等什么。
 *
 * 这组接口把三件事变成**可查询的事实**：
 *   1. 机器现在怎么样（CPU / 内存 / 显存 / 压力分级）；
 *   2. 任务队列长什么样（谁在跑、谁在排队、排第几、为什么被暂停）；
 *   3. 调度器的判定依据（准入阈值、暂停预算、退避时间）。
 *
 * 全部是**只读 + 少量人工干预**接口：人工干预只做「取消」与「立即恢复」，
 * 不提供「强行放行一个装不下的任务」这种会把机器压垮的操作。
 *
 * 路由挂在 `/api/resource-scheduler/*`，与上游自带的 `routes/taskmaster.js`
 * （TaskMaster AI CLI 集成）刻意分开，避免命名混淆。
 */

import express from 'express';

const router = express.Router();

/**
 * @param {object} deps
 * @param {() => object} deps.getSnapshot 调度器快照
 * @param {(id: string) => object|null} [deps.getTask]
 * @param {(id: string) => boolean} [deps.cancelTask]
 * @param {(id: string) => boolean} [deps.resumeTask]
 */
export function createResourceSchedulerRouter({
    getSnapshot,
    getTask = null,
    cancelTask = null,
    resumeTask = null,
} = {}) {
    const snapshot = () => {
        if (typeof getSnapshot !== 'function') return null;
        try {
            return getSnapshot();
        } catch (error) {
            return { error: error?.message || String(error) };
        }
    };

    /** 机器实时状态 + 压力分级。界面顶部的资源条读这个。 */
    router.get('/resources', (_req, res) => {
        const current = snapshot();
        if (!current) {
            res.status(503).json({ error: 'scheduler unavailable' });
            return;
        }
        res.json({
            enabled: current.enabled ?? false,
            resources: current.resources ?? null,
            counts: current.counts ?? null,
            config: current.config ?? null,
            monitorRunning: current.monitorRunning ?? false,
            lastPersistError: current.lastPersistError ?? null,
            timestamp: current.timestamp ?? Date.now(),
        });
    });

    /** 完整任务队列快照。 */
    router.get('/tasks', (_req, res) => {
        const current = snapshot();
        if (!current) {
            res.status(503).json({ error: 'scheduler unavailable' });
            return;
        }
        res.json({
            enabled: current.enabled ?? false,
            counts: current.counts ?? null,
            tasks: current.tasks ?? [],
            // 界面一次拉齐：资源与队列在同一个响应里，避免两次请求之间
            // 出现「资源显示紧张、队列显示空闲」这种自相矛盾的中间态。
            resources: current.resources ?? null,
            timestamp: current.timestamp ?? Date.now(),
        });
    });

    /** 单个任务详情（含最近一次熔断的分类与提示）。 */
    router.get('/tasks/:id', (req, res) => {
        if (typeof getTask !== 'function') {
            res.status(503).json({ error: 'scheduler unavailable' });
            return;
        }
        const task = getTask(req.params.id);
        if (!task) {
            res.status(404).json({ error: 'task not found' });
            return;
        }
        res.json(task);
    });

    /** 取消一个任务（排队中的或运行中的）。 */
    router.post('/tasks/:id/cancel', (req, res) => {
        if (typeof cancelTask !== 'function') {
            res.status(503).json({ error: 'scheduler unavailable' });
            return;
        }
        const ok = cancelTask(req.params.id);
        if (!ok) {
            res.status(404).json({ error: 'task not found' });
            return;
        }
        res.json({ ok: true, id: req.params.id });
    });

    /**
     * 立即恢复一个被暂停的任务。
     *
     * 仍然要过准入闸：机器装不下就恢复不了，接口如实回报原因，
     * 而不是假装恢复了。这是有意为之 —— 「点了没反应」比「点了就崩」
     * 好排查得多。
     */
    router.post('/tasks/:id/resume', (req, res) => {
        if (typeof resumeTask !== 'function') {
            res.status(503).json({ error: 'scheduler unavailable' });
            return;
        }
        const result = resumeTask(req.params.id);
        if (!result?.ok) {
            res.status(409).json({
                error: result?.reason ?? 'task cannot resume right now',
                task: result?.task ?? null,
            });
            return;
        }
        res.json({ ok: true, id: req.params.id, task: result.task ?? null });
    });

    return router;
}

export default router;
