import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Clock, Loader2, ShieldAlert } from 'lucide-react';
import type { Project, ProjectSession } from '../../types/app';
import type { PendingConfirmationsBySession } from './usePendingConfirmations';
import { useTaskProgress, type TaskProgressBySession } from './useTaskProgress';

/**
 * Task monitor.
 *
 * Lists the work that is still in flight plus what finished in the last day,
 * and pins anything waiting for the user to confirm or authorize. Cards are
 * summaries rather than live chat panes: mounting several chat interfaces would
 * duplicate subscriptions, composer state and read acknowledgements.
 */

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'started', 'pending', 'queued']);
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled']);
const DONE_STATUSES = new Set(['completed', 'complete', 'done', 'success', 'succeeded']);

export const TASK_MONITOR_LIMIT = 9;
/** Two rows of three cards are shown until the user expands the panel. */
export const TASK_MONITOR_COLLAPSED_ROWS = 2;
const COLUMNS = 3;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type TaskMonitorEntry = {
  project: Project;
  session: ProjectSession;
  lastActivityAt: number;
  running: boolean;
  failed: boolean;
  done: boolean;
  needsAttention: boolean;
  confirmationCount: number;
};

function parseTime(raw: unknown): number {
  if (typeof raw !== 'string' || !raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function lastActivityOf(session: ProjectSession): number {
  return parseTime(session.lastActivity ?? session.updated_at) || parseTime(session.createdAt ?? session.created_at);
}

export function collectTaskEntries(
  projects: Project[],
  processingSessions?: Set<string>,
  unreadSessionIds?: Set<string>,
  pendingConfirmations: PendingConfirmationsBySession = {},
   now: number = Date.now(),
   progressBySession: TaskProgressBySession = {},
): TaskMonitorEntry[] {
  const entries = projects.flatMap(project =>
    (project.sessions ?? []).map(session => {
      const lastActivityAt = lastActivityOf(session);
      const status = typeof session.taskStatus === 'string' ? session.taskStatus.toLowerCase() : '';
      const confirmations = pendingConfirmations[session.id] ?? [];
      const needsAttention = confirmations.length > 0;
      // A prompt implies the turn is alive even if the status has not caught up.
      const running =
        needsAttention || RUNNING_STATUSES.has(status) || processingSessions?.has(session.id) === true ||
        (progressBySession[session.id]?.phase !== undefined &&
          !['finished', 'idle'].includes(progressBySession[session.id].phase));
      const failed = !running && FAILED_STATUSES.has(status);
      const done =
        !running &&
        !failed &&
        (DONE_STATUSES.has(status) || unreadSessionIds?.has(session.id) === true);

      return {
        project,
        session,
        lastActivityAt,
        running,
        failed,
        done,
        needsAttention,
        confirmationCount: confirmations.length,
      } satisfies TaskMonitorEntry;
    }),
  );

  const withinRecentWindow = (entry: TaskMonitorEntry) =>
    entry.lastActivityAt === 0 || now - entry.lastActivityAt <= RECENT_WINDOW_MS;

  return entries
    // Anything needing a decision is shown even if it looks stale; everything
    // else has to be running or finished within the last day.
    .filter(entry => entry.needsAttention || entry.running || ((entry.failed || entry.done) && withinRecentWindow(entry)))
    .sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.lastActivityAt - a.lastActivityAt;
    })
    .slice(0, TASK_MONITOR_LIMIT);
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

type StatusKind = 'attention' | 'running' | 'failed' | 'done';

const STATUS_STYLES: Record<StatusKind, { chip: string; bar: string; labelKey: string }> = {
  attention: {
    chip: 'bg-amber-100 text-amber-900 ring-amber-500/40 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/40',
    bar: 'bg-amber-500',
    labelKey: 'tasks.statusAttention',
  },
  running: {
    chip: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-400/30',
    bar: 'bg-blue-500',
    labelKey: 'tasks.statusRunning',
  },
  failed: {
    chip: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/30',
    bar: 'bg-red-500',
    labelKey: 'tasks.statusFailed',
  },
  done: {
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
    bar: 'bg-emerald-500',
    labelKey: 'tasks.statusDone',
  },
};

function statusKind(entry: TaskMonitorEntry): StatusKind {
  if (entry.needsAttention) return 'attention';
  if (entry.running) return 'running';
  if (entry.failed) return 'failed';
  return 'done';
}

function StatusIcon({ kind }: { kind: StatusKind }) {
  if (kind === 'attention') return <ShieldAlert className="h-3 w-3" aria-hidden />;
  if (kind === 'running') return <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />;
  if (kind === 'failed') return <AlertTriangle className="h-3 w-3" aria-hidden />;
  return <CheckCircle2 className="h-3 w-3" aria-hidden />;
}

export default function TaskMonitorPanel({
  projects,
  processingSessions,
  unreadSessionIds,
  pendingConfirmations,
  selectedSessionId,
  onOpenSession,
  onClose,
}: {
  projects: Project[];
  processingSessions?: Set<string>;
  unreadSessionIds?: Set<string>;
  pendingConfirmations?: PendingConfirmationsBySession;
  selectedSessionId?: string;
  onOpenSession: (entry: TaskMonitorEntry) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const progressBySession = useTaskProgress();
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(
    () => collectTaskEntries(projects, processingSessions, unreadSessionIds, pendingConfirmations, now, progressBySession),
    [projects, processingSessions, unreadSessionIds, pendingConfirmations, now, progressBySession],
  );
  const runningCount = entries.filter(entry => entry.running).length;
  const attentionCount = entries.filter(entry => entry.needsAttention).length;
  const collapsedLimit = TASK_MONITOR_COLLAPSED_ROWS * COLUMNS;
  const hasRunning = entries.some(entry => entry.running);

  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  // A new prompt should always be visible without extra clicks.
  useEffect(() => {
    if (attentionCount > 0) setExpanded(true);
  }, [attentionCount]);

  const visible = expanded ? entries : entries.slice(0, collapsedLimit);
  const hiddenCount = entries.length - visible.length;

  return (
    <section
      aria-label={t('sidebar:tasks.title')}
      data-testid="task-monitor-panel"
      className="shrink-0 border-b border-neutral-200 bg-neutral-50/80 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/50"
    >
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">
          {t('sidebar:tasks.title')}
        </h2>
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {t('sidebar:tasks.summary', {
            running: runningCount,
            attention: attentionCount,
            total: entries.length,
          })}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('sidebar:tasks.close')}
          className="ml-auto rounded-md px-2 py-1 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {t('sidebar:tasks.close')}
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t('sidebar:tasks.empty')}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map(entry => {
              const kind = statusKind(entry);
               const style = STATUS_STYLES[kind];
               const progress = progressBySession[entry.session.id];
               const phase = entry.needsAttention ? 'waiting' : entry.running ? progress?.phase ?? 'idle' : 'finished';
               const percentage = progress?.contextRatio === undefined ? undefined : Math.round(progress.contextRatio * 100);
               const title =
                entry.session.title ?? entry.session.name ?? t('sidebar:tasks.untitled');
              const selected = selectedSessionId === entry.session.id;
              return (
                <button
                  key={`${entry.project.name}:${entry.session.id}`}
                  type="button"
                  onClick={() => onOpenSession(entry)}
                  aria-current={selected ? 'true' : undefined}
                  data-status={kind}
                  className={`flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:border-neutral-400 dark:hover:border-neutral-500 ${
                    selected
                      ? 'border-indigo-400 bg-white ring-1 ring-indigo-500/30 dark:bg-neutral-900'
                      : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950'
                  } ${
                    kind === 'attention'
                      ? 'animate-pulse border-amber-400 ring-2 ring-amber-400/50 motion-reduce:animate-none'
                      : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                      {title}
                    </span>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${style.chip}`}
                    >
                      <StatusIcon kind={kind} />
                       {kind === 'running' || kind === 'attention'
                         ? t(`sidebar:tasks.phase.${phase}`)
                         : t(`sidebar:${style.labelKey}`)}
                    </span>
                  </div>

                  {entry.session.summary ? (
                    <p className="line-clamp-2 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {entry.session.summary}
                    </p>
                  ) : null}

                  {kind === 'attention' ? (
                    <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      {t('sidebar:tasks.needsYou', { count: entry.confirmationCount })}
                    </p>
                  ) : null}

                   {percentage !== undefined && (
                     <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
                       {t('sidebar:tasks.contextOccupancy', { percent: percentage })}
                     </span>
                   )}
                   <div
                     className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
                     role="progressbar"
                     aria-label={percentage === undefined ? t('sidebar:tasks.activity') : t('sidebar:tasks.contextOccupancy', { percent: percentage })}
                     aria-valuenow={percentage}
                     aria-valuemin={0}
                     aria-valuemax={100}
                   >
                     {percentage === undefined ? (
                       <div className={`h-full w-1/3 animate-pulse rounded-full ${style.bar} motion-reduce:animate-none`} />
                     ) : (
                       <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${percentage}%` }} />
                     )}
                   </div>

                  <div className="flex items-center gap-1.5 text-[10px] text-neutral-500 dark:text-neutral-400">
                    <span className="min-w-0 flex-1 truncate">{entry.project.displayName}</span>
                     {(kind === 'running' || kind === 'attention') && progress?.toolsCompleted ? (
                       <span className="shrink-0">{t('sidebar:tasks.toolsCompleted', { count: progress.toolsCompleted })}</span>
                     ) : null}
                     {(kind === 'running' || kind === 'attention') && progress?.turnStartedAt !== undefined ? (
                       <span className="inline-flex shrink-0 items-center gap-1">
                         <Clock className="h-3 w-3" aria-hidden />
                         {formatElapsed(Math.max(0, now - progress.turnStartedAt))}
                       </span>
                     ) : kind !== 'running' && kind !== 'attention' && entry.lastActivityAt > 0 ? (
                      <span className="shrink-0">
                        {t('sidebar:tasks.finishedAgo', { time: formatElapsed(Math.max(0, now - entry.lastActivityAt)) })}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>

          {(hiddenCount > 0 || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded(value => !value)}
              aria-expanded={expanded}
              className="mt-2 w-full rounded-md border border-neutral-200 py-1.5 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              {expanded
                ? t('sidebar:tasks.collapse')
                : t('sidebar:tasks.expand', { count: hiddenCount })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
