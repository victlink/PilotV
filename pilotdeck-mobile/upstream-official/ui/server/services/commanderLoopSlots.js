/**
 * 自动推进循环的全局并发闸门。
 *
 * 2026-11-13 的三次网关崩溃（V8 `Check failed: marking_done_`）都发生在
 * 两个自动推进会话同时跑、上下文 65k/75k tokens 并触发 full compaction 时。
 * 单个 UI server 进程里同时驱动两条长上下文循环，是当时最明确的共同点。
 *
 * 默认只允许 1 条自动推进循环在跑：用户给两个任务都开了自动推进时，
 * 第二条排队等第一条结束，而不是一起把 gateway 压崩。普通聊天不受影响。
 * 变成"排队"而不是"拒绝"，是因为拒绝会让用户以为第二个任务没开始。
 *
 * 资源感知（2026-11-15）
 * ----------------------
 * 旧版闸门只数「现在跑了几条」，不问「这台机器还装得下吗」。2026-11-15
 * 实测：新风机为等咖啡机的 4 小时绝对墙钟，从 02:31 排到 06:35，
 * 排队期间既没有进度也没有解释，界面上就是「任务停住了」。
 *
 * 现在闸门多了一个**准入闸**（`gate`）：
 *   - 放行时按 FIFO 找队首，队首的 `gate(meta)` 返回 false 就继续等，
 *     绝不跳过队首（跳过会造成插队与饥饿）；
 *   - `gate` 由资源调度器提供：内存 / CPU / 显存装不下就不放行；
 *   - 资源变化时调度器调用 `pump()` 重新看一眼队列，于是「机器腾出空间了」
 *     能自动放行排队中的任务，不需要用户重开。
 *
 * `gate` 是可选的：不传就退化成旧行为（纯并发计数）。
 *
 * 计数约定：`active` 是**已占用**的空位数。`settleHead` 只在「当前确实
 * 有一个空位」（`active < limit`）时才把队首放出来并把 `active` 加一；
 * `release` 先把 `active` 减一（释放），再尝试立刻交给队首。
 */
export function createCommanderSlotLimiter({ maxConcurrent = 1, gate = null } = {}) {
    const limit = Number.isFinite(maxConcurrent) && maxConcurrent > 0
        ? Math.floor(maxConcurrent)
        : 1;
    let active = 0;
    const waiting = [];

    /** 队首是否放行。gate 抛错时按「不放行」处理：宁可等，也不压垮机器。 */
    const admits = (meta) => {
        if (typeof gate !== 'function') return true;
        try {
            return gate(meta) === true;
        } catch {
            return false;
        }
    };

    /**
     * 若队首被放行，就把它从队列里取走、占住空位并 resolve。
     * 调用方必须保证此刻确实有空位（`active < limit`）。
     */
    const settleHead = () => {
        while (waiting.length > 0) {
            const next = waiting[0];
            if (!admits(next.meta)) return false;
            waiting.shift();
            active += 1;
            next.resolve();
            return true;
        }
        return false;
    };

    return {
        /**
         * 排队等到有空位（且机器装得下）；FIFO，先开的会话先跑。
         *
         * 严格 FIFO：只要队列里已经有人，后来者**必须**排队，哪怕它的
         * 准入闸此刻是放行的。否则一个闸门暂时不放行的队首会被后来者
         * 无限插队，直到饿死 —— 2026-11-15 实测新风机就是这样在队列里
         * 干等了 4 小时的。
         */
        acquire(meta = null) {
            if (waiting.length === 0 && active < limit && admits(meta)) {
                active += 1;
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                waiting.push({ resolve, meta });
                // 入队后再判一次：gate 的结论可能在排队期间变化
                // （例如资源刚腾出来）。
                if (active < limit) settleHead();
            });
        },
        /** 释放一个空位；队首若被放行则立刻移交给它，避免瞬间超发。 */
        release() {
            active = Math.max(0, active - 1);
            settleHead();
        },
        /** 资源变化后重新看一眼队列（gate 由 false 变 true 时用）。 */
        pump() {
            if (active >= limit) return false;
            return settleHead();
        },
        get activeCount() { return active; },
        get queuedCount() { return waiting.length; },
        get limit() { return limit; },
        /** 队列位置（0 起），用于告诉用户「你前面还有几个任务」。 */
        queuePosition(meta) {
            const index = waiting.findIndex((entry) => entry.meta === meta);
            return index === -1 ? null : index;
        },
    };
}
