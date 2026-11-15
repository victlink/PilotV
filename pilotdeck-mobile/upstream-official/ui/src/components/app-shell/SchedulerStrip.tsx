import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Cpu, HardDrive, MemoryStick, PauseCircle, PlayCircle, Timer } from 'lucide-react';

import {
  schedulerQueuePosition,
  useResourceScheduler,
  type SchedulerPressure,
  type SchedulerResourceSnapshot,
  type SchedulerTask,
} from './useResourceScheduler';

/**
 * 调度条：任务窗口顶部的「机器现在什么状况 + 任务队列什么状况」。
 *
 * 为什么要有它
 * ------------
 * 2026-11-15 的排查里最难判断的一件事是「任务到底停在哪一步」：
 * 界面只显示「自动推进开关还亮着，但任务不动了」，用户看不到
 *   - 机器还剩多少余量（是不是内存挤到 FreeCAD 跑不动了）；
 *   - 自己的任务排在第几位（是不是在等另一个长任务让路）；
 *   - 任务是被**暂停**了还是**终止**了（两者界面上长得一模一样）。
 *
 * 这条把三件事变成一眼可见的事实：
 *   1. 资源：CPU / 内存 / 显存的占用条 + 压力分级；
 *   2. 队列：谁在跑、谁在排、排第几；
 *   3. 状态：暂停的任务带原因和自动续跑倒计时。
 *
 * 它是**只读**的（只有「立即恢复」一个动作，且仍要过服务端准入闸）：
 * 调度器是旁路增强，界面不该成为绕过机器容量限制的后门。
 */

const PRESSURE_STYLES: Record<SchedulerPressure, { chip: string; bar: string }> = {
  normal: {
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
    bar: 'bg-emerald-500',
  },
  elevated: {
    chip: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-400/30',
    bar: 'bg-sky-500',
  },
  high: {
    chip: 'bg-amber-50 text-amber-800 ring-amber-600/30 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/40',
    bar: 'bg-amber-500',
  },
  critical: {
    chip: 'bg-red-50 text-red-700 ring-red-600/30 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/40',
    bar: 'bg-red-500',
  },
};

const TASK_STATUS_STYLES: Record<string, string> = {
  running: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-400/30',
  queued: 'bg-neutral-100 text-neutral-700 ring-neutral-500/25 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-600/40',
  paused: 'bg-amber-50 text-amber-800 ring-amber-600/30 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/40',
};

