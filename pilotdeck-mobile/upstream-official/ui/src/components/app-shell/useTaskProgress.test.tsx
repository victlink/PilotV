// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskProgress } from './useTaskProgress';

let handler: (message: any) => void = () => {};
const unsubscribe = vi.fn();
const subscribe = vi.fn((next: (message: any) => void) => {
  handler = next;
  return unsubscribe;
});
vi.mock('../../contexts/WebSocketContext', () => ({ useOptionalWebSocket: () => ({ subscribe }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  handler = () => {};
  vi.useRealTimers();
});

function send(message: Record<string, unknown>) {
  act(() => handler({ sessionId: 's1', ...message }));
}

describe('useTaskProgress', () => {
  it('tracks real start timestamps, phase transitions and repeated start replay without resetting the turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-16T12:00:00Z');
    const { result, unmount } = renderHook(() => useTaskProgress());
    expect(result.current).toEqual({});
    send({ kind: 'status', text: 'started', runId: 'r1', timestamp: '2026-10-16T11:59:00Z' });
    expect(result.current.s1).toMatchObject({ phase: 'starting', turnStartedAt: Date.parse('2026-10-16T11:59:00Z') });
    send({ kind: 'status', text: 'model_request_started', runId: 'r1' });
    expect(result.current.s1.phase).toBe('working');
    send({ kind: 'status', text: 'started', runId: 'r1', timestamp: '2026-10-16T12:05:00Z' });
    expect(result.current.s1).toMatchObject({ phase: 'working', turnStartedAt: Date.parse('2026-10-16T11:59:00Z') });
    send({ kind: 'status', text: 'compacting', runId: 'r1', compactProgress: { state: 'running' } });
    expect(result.current.s1.phase).toBe('compacting');
    send({ kind: 'compact_boundary', runId: 'r1' });
    expect(result.current.s1.phase).toBe('working');
    send({ kind: 'status', text: 'Reconnecting...', runId: 'r1', retryProgress: { attempt: 1 } });
    expect(result.current.s1.phase).toBe('retrying');
    send({ kind: 'permission_request', runId: 'r1', requestId: 'p1' });
    send({ kind: 'permission_request', runId: 'r1', requestId: 'p2' });
    send({ kind: 'stream_delta', runId: 'r1', content: 'still active' });
    expect(result.current.s1.phase).toBe('waiting');
    send({ kind: 'permission_cancelled', runId: 'r1', requestId: 'p1' });
    expect(result.current.s1.phase).toBe('waiting');
    send({ kind: 'permission_cancelled', runId: 'r1', requestId: 'p2' });
    expect(result.current.s1.phase).toBe('working');
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('deduplicates distinct tool results and resets on completion and a new turn', () => {
    const { result } = renderHook(() => useTaskProgress());
    send({ kind: 'status', text: 'started', runId: 'r1' });
    send({ kind: 'tool_result', runId: 'r1', toolId: 't1' });
    send({ kind: 'tool_result', runId: 'r1', toolId: 't1', resultPath: '/tmp/detail' });
    send({ kind: 'tool_result', runId: 'r1', toolId: 't2' });
    send({ kind: 'tool_result', runId: 'r1' });
    expect(result.current.s1.toolsCompleted).toBe(2);
    send({ kind: 'complete', runId: 'r1', success: true });
    expect(result.current.s1).toMatchObject({ phase: 'finished', toolsCompleted: 0 });
    send({ kind: 'tool_result', runId: 'r1', toolId: 't3' });
    send({ kind: 'status', text: 'model_request_started', runId: 'r1' });
    expect(result.current.s1).toMatchObject({ phase: 'finished', toolsCompleted: 0 });
    send({ kind: 'status', text: 'started', runId: 'r2' });
    send({ kind: 'tool_result', runId: 'r1', toolId: 'old' });
    send({ kind: 'tool_result', runId: 'r2', toolId: 't1' });
    expect(result.current.s1).toMatchObject({ phase: 'working', toolsCompleted: 1 });
    send({ kind: 'error', runId: 'r2', terminal: false });
    expect(result.current.s1.phase).toBe('working');
    send({ kind: 'error', runId: 'r2', terminal: true });
    expect(result.current.s1).toMatchObject({ phase: 'finished', toolsCompleted: 0 });
  });

  it('uses the budget ratio instead of full-window used/total and rejects unknown budgets', () => {
    const { result } = renderHook(() => useTaskProgress());
    send({ kind: 'status', text: 'token_budget', tokenBudget: { used: 80, total: 200, effectiveTotal: 100, ratio: 0.8 } });
    expect(result.current.s1).toMatchObject({ contextRatio: 0.8, contextUsed: 80, contextTotal: 200 });
    send({ kind: 'compact_boundary', tokenBudget: { used: 30, total: 200, effectiveTotal: 100, ratio: 0.3 } });
    expect(result.current.s1.contextRatio).toBe(0.3);
    send({ kind: 'status', text: 'token_budget', tokenBudget: { used: 0, total: 0, unknown: true } });
    expect(result.current.s1.contextRatio).toBe(0.3);
    send({ kind: 'complete', usage: { input_tokens: 400 } });
    expect(result.current.s1.contextRatio).toBe(0.3);
    send({ kind: 'status', text: 'started', runId: 'r2' });
    expect(result.current.s1.toolsCompleted).toBe(0);
    send({ kind: 'status', text: 'token_budget', runId: 'r2', tokenBudget: { used: 25, total: 200, effectiveTotal: 100 } });
    expect(result.current.s1.contextRatio).toBeUndefined();
    send({ kind: 'status', text: 'token_budget', runId: 'r2', tokenBudget: { ratio: 0.25, used: 25, total: 200 } });
    expect(result.current.s1.contextRatio).toBe(0.25);
    send({ kind: 'status', text: 'token_budget', runId: 'r2', tokenBudget: { ratio: 1.2, used: NaN, total: 0 } });
    expect(result.current.s1.contextRatio).toBe(0.25);
  });

  it('recognizes streaming activity without inventing a turn start and ignores orphan frames', () => {
    const { result } = renderHook(() => useTaskProgress());
    send({ kind: 'stream_delta', content: 'text' });
    expect(result.current.s1).toMatchObject({ phase: 'working', toolsCompleted: 0 });
    expect(result.current.s1.turnStartedAt).toBeUndefined();
    send({ kind: 'text', content: 'final' });
    send({ kind: 'thinking', content: 'thought' });
    expect(result.current.s1.phase).toBe('working');
    send({ type: 'session-status', isProcessing: true });
    act(() => handler({ kind: 'status', text: 'started' }));
    expect(Object.keys(result.current)).toEqual(['s1']);
  });

  it('does not invent an elapsed start from a turn start without a timestamp', () => {
    const { result } = renderHook(() => useTaskProgress());
    send({ kind: 'status', text: 'started', runId: 'r1' });
    expect(result.current.s1.turnStartedAt).toBeUndefined();
  });
});
