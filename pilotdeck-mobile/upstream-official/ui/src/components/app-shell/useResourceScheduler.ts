import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';

/**
 * 资源感知任务调度的轮询钩子。
 *
 * 为什么轮询而不是 WebSocket：
 *   资源采样本来就是 5 秒一采（`resourceMonitor.sampleIntervalMs`），
 *   推送的边际价值不大，而 WebSocket 会多一条要维护的长连接。
 *   轮询间隔取 5 秒，正好跟上采样节奏，也不会把界面刷成噪音。
 *
 * 失败策略：**不打断界面**。调度器没起来或返回错误时保留上一份数据，
 * 只把 `error` 标出来交给界面显示 —— 调度器是旁路增强，
 * 它挂了不该让任务窗口跟着白屏。
 */

export type SchedulerPressure = 'normal' | 'elevated' | 'high' | 'critical';

export type SchedulerResourceSnapshot = {
  timestamp: number;
  cpuPercent: number;
  cpuCores: number;
  memTotalBytes: number;
  memFreeBytes: number;
  vram: { totalBytes: number; usedBytes: number } | null;
  headroom: {
    cpu: number;
    cpuIdleCores: number;
    memory: number | null;
    memoryAboveFloor: number | null;
    vram: number | null;
    overall: number;
    pressure: SchedulerPressure;
    saturated: boolean;
  };
};

export type SchedulerTaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export type SchedulerTask = {
  id: string;
  sessionKey: string;
  projectPath: string | null;
  goal: string;
  priority: number;
  status: SchedulerTaskStatus;
  enqueuedAt: number;
  startedAt: number | null;
  lastProgressAt: number | null;
  progressCount: number;
  attempts: number;
  pauseCount: number;
  pauseReason: string | null;
  pauseHint: string | null;
  resumeAt: number | null;
  stopReason: string | null;
};

export type SchedulerSnapshot = {
  enabled: boolean;
  counts: { total: number; running: number; queued: number; paused: number };
  tasks: SchedulerTask[];
  resources: SchedulerResourceSnapshot | null;
};

const POLL_INTERVAL_MS = 5_000;

/** 只展示还没结束的任务；已完成的归到历史里，不占任务窗口。 */
export function isActiveSchedulerTask(task: SchedulerTask): boolean {
  return task.status === 'running' || task.status === 'queued' || task.status === 'paused';
}

/**
 * 排队位置：排在它前面的**活跃**任务数。
 * 返回 0 表示「下一个就轮到它」。
 */
export function schedulerQueuePosition(task: SchedulerTask, tasks: SchedulerTask[]): number {
  const queued = tasks
    .filter(candidate => candidate.status === 'queued')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
  const index = queued.findIndex(candidate => candidate.id === task.id);
  return index === -1 ? 0 : index;
}

export function useResourceScheduler(pollIntervalMs = POLL_INTERVAL_MS) {
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const response = await api.resourceScheduler.tasks();
      if (!mountedRef.current) return;
      if (!response?.ok) {
        setError(`HTTP ${response?.status ?? '?'}`);
        return;
      }
      const payload = await response.json();
      if (!mountedRef.current) return;
      setSnapshot({
        enabled: Boolean(payload?.enabled),
        counts: payload?.counts ?? { total: 0, running: 0, queued: 0, paused: 0 },
        tasks: Array.isArray(payload?.tasks) ? payload.tasks : [],
        resources: payload?.resources ?? null,
      });
      setError(null);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, pollIntervalMs]);

  const activeTasks = (snapshot?.tasks ?? []).filter(isActiveSchedulerTask);

  /**
   * 立即恢复一个被暂停的任务。
   *
   * 仍然要过服务端的准入闸：机器装不下就恢复不了，服务端会返回 409
   * 并说明原因。这里如实把原因带出去 —— 界面显示「恢复不了：内存不足」，
   * 比显示「已恢复」然后任务其实没动要好。
   */
  const resumeTask = useCallback(async (taskId: string): Promise<{ ok: boolean; reason?: string }> => {
    try {
      const response = await api.resourceScheduler.resumeTask(taskId);
      // 失败响应里也有服务端给的原因（409 + `{error}`），
      // 要读出来显示。只报「HTTP 409」等于把最有用的信息丢了。
      const payload = await response.json().catch(() => ({}));
      if (!response?.ok) {
        return { ok: false, reason: payload?.error ?? `HTTP ${response?.status ?? '?'}` };
      }
      await refresh();
      return payload?.ok ? { ok: true } : { ok: false, reason: payload?.error ?? 'unknown' };
    } catch (caught) {
      return { ok: false, reason: caught instanceof Error ? caught.message : String(caught) };
    }
  }, [refresh]);

  return {
    snapshot,
    error,
    activeTasks,
    runningTasks: activeTasks.filter(task => task.status === 'running'),
    queuedTasks: activeTasks.filter(task => task.status === 'queued'),
    pausedTasks: activeTasks.filter(task => task.status === 'paused'),
    refresh,
    resumeTask,
  };
}
