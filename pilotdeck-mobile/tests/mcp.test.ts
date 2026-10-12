import { describe, expect, it, vi } from 'vitest';
import { McpSession, type McpAdapter } from '../src/mcp/session';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function mockAdapter() {
  const adapter: McpAdapter = {
    connect: vi.fn().mockResolvedValue(undefined), terminateSession: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'search' }] }), callTool: vi.fn().mockResolvedValue({ content: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }), readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }), getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
  }; return adapter;
}
describe('MCP instance session', () => {
  it('connects and invokes all official discovery/action methods with JSON arguments', async () => {
    const adapter = mockAdapter(); const session = new McpSession(() => adapter);
    await session.connect('https://example.test/mcp', 'secret', 'a');
    await session.listTools(); await session.callTool('search', '{"term":"x"}');
    await session.listResources(); await session.readResource('file:///x'); await session.listPrompts(); await session.getPrompt('hello', '{"name":"a"}');
    expect(adapter.callTool).toHaveBeenCalledWith({ name: 'search', arguments: { term: 'x' } });
    expect(adapter.getPrompt).toHaveBeenCalledWith({ name: 'hello', arguments: { name: 'a' } });
    expect(() => session.callTool('search', '[]')).toThrow();
    await session.dispose(); expect(adapter.terminateSession).toHaveBeenCalledOnce(); expect(adapter.close).toHaveBeenCalledOnce();
  });
  it('isolates a pending connect and pending results when instance changes', async () => {
    const old = mockAdapter(); const next = mockAdapter(); const gate = deferred<void>(); vi.mocked(old.connect).mockReturnValue(gate.promise);
    const session = new McpSession(() => old);
    const pending = session.connect('https://example.test/mcp', 'secret', 'a');
    await session.dispose(); gate.resolve(); await pending;
    expect(session.status().phase).toBe('idle'); expect(old.close).toHaveBeenCalledOnce();
    const second = new McpSession(() => next); await second.connect('https://example.test/mcp', '', 'b');
    const result = deferred<{ tools: { name: string }[] }>(); vi.mocked(next.listTools).mockReturnValue(result.promise);
    const loading = second.listTools(); await second.dispose(); result.resolve({ tools: [{ name: 'stale' }] });
    await expect(loading).rejects.toThrow('MCP connection changed');
  });
  it('closes a stalled session and permits switching after a bounded teardown', async () => {
    vi.useFakeTimers();
    try {
      const old = mockAdapter(); const next = mockAdapter();
      vi.mocked(old.terminateSession).mockReturnValue(new Promise(() => {}));
      let calls = 0;
      const session = new McpSession(() => calls++ === 0 ? old : next);
      await session.connect('https://a.test/mcp', '', 'a');
      const switching = session.connect('https://b.test/mcp', '', 'b');
      await vi.advanceTimersByTimeAsync(3100);
      expect(session.status().phase).toBe('connected');
      expect(next.connect).toHaveBeenCalledOnce();
      expect(old.close).toHaveBeenCalledOnce();
      await switching; await session.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('never retries failed calls and reports connection errors', async () => {
    const adapter = mockAdapter(); vi.mocked(adapter.connect).mockRejectedValue(new Error('offline'));
    const session = new McpSession(() => adapter); await session.connect('https://example.test/mcp', '', 'a');
    expect(session.status().phase).toBe('error'); expect(session.status().error).toBe('offline');
    expect(adapter.callTool).not.toHaveBeenCalled(); await session.dispose();
  });
});
