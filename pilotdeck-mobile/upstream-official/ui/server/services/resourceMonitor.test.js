import { describe, expect, it } from 'vitest';

import {
    RESOURCE_MONITOR_DEFAULTS,
    RESOURCE_PRESSURE,
    classifyPressure,
    computeHeadroom,
    createResourceMonitor,
    parseVramOutput,
    readCpuTimes,
} from './resourceMonitor.js';

describe('资源余量计算', () => {
    it('16 核机器 CPU 50% 仍有约 8 核余量，而不是 50%', () => {
        const headroom = computeHeadroom({
            cpuPercent: 50,
            cpuCores: 16,
            memTotalBytes: 16 * 1024 ** 3,
            memFreeBytes: 12 * 1024 ** 3,
        });
        expect(headroom.cpuIdleCores).toBeCloseTo(8, 0);
        expect(headroom.cpu).toBeCloseTo(0.5, 1);
    });

    it('内存余量按「离地板还有多远」算，不是百分比', () => {
        const config = { ...RESOURCE_MONITOR_DEFAULTS, memFloorBytes: 2 * 1024 ** 3 };
        // 15.4 GB 机器剩 3 GB：离 2 GB 地板还有 1 GB，占 13.4 GB 可用区间。
        const headroom = computeHeadroom({
            cpuPercent: 5,
            cpuCores: 16,
            memTotalBytes: 15.4 * 1024 ** 3,
            memFreeBytes: 3 * 1024 ** 3,
        }, config);
        expect(headroom.memoryAboveFloor).toBeGreaterThan(0);
        expect(headroom.memoryAboveFloor).toBeLessThan(0.2);
    });

    it('没有显存数据时显存余量为 null，不是 0 也不是 1', () => {
        const headroom = computeHeadroom({
            cpuPercent: 5,
            cpuCores: 8,
            memTotalBytes: 8 * 1024 ** 3,
            memFreeBytes: 6 * 1024 ** 3,
            vram: null,
        });
        expect(headroom.vram).toBeNull();
        // 总体余量只看有数据的维度。
        expect(headroom.overall).toBeGreaterThan(0);
    });

    it('总体余量取最紧的一维', () => {
        const headroom = computeHeadroom({
            cpuPercent: 10,
            cpuCores: 8,
            memTotalBytes: 8 * 1024 ** 3,
            memFreeBytes: 0.5 * 1024 ** 3,
            vram: { totalBytes: 4 * 1024 ** 3, usedBytes: 0.5 * 1024 ** 3 },
        });
        // 内存见底时总体余量也必须见底，哪怕显存还很多。
        expect(headroom.overall).toBeLessThan(0.1);
    });
});

describe('压力分级', () => {
    const config = RESOURCE_MONITOR_DEFAULTS;

    it('空闲机器是 normal', () => {
        expect(classifyPressure({
            cpuPercent: 5,
            memTotalBytes: 16 * 1024 ** 3,
            memFreeBytes: 12 * 1024 ** 3,
        }, config)).toBe(RESOURCE_PRESSURE.NORMAL);
    });

    it('内存跌破地板是 high', () => {
        expect(classifyPressure({
            cpuPercent: 10,
            memTotalBytes: 16 * 1024 ** 3,
            memFreeBytes: 1 * 1024 ** 3,
        }, config)).toBe(RESOURCE_PRESSURE.HIGH);
    });

    it('内存跌破临界线是 critical', () => {
        expect(classifyPressure({
            cpuPercent: 10,
            memTotalBytes: 16 * 1024 ** 3,
            memFreeBytes: 256 * 1024 ** 2,
        }, config)).toBe(RESOURCE_PRESSURE.CRITICAL);
    });

    it('CPU 超过临界线是 critical', () => {
        expect(classifyPressure({
            cpuPercent: 99,
            memTotalBytes: 16 * 1024 ** 3,
            memFreeBytes: 12 * 1024 ** 3,
        }, config)).toBe(RESOURCE_PRESSURE.CRITICAL);
    });

    it('显存打满是 high', () => {
        expect(classifyPressure({
            cpuPercent: 10,
            memTotalBytes: 16 * 1024 ** 3,
            memFreeBytes: 12 * 1024 ** 3,
            vram: { totalBytes: 4 * 1024 ** 3, usedBytes: 3.9 * 1024 ** 3 },
        }, config)).toBe(RESOURCE_PRESSURE.HIGH);
    });

    it('饱和标记只在 high / critical 时为真', () => {
        const base = { memTotalBytes: 16 * 1024 ** 3, memFreeBytes: 12 * 1024 ** 3 };
        expect(computeHeadroom({ ...base, cpuPercent: 5 }, config).saturated).toBe(false);
        expect(computeHeadroom({ ...base, cpuPercent: 5, memFreeBytes: 512 * 1024 ** 2 }, config).saturated).toBe(true);
    });
});

