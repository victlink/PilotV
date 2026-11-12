import { useTranslation } from 'react-i18next';
import { CircleGauge, Clock } from 'lucide-react';
import { useSessionContextUsageFromSocket, useTurnTaskElapsedFromSocket } from '../chat/view/useTurnTaskElapsed';
import { formatElapsed } from './TaskMonitorPanel';

/**
 * Execution time + context occupancy (tokens used / window) for the current
 * conversation, pinned left of the header task button — the PilotDeck-style
 * header stats. Both chips stay visible, with explanatory tooltips and an
 * em dash until an authoritative turn timing / token budget is available.
 * Values reset when the conversation changes and restore from session data.
 */
export default function TaskSessionStats({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation(['sidebar', 'chat']);
  const taskElapsed = useTurnTaskElapsedFromSocket(sessionId);
  const contextUsage = useSessionContextUsageFromSocket(sessionId);
  const elapsedLabel = taskElapsed === null
    ? '—'
    : formatElapsed(Math.max(0, taskElapsed));
  const contextLabel = contextUsage === null
    ? '—'
    : `${formatTokens(contextUsage.used)}/${formatTokens(contextUsage.total)}`;
  return (
    <div className="pd-header-task-stats flex shrink-0 items-center gap-1.5">

        <span
          data-testid="current-task-elapsed"
          title={t('sidebar:tasks.elapsedRunning', { defaultValue: 'Elapsed time for this turn' }) as string}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 px-1.5 text-[11px] tabular-nums text-neutral-600 dark:border-neutral-800 dark:text-neutral-300"
        >
          <Clock className="h-3 w-3 shrink-0" strokeWidth={1.8} aria-hidden />
          {elapsedLabel}
        </span>

        <span
          data-testid="current-context-usage"
          title={contextUsage ? t('chat:input.contextStatusUsed', {
            used: contextUsage.used.toLocaleString(),
            total: contextUsage.total.toLocaleString(),
          }) as string : t('chat:input.contextStatusUnknown') as string}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 px-1.5 text-[11px] tabular-nums text-neutral-600 dark:border-neutral-800 dark:text-neutral-300"
        >
          <CircleGauge className="h-3 w-3 shrink-0" strokeWidth={1.8} aria-hidden />
          {contextLabel}
        </span>
    </div>
  );
}

/** 128000 -> 128k, 1000000 -> 1M — same shape as the composer's context gauge. */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}
