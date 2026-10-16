import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import type { Project, ProjectSession } from '../../types/app';

/**
 * Multi-screen session monitor.
 *
 * Shows the sessions that currently have work in flight plus the ones that
 * just finished, ordered by last activity, so a user can watch several
 * conversations at once and jump straight into the one that needs attention.
 * Cards are deliberately summaries rather than live chat panes: mounting nine
 * chat interfaces would duplicate subscriptions, composer state and read
 * acknowledgements.
 */

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'started', 'pending', 'queued']);
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled']);
const DONE_STATUSES = new Set(['completed', 'complete', 'done', 'success', 'succeeded']);

export const MULTI_PREVIEW_LIMIT = 9;

export type MultiPreviewEntry = {
  project: Project;
  session: ProjectSession;
  lastActivityAt: number;
  running: boolean;
  failed: boolean;
  done: boolean;
  elapsedMs: number;
  durationMs: number | null;
};

function toTimestamp(session: ProjectSession): number {
  const raw = session.lastActivity ?? session.updated_at ?? session.createdAt ?? session.created_at;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toCreatedTimestamp(session: ProjectSession): number {
  const raw = session.createdAt ?? session.created_at;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function collectPreviewEntries(
  projects: Project[],
  processingSessions?: Set<string>,
  unreadSessionIds?: Set<string>,
): MultiPreviewEntry[] {
  const runningStartedAt = Date.now();

  const entries = projects.flatMap(project =>
    (project.sessions ?? []).map(session => {
      const lastActivityAt = toTimestamp(session);
      const createdAt = toCreatedTimestamp(session);
      const status = typeof session.taskStatus === 'string' ? session.taskStatus.toLowerCase() : '';
      const running = RUNNING_STATUSES.has(status) || processingSessions?.has(session.id) === true;
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
        // A running session started no later than its last activity, so this
        // is the conservative lower bound of the real elapsed time.
        elapsedMs: running
          ? Math.max(0, runningStartedAt - (lastActivityAt || createdAt || runningStartedAt))
          : 0,
        durationMs:
          !running && createdAt > 0 && lastActivityAt > 0 && lastActivityAt >= createdAt
            ? lastActivityAt - createdAt
            : null,
      } satisfies MultiPreviewEntry;
    }),
  );

  return entries
    .filter(entry => entry.running || entry.failed || entry.done)
    .sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.lastActivityAt - a.lastActivityAt;
    })
    .slice(0, MULTI_PREVIEW_LIMIT);
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

type StatusKind = 'running' | 'failed' | 'done';

const STATUS_STYLES: Record<StatusKind, { chip: string; bar: string; labelKey: string }> = {
  running: {
    chip: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-400/30',
    bar: 'bg-blue-500',
    labelKey: 'multiPreview.statusRunning',
  },
  failed: {
    chip: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/30',
    bar: 'bg-red-500',
    labelKey: 'multiPreview.statusFailed',
  },
  done: {
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
    bar: 'bg-emerald-500',
    labelKey: 'multiPreview.statusDone',
  },
};

function statusKind(entry: MultiPreviewEntry): StatusKind {
  if (entry.running) return 'running';
  if (entry.failed) return 'failed';
  return 'done';
}

function StatusIcon({ kind }: { kind: StatusKind }) {
  if (kind === 'running') return <Loader2 className="h-3 w-3 animate-spin" aria-hidden />;
  if (kind === 'failed') return <AlertTriangle className="h-3 w-3" aria-hidden />;
  return <CheckCircle2 className="h-3 w-3" aria-hidden />;
}

export default function SessionMultiPreview({
  projects,
  processingSessions,
  unreadSessionIds,
  selectedSessionId,
  onOpenSession,
  onClose,
}: {
  projects: Project[];
  processingSessions?: Set<string>;
  unreadSessionIds?: Set<string>;
  selectedSessionId?: string;
  onOpenSession: (entry: MultiPreviewEntry) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Re-render once a minute so the running timers advance without a per-card
  // interval, and only while the panel is mounted with something to show.
  const [now, setNow] = useState(() => Date.now());
  const entries = useMemo(
    () => collectPreviewEntries(projects, processingSessions, unreadSessionIds),
    [projects, processingSessions, unreadSessionIds],
  );
  const hasRunning = entries.some(entry => entry.running);

  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const runningCount = entries.filter(entry => entry.running).length;

  return (
    <section
      aria-label={t('sidebar:multiPreview.title')}
      data-testid="session-multi-preview"
      className="shrink-0 border-b border-neutral-200 bg-neutral-50/80 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/50"
    >
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">
          {t('sidebar:multiPreview.title')}
        </h2>
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {t('sidebar:multiPreview.summary', { running: runningCount, total: entries.length })}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('sidebar:multiPreview.close')}
          className="ml-auto rounded-md px-2 py-1 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {t('sidebar:multiPreview.close')}
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t('sidebar:multiPreview.empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map(entry => {
            const kind = statusKind(entry);
            const style = STATUS_STYLES[kind];
            const title =
              entry.session.title ?? entry.session.name ?? t('sidebar:multiPreview.untitled');
            const selected = selectedSessionId === entry.session.id;
            return (
              <button
                key={`${entry.project.name}:${entry.session.id}`}
                type="button"
                onClick={() => onOpenSession(entry)}
                aria-current={selected ? 'true' : undefined}
                className={`flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:border-neutral-400 dark:hover:border-neutral-500 ${
                  selected
                    ? 'border-indigo-400 bg-white ring-1 ring-indigo-500/30 dark:bg-neutral-900'
                    : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950'
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
                    {t(`sidebar:${style.labelKey}`)}
                  </span>
                </div>

                {entry.session.summary ? (
                  <p className="line-clamp-2 text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-400">
                    {entry.session.summary}
                  </p>
                ) : null}

                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
                  role="progressbar"
                  aria-label={t(`sidebar:${style.labelKey}`)}
                  aria-valuenow={kind === 'done' ? 100 : undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  {kind === 'running' ? (
                    // Indeterminate: the gateway exposes no completion counter,
                    // so the bar signals activity without inventing a percent.
                    <div className={`h-full w-1/3 animate-pulse rounded-full ${style.bar}`} />
                  ) : (
                    <div className={`h-full w-full rounded-full ${style.bar}`} />
                  )}
                </div>

                <div className="flex items-center gap-1.5 text-[10px] text-neutral-500 dark:text-neutral-400">
                  <span className="min-w-0 flex-1 truncate">{entry.project.displayName}</span>
                  {kind === 'running' ? (
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden />
                      {t('sidebar:multiPreview.elapsed', {
                        time: formatElapsed(
                          Math.max(0, now - (entry.lastActivityAt || entry.elapsedMs)),
                        ),
                      })}
                    </span>
                  ) : entry.durationMs !== null ? (
                    <span className="shrink-0">{formatElapsed(entry.durationMs)}</span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
