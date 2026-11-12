// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreSessionTurnTiming, useSessionContextUsage, useTurnTaskElapsed } from './useTurnTaskElapsed';

it('restores persisted timing loaded before mount and after a session switch', () => {
  restoreSessionTurnTiming('history-a', [{ runId: 'a', turnTiming: { startedAt: '2026-11-08T11:59:00Z', completedAt: '2026-11-08T12:00:00Z' } }]);
  const { result, rerender } = renderHook(({ id }) => useTurnTaskElapsed({ sessionId: id, subscribe }), { initialProps: { id: 'history-a' } });
  expect(result.current).toBe(60_000);
  rerender({ id: 'history-b' });
  expect(result.current).toBeNull();
  act(() => restoreSessionTurnTiming('history-a', [{ turnTiming: { startedAt: '2026-11-08T11:58:00Z', completedAt: '2026-11-08T12:00:00Z' } }]));
  expect(result.current).toBeNull();
  act(() => restoreSessionTurnTiming('history-b', [{ runId: 'b', turnTiming: { startedAt: '2026-11-08T11:59:30Z', completedAt: '2026-11-08T12:00:00Z' } }]));
  expect(result.current).toBe(30_000);
});

let handler: (message: any) => void = () => {};
const unsubscribe = vi.fn();
const subscribe = vi.fn((next: (message: any) => void) => {
  handler = next;
  return unsubscribe;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  handler = () => {};
});

function send(message: Record<string, unknown>) {
  act(() => handler({ sessionId: 's1', ...message }));
}

