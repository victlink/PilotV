/**
 * 本机资源实时采样（CPU / 内存 / 显存）。
 *
 * 为什么要有这份文件
 * ------------------
 * 2026-11-15 的排查结论：咖啡机与新风机的自动推进反复「跑到一半自动停止」，
 * 直接触发者不是 CPU / 内存不够，而是 PilotV 自己的**无进展熔断**
 * （`turnStallGuard.js`）：重复 thinking、重复工具失败、30 分钟静默、
 * 4 小时墙钟兜底。熔断一命中就把循环归档成终态 `waiting_user`，
 * 恢复守护按设计**永不续跑**，界面上就表现为「任务停了」。
 *
 * 但资源确实参与了：熔断判定只看「有没有进展」，看不到「这台机器现在
 * 有多挤」。一台 16 核 / 15.4 GB 的机器同时跑两个长 CAD 任务 + 一个
 * `tsc --noEmit` 时，可用内存一度只剩 1.8 GB（88% 已用），FreeCAD / Python
 * 脚本开始 OOM 与超时，工具失败率上升，于是模型反复重试同一段脚本，
 * 复读计数被顶到上限 —— 表面看是「模型卡住」，根子在资源挤。
 *
 * 所以需要一个**客观、可采样、可审计**的资源事实源：调度器据此决定
 * 「还能不能再开一个任务」「这个任务该继续跑还是先让路」「熔断的预算是
 * 该收紧还是该放宽」。本模块只负责采样与算余量，不做任何决策。
 *
 * 设计约束：
 *   - **零依赖**：`os` 内置 API 拿 CPU / 内存，不 spawn 任何进程；
 *     显存只有存在 NVIDIA 卡的机器上才有，缺失时如实返回 `null`，
 *     绝不假装有。
 *   - **可测**：所有采样源都可注入，单测不需要真的把机器压满。
 *   - **纯函数优先**：判定逻辑（余量、压力分级）与采样分离。
 */

import os from 'node:os';
import { spawnSync } from 'node:child_process';

/** 采样与判定的默认阈值。环境变量可覆盖，见 `readResourceMonitorConfig`。 */
export const RESOURCE_MONITOR_DEFAULTS = Object.freeze({
    /** 采样间隔。5 秒足够反应，又不至于把 CPU 采样本身变成负载。 */
    sampleIntervalMs: 5_000,
    /** 显存查询要 spawn `nvidia-smi`，比内存采样贵得多，单独降频。 */
    vramRefreshMs: 20_000,
    /** 空闲内存低于此值：不再接纳新任务。 */
    memFloorBytes: 2 * 1024 * 1024 * 1024,
    /** 空闲内存低于此值：压力「高」，运行中的任务要主动让路。 */
    memCriticalBytes: 768 * 1024 * 1024,
    /** CPU 使用率高于此值：不再接纳新任务。 */
    cpuCeilingPercent: 85,
    /** CPU 使用率高于此值：压力「高」。 */
    cpuCriticalPercent: 95,
    /** 显存占用高于此值：压力「高」。 */
    vramCeilingPercent: 90,
});

/** 压力分级。`critical` 时调度器会主动暂停低优先级任务让出资源。 */
export const RESOURCE_PRESSURE = Object.freeze({
    NORMAL: 'normal',
    ELEVATED: 'elevated',
    HIGH: 'high',
    CRITICAL: 'critical',
});

