import { describe, expect, it } from 'vitest';

import { createCommanderSlotLimiter } from './commanderLoopSlots.js';

describe('自动推进全局并发闸门', () => {
    it('默认串行：第二个任务排队，第一条结束才放行', async () => {
        const slots = createCommanderSlotLimiter();
        await slots.acquire();
        expect(slots.activeCount).toBe(1);

        let secondStarted = false;
        const second = slots.acquire().then(() => { secondStarted = true; });
        await Promise.resolve();
        expect(secondStarted).toBe(false);
        expect(slots.queuedCount).toBe(1);

        slots.release();
        await second;
        expect(secondStarted).toBe(true);
        expect(slots.activeCount).toBe(1);
        expect(slots.queuedCount).toBe(0);

        slots.release();
        expect(slots.activeCount).toBe(0);
    });

    it('FIFO：先排队的先拿到空位', async () => {
        const slots = createCommanderSlotLimiter({ maxConcurrent: 1 });
        await slots.acquire();
        const order = [];
        const p2 = slots.acquire().then(() => order.push(2));
        const p3 = slots.acquire().then(() => order.push(3));
        slots.release();
        await p2;
        slots.release();
        await p3;
        expect(order).toEqual([2, 3]);
        slots.release();
    });

    it('可配置并发 2：第三条才排队', async () => {
        const slots = createCommanderSlotLimiter({ maxConcurrent: 2 });
        await slots.acquire();
        await slots.acquire();
        expect(slots.activeCount).toBe(2);
        let third = false;
        const pending = slots.acquire().then(() => { third = true; });
        await Promise.resolve();
        expect(third).toBe(false);
        slots.release();
        await pending;
        expect(third).toBe(true);
        expect(slots.activeCount).toBe(2);
        slots.release();
        slots.release();
        expect(slots.activeCount).toBe(0);
    });

    it('多余 release 不会把计数减成负数或超发', async () => {
        const slots = createCommanderSlotLimiter({ maxConcurrent: 1 });
        slots.release();
        slots.release();
        expect(slots.activeCount).toBe(0);
        await slots.acquire();
        expect(slots.activeCount).toBe(1);
    });

    it('准入闸拒绝时不放行，即使有空位', async () => {
        let allow = false;
        const slots = createCommanderSlotLimiter({
            maxConcurrent: 1,
            gate: () => allow,
        });
        let started = false;
        const pending = slots.acquire().then(() => { started = true; });
        await Promise.resolve();
        expect(started).toBe(false);
        expect(slots.queuedCount).toBe(1);
        expect(slots.activeCount).toBe(0);
        pending.catch(() => {});
    });

    it('资源腾出来后 pump() 会放行排队的任务', async () => {
        let allow = false;
        const slots = createCommanderSlotLimiter({
            maxConcurrent: 1,
            gate: () => allow,
        });
        let started = false;
        const pending = slots.acquire().then(() => { started = true; });
        await Promise.resolve();
        expect(started).toBe(false);
        allow = true;
        slots.pump();
        await pending;
        expect(started).toBe(true);
        expect(slots.activeCount).toBe(1);
    });

    it('闸门抛错按「不放行」处理，不让异常打断排队', async () => {
        const slots = createCommanderSlotLimiter({
            maxConcurrent: 1,
            gate: () => { throw new Error('resource probe failed'); },
        });
        let started = false;
        const pending = slots.acquire().then(() => { started = true; });
        await Promise.resolve();
        expect(started).toBe(false);
        expect(slots.queuedCount).toBe(1);
        pending.catch(() => {});
    });

    it('闸门拒绝时不跳过队首（保持 FIFO，不制造饥饿）', async () => {
        const allowed = new Set(['second']);
        const slots = createCommanderSlotLimiter({
            maxConcurrent: 1,
            gate: (meta) => allowed.has(meta),
        });
        const order = [];
        const p1 = slots.acquire('first').then(() => order.push('first'));
        const p2 = slots.acquire('second').then(() => order.push('second'));
        await Promise.resolve();
        // 队首被拒，但此刻有空位且队首不许过 —— 队首应当原地等待，
        // 而不是让第二个人插队（否则会永远饿死队首）。
        expect(order).toEqual([]);
        expect(slots.queuedCount).toBe(2);
        p1.catch(() => {});
        p2.catch(() => {});
    });
});
