// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePendingConfirmations, type PendingConfirmationsBySession } from './usePendingConfirmations';

let handler: (msg: any) => void = () => {};
let isConnected = false;
const sendMessage = vi.fn(() => true);
const unsubscribe = vi.fn();
const subscribe = vi.fn((next: (msg: any) => void) => {
  handler = next;
  return unsubscribe;
});
vi.mock('../../contexts/WebSocketContext', () => ({
  useOptionalWebSocket: () => ({ subscribe, sendMessage, isConnected }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  isConnected = false;
  handler = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePendingConfirmations', () => {
  function Probe({ onValue }: { onValue: (value: PendingConfirmationsBySession) => void }) {
    const pending = usePendingConfirmations();
    onValue(pending);
    return null;
  }

  it('requests a snapshot once per connection, including reconnects', () => {
    const onValue = vi.fn();
    const { rerender } = render(<Probe onValue={onValue} />);
    expect(sendMessage).not.toHaveBeenCalled();
    isConnected = true;
    rerender(<Probe onValue={onValue} />);
    rerender(<Probe onValue={onValue} />);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'get-all-pending-permissions' });
    isConnected = false;
    rerender(<Probe onValue={onValue} />);
    isConnected = true;
    rerender(<Probe onValue={onValue} />);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('merges snapshots after live events without dropping or duplicating prompts', () => {
    isConnected = true;
    const seen: PendingConfirmationsBySession[] = [];
    render(<Probe onValue={value => seen.push(value)} />);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    act(() => {
      handler({ kind: 'permission_request', sessionId: 's1', requestId: 'live', toolName: 'Bash' });
      handler({ type: 'all-pending-permissions-response', data: [
        { sessionId: 's1', requestId: 'saved', toolName: 'Edit', receivedAt: new Date().toISOString() },
        { sessionId: 's1', requestId: 'live', toolName: 'Bash' },
        { sessionId: 's2', requestId: 'other', toolName: 'Read' },
        { requestId: 'orphan' },
      ] });
    });
    expect(seen.at(-1)?.s1.map(entry => entry.requestId)).toEqual(['live', 'saved']);
    expect(seen.at(-1)?.s2).toHaveLength(1);
    act(() => handler({ kind: 'permission_cancelled', requestId: 'saved' }));
    expect(seen.at(-1)?.s1.map(entry => entry.requestId)).toEqual(['live']);
    act(() => handler({ kind: 'session-turn-replaced', sessionId: 's1' }));
    expect(seen.at(-1)?.s1).toBeUndefined();
    expect(seen.at(-1)?.s2).toHaveLength(1);
    act(() => handler({ kind: 'complete', sessionId: 's2' }));
    expect(seen.at(-1)).toEqual({});
  });

  it('expires live and restored prompts and cleans up the timer and subscription', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-16T12:00:00Z');
    vi.setSystemTime(now);
    const ttl = 45 * 60 * 1000;
    const seen: PendingConfirmationsBySession[] = [];
    const { unmount } = render(<Probe onValue={value => seen.push(value)} />);
    act(() => {
      handler({ kind: 'permission_request', sessionId: 's1', requestId: 'live' });
      handler({ type: 'all-pending-permissions-response', data: [
        { sessionId: 's1', requestId: 'old', receivedAt: new Date(now - ttl - 1).toISOString() },
        { sessionId: 's1', requestId: 'restored', receivedAt: new Date(now - ttl + 1000).toISOString() },
        { sessionId: 's1', requestId: 'invalid', receivedAt: 'invalid' },
        { sessionId: 's1', requestId: 'missing' },
      ] });
    });
    expect(seen.at(-1)?.s1.map(entry => entry.requestId)).toEqual(['live', 'restored', 'invalid', 'missing']);
    expect(seen.at(-1)?.s1.find(entry => entry.requestId === 'invalid')?.receivedAt).toBe(now);
    expect(seen.at(-1)?.s1.find(entry => entry.requestId === 'missing')?.receivedAt).toBe(now);
    act(() => vi.advanceTimersByTime(1000));
    expect(seen.at(-1)?.s1.map(entry => entry.requestId)).toEqual(['live', 'invalid', 'missing']);
    act(() => vi.advanceTimersByTime(ttl - 1000));
    expect(seen.at(-1)).toEqual({});
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('tracks prompts for background sessions and clears them on cancel or completion', () => {
    const seen: PendingConfirmationsBySession[] = [];
    render(<Probe onValue={value => seen.push(value)} />);

    act(() => {
      handler({ kind: 'permission_request', sessionId: 'bg-1', requestId: 'r1', toolName: 'Bash' });
    });
    expect(seen.at(-1)?.['bg-1']).toHaveLength(1);
    expect(seen.at(-1)?.['bg-1']?.[0].toolName).toBe('Bash');

    act(() => {
      handler({ kind: 'permission_cancelled', sessionId: 'bg-1', requestId: 'r1' });
    });
    expect(seen.at(-1)?.['bg-1']).toBeUndefined();

    act(() => {
      handler({ kind: 'permission_request', sessionId: 'bg-2', requestId: 'r2', toolName: 'Edit' });
      handler({ kind: 'complete', sessionId: 'bg-2' });
    });
    expect(seen.at(-1)?.['bg-2']).toBeUndefined();
  });

  it('ignores prompts without a session and deduplicates by request id', () => {
    const seen: PendingConfirmationsBySession[] = [];
    render(<Probe onValue={value => seen.push(value)} />);
    act(() => {
      handler({ kind: 'permission_request', requestId: 'orphan', toolName: 'Bash' });
    });
    expect(seen.at(-1)).toEqual({});

    act(() => {
      handler({ kind: 'permission_request', sessionId: 's1', requestId: 'r1', toolName: 'Bash' });
      handler({ kind: 'permission_request', sessionId: 's1', requestId: 'r1', toolName: 'Bash' });
    });
    expect(seen.at(-1)?.['s1']).toHaveLength(1);
  });
});
