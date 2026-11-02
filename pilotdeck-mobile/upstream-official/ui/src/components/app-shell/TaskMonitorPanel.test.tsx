// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession } from '../../types/app';
import TaskMonitorPanel, { collectTaskEntries, formatElapsed } from './TaskMonitorPanel';
import type { PendingConfirmationsBySession } from './usePendingConfirmations';

let handler: (message: any) => void = () => {};
vi.mock('../../contexts/WebSocketContext', () => ({
  useOptionalWebSocket: () => ({ subscribe: (next: (message: any) => void) => { handler = next; return () => {}; } }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const HOUR_BEFORE = new Date(NOW - 60 * 60 * 1000).toISOString();
const TWO_DAYS_AGO = new Date(NOW - 2 * DAY_MS).toISOString();
const DAY_START = '2026-10-16T09:00:00.000Z';

function makeSession(id: string, overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id,
    title: `session ${id}`,
    createdAt: DAY_START,
    lastActivity: HOUR_BEFORE,
    ...overrides,
  };
}

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
  sessions: [],
};

function renderPanel(props: Partial<React.ComponentProps<typeof TaskMonitorPanel>> = {}) {
  const onOpenSession = vi.fn();
  const onClose = vi.fn();
  render(
    <TaskMonitorPanel
      projects={[{ ...project, sessions: [makeSession('a')] }]}
      onOpenSession={onOpenSession}
      onClose={onClose}
      {...props}
    />,
  );
  return { onOpenSession, onClose };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  handler = () => {};
});

describe('collectTaskEntries', () => {
  it('keeps running tasks and tasks finished within the last day', () => {
    const entries = collectTaskEntries(
      [
        {
          ...project,
          sessions: [
            makeSession('running', { taskStatus: 'running' }),
            makeSession('fresh-done', { taskStatus: 'completed' }),
            makeSession('old-done', { taskStatus: 'completed', lastActivity: TWO_DAYS_AGO }),
            makeSession('fresh-failed', { taskStatus: 'failed' }),
            makeSession('never-ran'),
          ],
        },
      ],
      new Set<string>(),
      new Set<string>(),
      {},
      NOW,
    );

    expect(entries.map(entry => entry.session.id)).toEqual([
      'running',
      'fresh-done',
      'fresh-failed',
    ]);
  });

  it('pins tasks waiting for the user above everything else', () => {
    const entries = collectTaskEntries(
      [
        {
          ...project,
          sessions: [
            makeSession('quiet-done', { taskStatus: 'completed' }),
            makeSession('waiting', { taskStatus: 'running' }),
            makeSession('busy', { taskStatus: 'running' }),
          ],
        },
      ],
      new Set<string>(),
      new Set<string>(),
      {
        waiting: [{ requestId: 'r1', toolName: 'Bash', receivedAt: NOW }],
        quiet: [{ requestId: 'r2', toolName: 'Bash', receivedAt: NOW }],
      },
      NOW,
    );

    expect(entries[0].session.id).toBe('waiting');
    expect(entries[0].needsAttention).toBe(true);
    expect(entries[0].confirmationCount).toBe(1);
  });

  it('shows a stale task that still waits for a decision', () => {
    const entries = collectTaskEntries(
      [{ ...project, sessions: [makeSession('stale-waiting', { lastActivity: TWO_DAYS_AGO })] }],
      new Set<string>(),
      new Set<string>(),
      { 'stale-waiting': [{ requestId: 'r1', toolName: 'Edit', receivedAt: NOW }] },
      NOW,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].needsAttention).toBe(true);
  });

  it('caps the list at nine entries', () => {
    const sessions = Array.from({ length: 12 }, (_, index) =>
      makeSession(`s${index}`, { taskStatus: 'running' }),
    );
    expect(collectTaskEntries([{ ...project, sessions }], undefined, undefined, {}, NOW)).toHaveLength(9);
  });
});

describe('formatElapsed', () => {
  it('renders seconds, minutes and hours', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(90_000)).toBe('1m 30s');
    expect(formatElapsed(3 * 60 * 60 * 1000)).toBe('3h 0m');
  });
});