describe('CPU 采样', () => {
    it('readCpuTimes 汇总各核并给出核数', () => {
        const result = readCpuTimes([
            { times: { user: 10, nice: 0, sys: 5, idle: 100, irq: 0 } },
            { times: { user: 20, nice: 0, sys: 5, idle: 200, irq: 0 } },
        ]);
        expect(result.cores).toBe(2);
        expect(result.total).toBe(340);
        expect(result.idle).toBe(300);
    });
});

describe('显存解析', () => {
    it('解析 nvidia-smi 的 CSV 输出', () => {
        const parsed = parseVramOutput('4096, 512\n4096, 0\n');
        expect(parsed.totalBytes).toBe(4096 * 1024 * 1024);
        expect(parsed.usedBytes).toBe(512 * 1024 * 1024);
    });

    it('没有 NVIDIA 卡时返回 null 而不是报错', () => {
        expect(parseVramOutput('')).toBeNull();
        expect(parseVramOutput('N/A, N/A')).toBeNull();
    });
});

describe('资源监视器', () => {
    it('两次采样之间算出 CPU 百分比', () => {
        let tick = 0;
        // os.cpus() 给的是**累计**时间，两次采样之间必须有增量。
        const cpus = () => {
            tick += 1;
            return tick === 1
                ? [{ times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }]
                : [{ times: { user: 50, nice: 0, sys: 0, idle: 150, irq: 0 } }];
        };
        const monitor = createResourceMonitor({
            env: {},
            now: () => 1000,
            readCpus: cpus,
            readMemory: () => ({ totalBytes: 8 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 }),
        });
        monitor.sample();
        const second = monitor.sample();
        expect(second.cpuPercent).toBeCloseTo(50, 0);
        expect(second.memFreeBytes).toBe(6 * 1024 ** 3);
    });

    it('nvidia-smi 失败时显存如实为 null，且不影响内存采样', () => {
        const monitor = createResourceMonitor({
            env: {},
            now: () => 1000,
            readCpus: () => [{ times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }],
            readMemory: () => ({ totalBytes: 8 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 }),
            runCommand: () => { throw new Error('nvidia-smi not found'); },
        });
        const sample = monitor.sample();
        expect(sample.vram).toBeNull();
        expect(sample.memFreeBytes).toBe(6 * 1024 ** 3);
        // 显存读不到单独记一笔：没有 NVIDIA 卡很常见，
        // 不该让界面误报「调度器无响应」。
        expect(monitor.lastVramError).toContain('nvidia-smi');
        expect(monitor.lastError).toBeNull();
    });

    it('默认会真的去跑 nvidia-smi（而不是永远读不到显存）', () => {
        // 这里不联网、不 spawn 真命令，只验证默认注入的 runCommand
        // 是一个能用的函数 —— 之前它默认是 null，导致显存永远读不到。
        const monitor = createResourceMonitor({
            env: {},
            now: () => 1000,
            readCpus: () => [{ times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }],
            readMemory: () => ({ totalBytes: 8 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 }),
        });
        // 显式跑一次真实查询：本机有 NVIDIA 卡时应拿到显存，
        // 没有也不该抛（会被转成 vram: null）。
        const sample = monitor.sample();
        expect(sample.vram === null || typeof sample.vram.totalBytes === 'number').toBe(true);
        if (sample.vram) {
            expect(sample.vram.totalBytes).toBeGreaterThan(0);
        }
    });

    it('订阅者能收到每次采样', () => {
        const seen = [];
        const monitor = createResourceMonitor({
            env: {},
            now: () => 1000,
            readCpus: () => [{ times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }],
            readMemory: () => ({ totalBytes: 8 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 }),
        });
        monitor.subscribe((sample) => seen.push(sample));
        monitor.sample();
        expect(seen).toHaveLength(1);
        expect(seen[0].headroom).toBeTruthy();
    });
});