describe('useTurnTaskElapsed', () => {
  it('restores an active turn from a session snapshot', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-11-08T12:00:00Z');
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 's1', subscribe }));
    send({ type: 'session-status', isProcessing: true, activeRunId: 'r1', activeTurnMessages: [
      { kind: 'status', text: 'started', runId: 'r1', timestamp: '2026-11-08T11:59:00Z' },
    ] });
    expect(result.current).toBe(60_000);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(61_000);
  });
  it('restores completed timing without requiring a live start frame', () => {
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 's1', subscribe }));
    send({ kind: 'complete', runId: 'historical', turnTiming: {
      startedAt: '2026-11-08T11:59:00Z', completedAt: '2026-11-08T12:00:00Z',
    } });
    expect(result.current).toBe(60_000);
  });
  it('accepts newer persisted completion after a missed run but ignores older history', () => {
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 'history-update', subscribe }));
    act(() => restoreSessionTurnTiming('history-update', [{ runId: 'old', turnTiming: {
      startedAt: '2026-11-08T11:58:00Z', completedAt: '2026-11-08T11:59:00Z',
    } }]));
    expect(result.current).toBe(60_000);
    act(() => restoreSessionTurnTiming('history-update', [{ runId: 'new', turnTiming: {
      startedAt: '2026-11-08T12:00:00Z', completedAt: '2026-11-08T12:02:00Z',
    } }]));
    expect(result.current).toBe(120_000);
    act(() => restoreSessionTurnTiming('history-update', [{ runId: 'old', turnTiming: {
      startedAt: '2026-11-08T11:58:00Z', completedAt: '2026-11-08T11:59:00Z',
    } }]));
    expect(result.current).toBe(120_000);
    const restored = renderHook(() => useTurnTaskElapsed({ sessionId: 'history-update', subscribe }));
    expect(restored.result.current).toBe(120_000);
  });

  it('does not let delayed history replace a running turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-11-08T12:00:00Z');
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 'history-live', subscribe }));
    act(() => handler({ sessionId: 'history-live', kind: 'status', text: 'started', runId: 'live', timestamp: '2026-11-08T11:59:50Z' }));
    act(() => restoreSessionTurnTiming('history-live', [{ runId: 'old', turnTiming: {
      startedAt: '2026-11-08T11:58:00Z', completedAt: '2026-11-08T11:59:00Z',
    } }]));
    expect(result.current).toBe(10_000);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(11_000);
  });

  it('ticks from the turn start frame and freezes on completion', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-11-08T12:00:00Z');
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 's1', subscribe }));
    expect(result.current).toBeNull();
    send({ kind: 'status', text: 'started', runId: 'r1', timestamp: '2026-11-08T11:59:30Z' });
    expect(result.current).toBe(30_000);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current).toBe(35_000);
    // A stale complete from a previous run must not stop the live turn.
    send({ kind: 'complete', runId: 'r0' });
    expect(result.current).toBe(35_000);
    send({ kind: 'complete', runId: 'r1' });
    const frozen = result.current;
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current).toBe(frozen);
  });

  it('freezes on terminal errors and repeated starts do not reset the turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-11-08T12:00:00Z');
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 's1', subscribe }));
    send({ kind: 'status', text: 'started', runId: 'r1', timestamp: '2026-11-08T11:59:00Z' });
    expect(result.current).toBe(60_000);
    send({ kind: 'status', text: 'started', runId: 'r1', timestamp: '2026-11-08T11:55:00Z' });
    expect(result.current).toBe(60_000);
    send({ kind: 'error', runId: 'r1', terminal: false });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toBe(61_000);
    send({ kind: 'error', runId: 'r1', terminal: true });
    const frozen = result.current;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current).toBe(frozen);
  });

  it('a new run after completion restarts the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-11-08T12:00:00Z');
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 's1', subscribe }));
    send({ kind: 'status', text: 'started', runId: 'r1', timestamp: '2026-11-08T11:59:00Z' });
    send({ kind: 'complete', runId: 'r1' });
    send({ kind: 'status', text: 'started', runId: 'r2', timestamp: '2026-11-08T11:59:50Z' });
    expect(result.current).toBe(10_000);
  });

  it('ignores frames from other sessions and resets when the session changes', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useTurnTaskElapsed({ sessionId, subscribe }),
      { initialProps: { sessionId: 's1' as string | null } },
    );
    act(() => handler({ sessionId: 'other', kind: 'status', text: 'started', runId: 'r1', timestamp: new Date().toISOString() }));
    expect(result.current).toBeNull();
    send({ kind: 'status', text: 'started', runId: 'r1' });
    expect(result.current).toBe(0);
    rerender({ sessionId: 's2' });
    expect(result.current).toBeNull();
  });

  it('starts immediately even when the started frame carries no timestamp', () => {
    const { result } = renderHook(() => useTurnTaskElapsed({ sessionId: 's1', subscribe }));
    send({ kind: 'status', text: 'started', runId: 'r1' });
    expect(result.current).toBe(0);
    send({ kind: 'interrupted', runId: 'r1' });
    expect(result.current).toBeGreaterThanOrEqual(0);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useTurnTaskElapsed({ sessionId: 's1', subscribe }));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('useSessionContextUsage', () => {
  it('restores authoritative context from a session-status snapshot', () => {
    const { result } = renderHook(() => useSessionContextUsage({ sessionId: 's1', subscribe }));
    send({ type: 'session-status', tokenBudget: { used: 12000, total: 128000 } });
    expect(result.current).toEqual({ used: 12000, total: 128000 });
    send({ type: 'session-status', tokenBudget: { unknown: true } });
    expect(result.current).toBeNull();
  });
  it('tracks token budget frames and ignores unknown or partial payloads', () => {
    const { result } = renderHook(() => useSessionContextUsage({ sessionId: 's1', subscribe }));
    expect(result.current).toBeNull();
    send({ kind: 'status', text: 'token_budget', tokenBudget: { unknown: true } });
    expect(result.current).toBeNull();
    send({ kind: 'status', text: 'token_budget', tokenBudget: { used: 8000, total: 0 } });
    expect(result.current).toBeNull();
    send({ kind: 'status', text: 'token_budget', tokenBudget: { used: 8000, total: 200000 } });
    expect(result.current).toEqual({ used: 8000, total: 200000 });
    send({ kind: 'compact_boundary', tokenBudget: { displayUsed: 4000, total: 200000 } });
    expect(result.current).toEqual({ used: 4000, total: 200000 });
  });

  it('ignores other sessions and resets when the session changes', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSessionContextUsage({ sessionId, subscribe }),
      { initialProps: { sessionId: 's1' as string | null } },
    );
    act(() => handler({ sessionId: 'other', kind: 'status', text: 'token_budget', tokenBudget: { used: 1, total: 2 } }));
    expect(result.current).toBeNull();
    send({ kind: 'status', text: 'token_budget', tokenBudget: { used: 8000, total: 200000 } });
    expect(result.current).toEqual({ used: 8000, total: 200000 });
    rerender({ sessionId: 's2' });
    expect(result.current).toBeNull();
  });
});
