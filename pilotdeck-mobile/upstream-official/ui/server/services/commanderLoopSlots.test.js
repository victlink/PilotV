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
});