describe('TaskMonitorPanel', () => {
  it('labels only context occupancy with a percentage and otherwise shows indeterminate activity', () => {
    renderPanel({ projects: [{ ...project, sessions: [makeSession('a', { taskStatus: 'running', title: 'active task' })] }] });
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('sidebar:tasks.activity');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    act(() => handler({ kind: 'status', sessionId: 'a', text: 'token_budget', tokenBudget: { used: 80, total: 200, effectiveTotal: 100, ratio: 0.8 } }));
    expect(screen.getByText('sidebar:tasks.contextOccupancy')).toBeTruthy();
    expect(bar.getAttribute('aria-label')).toBe('sidebar:tasks.contextOccupancy');
    expect(bar.getAttribute('aria-valuenow')).toBe('80');
    expect(bar.firstElementChild?.getAttribute('style')).toBe('width: 80%;');
  });

  it('does not turn used/total without a ratio into a percentage', () => {
    renderPanel({ projects: [{ ...project, sessions: [makeSession('a', { taskStatus: 'running' })] }] });
    act(() => handler({ kind: 'status', sessionId: 'a', text: 'token_budget', tokenBudget: { used: 80, total: 200 } }));
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
    expect(screen.queryByText('sidebar:tasks.contextOccupancy')).toBeNull();
  });

  it('shows recent finished age rather than work duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderPanel({ projects: [{ ...project, sessions: [makeSession('a', { taskStatus: 'completed' })] }] });
    expect(screen.getByText('sidebar:tasks.finishedAgo')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  });

  it('shows confirmed phase, distinct tools and elapsed only from the real turn start', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderPanel({ projects: [{ ...project, sessions: [makeSession('a', { taskStatus: 'running' })] }] });
    expect(screen.queryByText('3h 0m')).toBeNull();
    act(() => {
      handler({ kind: 'status', sessionId: 'a', runId: 'r1', text: 'started', timestamp: new Date(NOW - 90_000).toISOString() });
      handler({ kind: 'tool_result', sessionId: 'a', runId: 'r1', toolId: 't1' });
      handler({ kind: 'tool_result', sessionId: 'a', runId: 'r1', toolId: 't1' });
    });
    expect(screen.getByText('sidebar:tasks.phase.working')).toBeTruthy();
    expect(screen.getByText('sidebar:tasks.toolsCompleted')).toBeTruthy();
    expect(screen.getByText('1m 30s')).toBeTruthy();
    act(() => handler({ kind: 'status', sessionId: 'a', runId: 'r1', text: 'compacting' }));
    expect(screen.getByText('sidebar:tasks.phase.compacting')).toBeTruthy();
  });

  it('shows the empty state when nothing is running or recently finished', () => {
    renderPanel({ projects: [{ ...project, sessions: [makeSession('stale', { lastActivity: TWO_DAYS_AGO })] }] });
    expect(screen.getByTestId('task-monitor-panel')).toBeTruthy();
    expect(screen.getByText('sidebar:tasks.empty')).toBeTruthy();
  });

  it('collapses to two rows and expands the rest on demand', () => {
    const sessions = Array.from({ length: 8 }, (_, index) =>
      makeSession(`s${index}`, { taskStatus: 'running', title: `task ${index}` }),
    );
    renderPanel({ projects: [{ ...project, sessions }] });

    // Six cards = two rows of three; the remaining two stay folded away.
    expect(screen.getAllByRole('progressbar')).toHaveLength(6);
    expect(screen.queryByText('task 6')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'sidebar:tasks.expand' }));
    expect(screen.getAllByRole('progressbar')).toHaveLength(8);
    expect(screen.getByText('task 6')).toBeTruthy();
  });

  it('marks a task needing confirmation, pins it first and flashes it', () => {
    const pendingConfirmations: PendingConfirmationsBySession = {
      waiting: [{ requestId: 'r1', toolName: 'Bash', receivedAt: Date.now() }],
    };
    renderPanel({
      projects: [
        {
          ...project,
          sessions: [
            makeSession('quiet', { taskStatus: 'completed', title: 'quiet task' }),
            makeSession('waiting', { title: 'waiting task' }),
          ],
        },
      ],
      pendingConfirmations,
    });

    const card = screen.getByText('waiting task').closest('button');
    expect(card?.dataset.status).toBe('attention');
    expect(card?.className).toContain('animate-pulse');
    // Attention tasks force the panel open, so nothing is hidden behind a click.
    expect(screen.getByText('sidebar:tasks.needsYou')).toBeTruthy();
  });

  it('opens the session when a task card is clicked', () => {
    const { onOpenSession } = renderPanel({
      projects: [{ ...project, sessions: [makeSession('busy', { taskStatus: 'running', title: 'busy task' })] }],
    });
    fireEvent.click(screen.getByText('busy task'));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession.mock.calls[0][0].session.id).toBe('busy');
  });
});

