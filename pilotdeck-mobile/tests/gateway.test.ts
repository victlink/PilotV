import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScope, type Config } from '../src/core';
import { Gateway, type StreamEvent } from '../src/gateway';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); this.receive({ type: 'hello_ok' }); }
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  receive(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
  get requestId(): string { return String(this.sent.find(message => message.type === 'request')?.id); }
}
const config: Config = { id: 'test', name: 'test', rest: 'http://localhost', ws: 'ws://localhost', mcp: '', token: '', notes: '', rememberToken: false };

beforeEach(() => { FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });
afterEach(() => vi.unstubAllGlobals());

describe('gateway stream lifecycle', () => {
  it('resolves submit_turn with final event and stops streaming', async () => {
    const scope = createScope();
    const gateway = new Gateway(config, scope, () => {});
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const events: StreamEvent[] = [];
    const result = gateway.request('submit_turn', { message: 'hi' }, event => events.push(event));
    await vi.waitFor(() => expect(socket.requestId).not.toBe('undefined'));
    const id = socket.requestId;
    socket.receive({ type: 'event', id, seq: 1, final: false, event: { part: 'hi' } });
    socket.receive({ type: 'event', id, seq: 2, final: true, event: { done: true } });
    await expect(result).resolves.toEqual({ done: true });
    socket.receive({ type: 'event', id, seq: 3, final: false, event: { late: true } });
    expect(events.map(event => event.seq)).toEqual([1, 2]);
    scope.dispose();
  });

  it('rejects in-flight submit_turn on instance switch', async () => {
    const scope = createScope();
    const gateway = new Gateway(config, scope, () => {});
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const result = gateway.request('submit_turn', {}, () => {});
    await vi.waitFor(() => expect(socket.requestId).not.toBe('undefined'));
    scope.dispose();
    await expect(result).rejects.toThrow('实例已切换');
    expect(socket.readyState).toBe(3);
  });

  it.each([{ ok: true, result: 'done' }, { ok: false, error: { message: 'failed' } }])('clears stream after response %#', async response => {
    const scope = createScope();
    const gateway = new Gateway(config, scope, () => {});
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const events: StreamEvent[] = [];
    const result = gateway.request('submit_turn', {}, event => events.push(event));
    await vi.waitFor(() => expect(socket.requestId).not.toBe('undefined'));
    const id = socket.requestId;
    socket.receive({ type: 'response', id, ...response });
    if (response.ok) await expect(result).resolves.toBe('done');
    else await expect(result).rejects.toThrow('failed');
    socket.receive({ type: 'event', id, seq: 1, final: true, event: 'late' });
    expect(events).toEqual([]);
    scope.dispose();
  });

  it('reconnects at 1s/2s/4s, handshakes again, and never replays in-flight requests', async () => {
    vi.useFakeTimers();
    try {
      const scope = createScope();
      const gateway = new Gateway(config, scope, () => {});
      const first = FakeWebSocket.instances[0];
      first.open();
      const pending = gateway.request('submit_turn');
      await Promise.resolve();
      expect(first.requestId).not.toBe('undefined');
      first.close();
      await expect(pending).rejects.toThrow('连接已断开');
      const waiting = gateway.request('list_sessions');
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const second = FakeWebSocket.instances[1];
      expect(second.sent).toEqual([]);
      second.readyState = 1;
      second.onopen?.();
      expect(second.sent[0]).toMatchObject({ type: 'hello', token: config.token });
      expect(second.sent.some(item => item.type === 'request')).toBe(false);
      second.receive({ type: 'hello_ok' });
      await Promise.resolve();
      expect(second.sent.filter(item => item.type === 'request')).toHaveLength(1);
      second.receive({ type: 'response', id: second.requestId, ok: true, result: 'fresh' });
      await expect(waiting).resolves.toBe('fresh');
      second.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeWebSocket.instances).toHaveLength(3);
      FakeWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeWebSocket.instances).toHaveLength(4);
      FakeWebSocket.instances[3].close();
      await vi.advanceTimersByTimeAsync(4000);
      expect(FakeWebSocket.instances).toHaveLength(5);
      FakeWebSocket.instances[4].close();
      await vi.advanceTimersByTimeAsync(30000);
      expect(FakeWebSocket.instances).toHaveLength(5);
      scope.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('times out ordinary requests after 30s but not submit_turn', async () => {
    vi.useFakeTimers();
    try {
      const scope = createScope();
      const gateway = new Gateway(config, scope, () => {});
      const socket = FakeWebSocket.instances[0];
      socket.open();
      const ordinary = gateway.request('list_sessions');
      const ordinaryAssertion = expect(ordinary).rejects.toThrow('请求超时');
      const stream = gateway.request('submit_turn');
      await Promise.resolve();
      const streamId = String(socket.sent.find(item => item.method === 'submit_turn')?.id);
      await vi.advanceTimersByTimeAsync(30000);
      await ordinaryAssertion;
      socket.receive({ type: 'event', id: streamId, final: true, event: 'done' });
      await expect(stream).resolves.toBe('done');
      scope.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('cancels scheduled reconnect on scope disposal', async () => {
    vi.useFakeTimers();
    try {
      const scope = createScope();
      new Gateway(config, scope, () => {});
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].close();
      scope.dispose();
      await vi.advanceTimersByTimeAsync(30000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
