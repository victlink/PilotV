// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession } from '../../types/app';
import SessionMultiPreview, { collectPreviewEntries, formatElapsed } from './SessionMultiPreview';

function makeSession(id: string, overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id,
    title: `session ${id}`,
    createdAt: '2026-10-15T10:00:00.000Z',
    lastActivity: '2026-10-15T10:05:00.000Z',
    ...overrides,
  };
}

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
  sessions: [],
};

function renderPreview(props: Partial<React.ComponentProps<typeof SessionMultiPreview>> = {}) {
  const onOpenSession = vi.fn();
  const onClose = vi.fn();
  render(
    <SessionMultiPreview
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
});

describe('collectPreviewEntries', () => {
  it('keeps running sessions first and orders each group by last activity', () => {
    const entries = collectPreviewEntries(
      [
        {
          ...project,
          sessions: [
            makeSession('idle-old', { lastActivity: '2026-10-15T09:00:00.000Z' }),
            makeSession('done-new', {
              taskStatus: 'completed',
              lastActivity: '2026-10-15T11:00:00.000Z',
            }),
            makeSession('running-old', {
              taskStatus: 'running',
              lastActivity: '2026-10-15T09:30:00.000Z',
            }),
            makeSession('running-new', {
              taskStatus: 'running',
              lastActivity: '2026-10-15T11:30:00.000Z',
            }),
          ],
        },
      ],
      new Set<string>(),
      new Set<string>(),
    );

    expect(entries.map(entry => entry.session.id)).toEqual([
      'running-new',
      'running-old',
      'done-new',
    ]);
  });

  it('shows at most nine windows so one screen never overflows', () => {
    const sessions = Array.from({ length: 14 }, (_, index) =>
      makeSession(`s${index}`, { taskStatus: 'running' }),
    );
    const entries = collectPreviewEntries([{ ...project, sessions }], undefined, undefined);
    expect(entries).toHaveLength(9);
  });

  it('treats unread recent sessions as finished windows even without a task status', () => {
    const entries = collectPreviewEntries(
      [{ ...project, sessions: [makeSession('quiet')] }],
      new Set<string>(),
      new Set(['quiet']),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].done).toBe(true);
  });

  it('drops sessions that are neither running, failed nor freshly done', () => {
    const entries = collectPreviewEntries(
      [{ ...project, sessions: [makeSession('stale')] }],
      new Set<string>(),
      new Set<string>(),
    );
    expect(entries).toHaveLength(0);
  });
});

describe('formatElapsed', () => {
  it('renders minutes and hours', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(90_000)).toBe('1m 30s');
    expect(formatElapsed(3_600_000)).toBe('1h 0m');
  });
});

describe('SessionMultiPreview', () => {
  it('shows an empty state when nothing is in flight or recently finished', () => {
    renderPreview();
    expect(screen.getByTestId('session-multi-preview')).toBeTruthy();
    // No i18n instance is wired in this suite, so t() echoes the key back.
    expect(screen.getByText('sidebar:multiPreview.empty')).toBeTruthy();
  });

  it('renders a card per window and opens the session on click', () => {
    const sessions = [
      makeSession('busy', { taskStatus: 'running', title: 'long running job' }),
      makeSession('fresh', { taskStatus: 'completed', title: 'just finished job' }),
    ];
    const { onOpenSession } = renderPreview({
      projects: [{ ...project, sessions }],
      processingSessions: new Set<string>(),
      unreadSessionIds: new Set<string>(),
      selectedSessionId: 'fresh',
    });

    expect(screen.getByText('long running job')).toBeTruthy();
    expect(screen.getByText('just finished job')).toBeTruthy();
    // The selected window is marked for the user, running one leads the order.
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);

    fireEvent.click(screen.getByText('long running job'));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession.mock.calls[0][0].session.id).toBe('busy');
  });

  it('closes the panel from the header button', () => {
    const { onClose } = renderPreview();
    fireEvent.click(screen.getByRole('button', { name: 'sidebar:multiPreview.close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