/**
 * 字节数转人话。**0 是有效读数**，要显示成「0 MB」而不是破折号 ——
 * 显存刚开机时占用就是 0，显示「– / 4.0 GB」会让人以为读不到。
 * 只有 undefined / NaN / 负数才是「读不到」。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes === 0) return '0 MB';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

function ResourceBar({
  label,
  percent,
  detail,
  title,
  barClass,
  icon,
}: {
  label: string;
  percent: number;
  detail: string;
  title?: string;
  barClass: string;
  icon: React.ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="min-w-0 flex-1" data-testid={`scheduler-resource-${label}`} title={title}>
      <div className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400">
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums">{detail}</span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

function SchedulerTaskRow({
  task,
  position,
  now,
  onResume,
}: {
  task: SchedulerTask;
  position: number;
  now: number;
  onResume: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const label = task.goal?.trim() || task.sessionKey;
  const statusLabel = t(`sidebar:scheduler.taskStatus.${task.status}`);
  const countdown = task.resumeAt ? formatCountdown(task.resumeAt - now) : '';

  return (
    <li
      className="flex items-center gap-2 py-1 text-[11px]"
      data-testid={`scheduler-task-${task.status}`}
    >
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${
          TASK_STATUS_STYLES[task.status] ?? TASK_STATUS_STYLES.queued
        }`}
      >
        {task.status === 'running' ? (
          <Activity className="h-3 w-3" aria-hidden />
        ) : task.status === 'paused' ? (
          <PauseCircle className="h-3 w-3" aria-hidden />
        ) : (
          <Timer className="h-3 w-3" aria-hidden />
        )}
        {statusLabel}
      </span>
      <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300" title={label}>
        {label}
      </span>
      {task.status === 'queued' && position > 0 ? (
        <span className="shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">
          {t('sidebar:scheduler.ahead', { count: position })}
        </span>
      ) : null}
      {task.status === 'paused' ? (
        <>
          {task.pauseReason ? (
            <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">
              {t('sidebar:scheduler.pausedReason', { reason: task.pauseReason })}
            </span>
          ) : null}
          {countdown ? (
            <span className="shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">
              {t('sidebar:scheduler.resumesIn', { time: countdown })}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onResume(task.id)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-neutral-600 ring-1 ring-neutral-400/40 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:ring-neutral-500/40 dark:hover:bg-neutral-800"
          >
            <PlayCircle className="h-3 w-3" aria-hidden />
            {t('sidebar:scheduler.resumeNow')}
          </button>
        </>
      ) : null}
    </li>
  );
}

export default function SchedulerStrip() {
  const { t } = useTranslation();
  const { snapshot, error, runningTasks, queuedTasks, pausedTasks, resumeTask } = useResourceScheduler();
  const [now, setNow] = useState(() => Date.now());
  const [resumeError, setResumeError] = useState<string | null>(null);

  // 有任务在跑或在排的时候倒计时才需要走动；空闲时不必每秒重渲染。
  const hasActive = runningTasks.length > 0 || queuedTasks.length > 0 || pausedTasks.length > 0;

  useEffect(() => {
    if (!hasActive) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  const resources = snapshot?.resources ?? null;
  const pressure: SchedulerPressure = resources?.headroom?.pressure ?? 'normal';
  const pressureStyle = PRESSURE_STYLES[pressure];

  const memUsed = resources
    ? Math.max(0, resources.memTotalBytes - resources.memFreeBytes)
    : 0;
  const memUsedPercent = resources && resources.memTotalBytes > 0
    ? (memUsed / resources.memTotalBytes) * 100
    : 0;
  const vramUsedPercent = resources?.vram && resources.vram.totalBytes > 0
    ? (resources.vram.usedBytes / resources.vram.totalBytes) * 100
    : null;

  const allTasks = snapshot?.tasks ?? [];

  /** 立即恢复：失败时把服务端给的原因显示出来，不假装成功。 */
  const handleResume = async (taskId: string) => {
    setResumeError(null);
    const result = await resumeTask(taskId);
    if (!result.ok) {
      setResumeError(t('sidebar:scheduler.resumeFailed', { reason: result.reason ?? 'unknown' }));
    }
  };

  return (
    <div
      role="group"
      aria-label={t('sidebar:scheduler.title')}
      data-testid="scheduler-strip"
      className="mb-2 shrink-0 border-b border-neutral-200/70 pb-2 dark:border-neutral-800"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold text-neutral-800 dark:text-neutral-100">
          {t('sidebar:scheduler.title')}
        </h3>
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${pressureStyle.chip}`}
          data-testid="scheduler-pressure"
        >
          {t(`sidebar:scheduler.pressure.${pressure}`)}
        </span>
        {snapshot ? (
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
            {t('sidebar:scheduler.queueSummary', {
              running: snapshot.counts.running,
              queued: snapshot.counts.queued,
              paused: snapshot.counts.paused,
            })}
          </span>
        ) : null}
        {error ? (
          <span className="ml-auto text-[10px] text-amber-700 dark:text-amber-300" title={error}>
            {t('sidebar:scheduler.stale')}
          </span>
        ) : null}
      </div>

      {resources ? (
        <div className="mt-2 flex gap-3">
          <ResourceBar
            label={t('sidebar:scheduler.cpu')}
            percent={resources.cpuPercent}
            detail={`${Math.round(resources.cpuPercent)}%`}
            barClass={pressureStyle.bar}
            icon={<Cpu className="h-3 w-3" aria-hidden />}
          />
          <ResourceBar
            label={t('sidebar:scheduler.memory')}
            percent={memUsedPercent}
            detail={`${formatBytes(memUsed)} / ${formatBytes(resources.memTotalBytes)}`}
            title={t('sidebar:scheduler.memoryFree', { free: formatBytes(resources.memFreeBytes) })}
            barClass={pressureStyle.bar}
            icon={<MemoryStick className="h-3 w-3" aria-hidden />}
          />
          {vramUsedPercent !== null ? (
            <ResourceBar
              label={t('sidebar:scheduler.vram')}
              percent={vramUsedPercent}
              detail={`${formatBytes(resources.vram?.usedBytes)} / ${formatBytes(resources.vram?.totalBytes)}`}
              barClass={pressureStyle.bar}
              icon={<HardDrive className="h-3 w-3" aria-hidden />}
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-[10px] text-neutral-400">
                <HardDrive className="h-3 w-3" aria-hidden />
                <span>{t('sidebar:scheduler.vram')}</span>
                <span className="ml-auto">{t('sidebar:scheduler.vramUnavailable')}</span>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {hasActive ? (
        <ul className="mt-2 divide-y divide-neutral-200/70 border-t border-neutral-200/70 dark:divide-neutral-800 dark:border-neutral-800">
          {runningTasks.map(task => (
            <SchedulerTaskRow key={task.id} task={task} position={0} now={now} onResume={handleResume} />
          ))}
          {queuedTasks.map(task => (
            <SchedulerTaskRow
              key={task.id}
              task={task}
              position={schedulerQueuePosition(task, allTasks)}
              now={now}
              onResume={handleResume}
            />
          ))}
          {pausedTasks.map(task => (
            <SchedulerTaskRow key={task.id} task={task} position={0} now={now} onResume={handleResume} />
          ))}
        </ul>
      ) : null}

      {resumeError ? (
        <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300" data-testid="scheduler-resume-error">
          {resumeError}
        </p>
      ) : null}
    </div>
  );
}
