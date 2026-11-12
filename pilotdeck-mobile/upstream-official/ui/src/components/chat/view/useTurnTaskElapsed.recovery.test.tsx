// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const socket = vi.hoisted(() => ({
  isConnected: true,
  sendMessage: vi.fn(() => true),
  handler: (_message: any) => {},
  subscribe: vi.fn((handler: (message: any) => void) => {
    socket.handler = handler;
    return () => {};
  }),
}));
vi.mock('../../../contexts/WebSocketContext', () => ({ useOptionalWebSocket: () => socket }));
import { useSessionContextUsageFromSocket } from './useTurnTaskElapsed';
afterEach(() => { cleanup(); vi.clearAllMocks(); socket.isConnected = true; });
it('requests a fresh snapshot on mount, switch and reconnect, after subscribing', () => {
  const { result, rerender } = renderHook(({ id }) => useSessionContextUsageFromSocket(id), { initialProps: { id: 's1' } });
  expect(socket.sendMessage).toHaveBeenLastCalledWith({ type: 'check-session-status', sessionId: 's1', includeActiveTurnMessages: true });
  expect(socket.subscribe.mock.invocationCallOrder[0]).toBeLessThan(socket.sendMessage.mock.invocationCallOrder[0]);
  act(() => socket.handler({ type: 'session-status', sessionId: 's1', tokenBudget: { used: 10, total: 100 } }));
  expect(result.current).toEqual({ used: 10, total: 100 });
  rerender({ id: 's2' });
  expect(result.current).toBeNull();
  expect(socket.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's2' }));
  socket.isConnected = false;
  rerender({ id: 's2' });
  const calls = socket.sendMessage.mock.calls.length;
  socket.isConnected = true;
  rerender({ id: 's2' });
  expect(socket.sendMessage.mock.calls.length).toBe(calls + 1);
});