function intFromEnv(env, name, fallback) {
    const raw = String(env?.[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bytesFromEnv(env, name, fallback) {
    const raw = String(env?.[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readResourceMonitorConfig(env = process.env) {
    return {
        sampleIntervalMs: intFromEnv(env, 'PILOTV_SCHEDULER_SAMPLE_MS', RESOURCE_MONITOR_DEFAULTS.sampleIntervalMs),
        vramRefreshMs: intFromEnv(env, 'PILOTV_SCHEDULER_VRAM_REFRESH_MS', RESOURCE_MONITOR_DEFAULTS.vramRefreshMs),
        memFloorBytes: bytesFromEnv(env, 'PILOTV_SCHEDULER_MEM_FLOOR_MB', RESOURCE_MONITOR_DEFAULTS.memFloorBytes),
        memCriticalBytes: bytesFromEnv(env, 'PILOTV_SCHEDULER_MEM_CRITICAL_MB', RESOURCE_MONITOR_DEFAULTS.memCriticalBytes),
        cpuCeilingPercent: intFromEnv(env, 'PILOTV_SCHEDULER_CPU_CEILING', RESOURCE_MONITOR_DEFAULTS.cpuCeilingPercent),
        cpuCriticalPercent: intFromEnv(env, 'PILOTV_SCHEDULER_CPU_CRITICAL', RESOURCE_MONITOR_DEFAULTS.cpuCriticalPercent),
        vramCeilingPercent: intFromEnv(env, 'PILOTV_SCHEDULER_VRAM_CEILING', RESOURCE_MONITOR_DEFAULTS.vramCeilingPercent),
    };
}

/** 把采样归一成 0..1 的余量；没有数据的维度返回 null（不是 0，也不是 1）。 */
function ratio(free, total) {
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
    return Math.max(0, Math.min(1, free / total));
}

/**
 * 由一次采样算出「还能承载多少」。
 *
 * `cpuHeadroom` 用的是**有效并行度**而不是简单的 1-CPU%：
 * 16 核机器上 CPU 50% 意味着还有 8 核空着，按 1-50%=0.5 算会严重低估。
 * 这里给的是「还能再开几个满负荷任务」的折算值。
 */
export function computeHeadroom(sample, config = RESOURCE_MONITOR_DEFAULTS) {
    const cpuPercent = Number(sample?.cpuPercent ?? 0);
    const cores = Math.max(1, Number(sample?.cpuCores ?? 1));
    const cpuIdleCores = Math.max(0, cores * (1 - Math.max(0, Math.min(100, cpuPercent)) / 100));

    const memTotal = Number(sample?.memTotalBytes ?? 0);
    const memFree = Number(sample?.memFreeBytes ?? 0);
    const memHeadroom = ratio(memFree, memTotal);
    // 内存余量按「离地板还有多远」算，而不是按百分比：15 GB 机器上
    // 剩 3 GB 和剩 12 GB 在调度意义上完全不同，百分比掩盖了这个差别。
    const memFloor = Math.max(0, Number(config.memFloorBytes ?? 0));
    const memAboveFloor = memTotal > 0
        ? Math.max(0, Math.min(1, (memFree - memFloor) / Math.max(1, memTotal - memFloor)))
        : null;

    const vram = sample?.vram ?? null;
    const vramHeadroom = vram && vram.totalBytes > 0
        ? ratio(Math.max(0, vram.totalBytes - vram.usedBytes), vram.totalBytes)
        : null;

    // 总体余量取最紧的那一维。任一维度见底都不该再开新任务。
    const dimensions = [cpuIdleCores / cores, memAboveFloor, vramHeadroom]
        .filter((value) => Number.isFinite(value));
    const overall = dimensions.length > 0 ? Math.min(...dimensions) : 1;

    const pressure = classifyPressure(sample, config);
    return {
        cpu: Math.max(0, Math.min(1, cpuIdleCores / cores)),
        cpuIdleCores,
        memory: memHeadroom,
        memoryAboveFloor: memAboveFloor,
        vram: vramHeadroom,
        overall,
        pressure,
        /** 压力为高/危急时，调度器应当让运行中的低优先级任务先让路。 */
        saturated: pressure === RESOURCE_PRESSURE.HIGH || pressure === RESOURCE_PRESSURE.CRITICAL,
    };
}

export function classifyPressure(sample, config = RESOURCE_MONITOR_DEFAULTS) {
    const cpuPercent = Number(sample?.cpuPercent ?? 0);
    if (cpuPercent >= (config.cpuCriticalPercent ?? 95)) return RESOURCE_PRESSURE.CRITICAL;

    const memFree = Number(sample?.memFreeBytes ?? Number.POSITIVE_INFINITY);
    if (memFree <= (config.memCriticalBytes ?? 0)) return RESOURCE_PRESSURE.CRITICAL;

    const vram = sample?.vram ?? null;
    const vramPercent = vram && vram.totalBytes > 0
        ? (vram.usedBytes / vram.totalBytes) * 100
        : 0;

    if (cpuPercent >= (config.cpuCeilingPercent ?? 85)) return RESOURCE_PRESSURE.HIGH;
    if (memFree <= (config.memFloorBytes ?? 0)) return RESOURCE_PRESSURE.HIGH;
    if (vramPercent >= (config.vramCeilingPercent ?? 90)) return RESOURCE_PRESSURE.HIGH;

    // 「临界但未破线」算 elevated：调度器开始收紧，但不至于暂停任务。
    const memTotal = Number(sample?.memTotalBytes ?? 0);
    const memUsedPercent = memTotal > 0 ? ((memTotal - memFree) / memTotal) * 100 : 0;
    if (cpuPercent >= (config.cpuCeilingPercent ?? 85) * 0.8) return RESOURCE_PRESSURE.ELEVATED;
    if (memTotal > 0 && memUsedPercent >= 85) return RESOURCE_PRESSURE.ELEVATED;
    if (vramPercent >= (config.vramCeilingPercent ?? 90) * 0.8) return RESOURCE_PRESSURE.ELEVATED;

    return RESOURCE_PRESSURE.NORMAL;
}

/** `os.cpus()` 的累计时间 → 一个可比较的「总忙碌毫秒」与「总空闲毫秒」。 */
export function readCpuTimes(cpus = os.cpus()) {
    let total = 0;
    let idle = 0;
    for (const cpu of cpus) {
        const times = cpu?.times ?? {};
        total += (times.user ?? 0) + (times.nice ?? 0) + (times.sys ?? 0)
            + (times.idle ?? 0) + (times.irq ?? 0);
        idle += times.idle ?? 0;
    }
    return { total, idle, cores: Math.max(1, cpus.length) };
}

/**
 * 解析 `nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits`。
 * 返回 null 表示「这台机器没有可读的 NVIDIA 显存」，不是错误。
 */
export function parseVramOutput(stdout) {
    const text = String(stdout ?? '').trim();
    if (!text) return null;
    const first = text.split(/\r?\n/)[0] ?? '';
    const parts = first.split(',').map((part) => part.trim());
    if (parts.length < 2) return null;
    const total = Number.parseInt(parts[0], 10);
    const used = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(total) || !Number.isFinite(used)) return null;
    return { totalBytes: total * 1024 * 1024, usedBytes: used * 1024 * 1024 };
}

/**
 * 默认的显存查询：跑 `nvidia-smi`。
 *
 * 为什么要单独降频：这是唯一需要 spawn 子进程的采样项，
 * 每次采样都跑一遍会把「监测资源」本身变成负载。所以采样间隔
 * 5 秒，显存查询单独 20 秒一次。
 *
 * 没有 NVIDIA 卡（或 nvidia-smi 不在 PATH）时抛错，由调用方转成
 * `vram: null` —— 如实说「读不到」，不假装显存是 0。
 */
export function runNvidiaSmi(args) {
    const result = spawnSync('nvidia-smi', args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`nvidia-smi exited ${result.status}: ${String(result.stderr ?? '').trim()}`);
    }
    return { stdout: result.stdout ?? '' };
}

/**
 * 资源监视器。
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {() => number} [options.now]
 * @param {() => Array} [options.readCpus]           `os.cpus()` 的替身
 * @param {() => {totalBytes:number,freeBytes:number}} [options.readMemory]
 * @param {(args: string[]) => {stdout: string}} [options.runCommand]  跑 nvidia-smi 的替身
 */
export function createResourceMonitor({
    env = process.env,
    now = () => Date.now(),
    readCpus = () => os.cpus(),
    readMemory = () => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() }),
    runCommand = runNvidiaSmi,
} = {}) {
    const config = readResourceMonitorConfig(env);
    let timer = null;
    let previous = null;
    let lastVram = null;
    let lastVramAt = 0;
    /** 上次**尝试**查询显存的时刻（成功与否都记）。 */
    let lastVramAttemptAt = 0;
    /** 显存查询失败的原因（没有 NVIDIA 卡很常见，不算监控器故障）。 */
    let lastVramError = null;
    let lastSample = null;
    let lastError = null;
    const subscribers = new Set();

    const runVramQuery = () => {
        if (typeof runCommand !== 'function') return null;
        try {
            const result = runCommand([
                '--query-gpu=memory.total,memory.used',
                '--format=csv,noheader,nounits',
            ]);
            lastVramError = null;
            return parseVramOutput(result?.stdout);
        } catch (error) {
            // 显存读不到**不是**监控器故障：这台机器可能就没有 NVIDIA 卡。
            // 所以单独记一笔，不混进 lastError —— 否则界面会误报
            // 「调度器无响应」，而其实 CPU / 内存采样一切正常。
            lastVramError = error?.message || String(error);
            return null;
        }
    };

    const sample = () => {
        const timestamp = now();
        let cpuPercent = 0;
        let cpuCores = 1;
        try {
            const cpus = readCpus();
            const current = readCpuTimes(cpus);
            cpuCores = current.cores;
            if (previous) {
                const deltaTotal = current.total - previous.total;
                const deltaIdle = current.idle - previous.idle;
                if (deltaTotal > 0) {
                    cpuPercent = Math.max(0, Math.min(100, ((deltaTotal - deltaIdle) / deltaTotal) * 100));
                }
            }
            previous = current;
        } catch (error) {
            lastError = error?.message || String(error);
        }

        let memTotalBytes = 0;
        let memFreeBytes = 0;
        try {
            const memory = readMemory();
            memTotalBytes = Number(memory?.totalBytes ?? 0);
            memFreeBytes = Number(memory?.freeBytes ?? 0);
        } catch (error) {
            lastError = error?.message || String(error);
        }

        // 显存查询有 spawn 成本，按 vramRefreshMs 降频缓存。
        // 首次一定查一次（哪怕失败，后续也要按同样节奏重试，
        // 免得「第一次失败」被当成「永远没有显卡」）。
        if (lastVramAttemptAt === 0 || timestamp - lastVramAttemptAt >= config.vramRefreshMs) {
            lastVramAttemptAt = timestamp;
            const vram = runVramQuery();
            if (vram) {
                lastVram = vram;
                lastVramAt = timestamp;
            }
        }

        const raw = {
            timestamp,
            cpuPercent,
            cpuCores,
            memTotalBytes,
            memFreeBytes,
            vram: lastVram ? { ...lastVram } : null,
        };
        const headroom = computeHeadroom(raw, config);
        lastSample = { ...raw, headroom };
        for (const subscriber of subscribers) {
            try {
                subscriber(lastSample);
            } catch (error) {
                lastError = error?.message || String(error);
            }
        }
        return lastSample;
    };

    return {
        config,
        sample,
        get lastSample() { return lastSample; },
        get lastError() { return lastError; },
        /** 显存读不到的原因；null 表示显存读到了（或还没试过）。 */
        get lastVramError() { return lastVramError; },
        subscribe(fn) {
            if (typeof fn !== 'function') return () => {};
            subscribers.add(fn);
            return () => { subscribers.delete(fn); };
        },
        start() {
            if (timer) return timer;
            // 先立刻采一次，让首个订阅者马上拿到 CPU 以外的真实数字
            // （CPU 需要两次采样才有百分比，所以首帧 CPU 记 0 而不是猜）。
            sample();
            timer = setInterval(sample, config.sampleIntervalMs);
            if (typeof timer.unref === 'function') timer.unref();
            return timer;
        },
        stop() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        },
        get running() { return Boolean(timer); },
    };
}
