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
 */
export function createCommanderSlotLimiter({ maxConcurrent = 1 } = {}) {
    const limit = Number.isFinite(maxConcurrent) && maxConcurrent > 0
        ? Math.floor(maxConcurrent)
        : 1;
    let active = 0;
    const waiting = [];

    return {
        /** 排队等到有空位；FIFO，先开的会话先跑。 */
        acquire() {
            if (active < limit) {
                active += 1;
                return Promise.resolve();
            }
            return new Promise((resolve) => waiting.push(resolve));
        },
        /** 空位直接移交给队首，不经过 active-- 再 ++，避免瞬间超发。 */
        release() {
            const next = waiting.shift();
            if (next) {
                next();
                return;
            }
            active = Math.max(0, active - 1);
        },
        get activeCount() { return active; },
        get queuedCount() { return waiting.length; },
        get limit() { return limit; },
    };
}
