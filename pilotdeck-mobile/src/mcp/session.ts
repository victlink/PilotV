import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface McpAdapter {
  connect(): Promise<void>; terminateSession(): Promise<void>; close(): Promise<void>;
  listTools(): Promise<unknown>; callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listResources(): Promise<unknown>; readResource(args: { uri: string }): Promise<unknown>;
  listPrompts(): Promise<unknown>; getPrompt(args: { name: string; arguments: Record<string, string> }): Promise<unknown>;
}
export type McpStatus = { phase: 'idle' | 'connecting' | 'connected' | 'error'; error?: string };
export function jsonObject(source: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source.trim() || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Arguments must be a JSON object');
  return value as Record<string, unknown>;
}
function officialAdapter(endpoint: string, token: string): McpAdapter {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 1000, maxReconnectionDelay: 4000, reconnectionDelayGrowFactor: 2 },
  });
  const client = new Client({ name: 'pilotdeck-mobile', version: '0.1.0' }, { capabilities: {} });
  // Do not advertise sampling: no model/user consent workflow exists in this UI.
  return {
    connect: () => client.connect(transport), terminateSession: () => transport.terminateSession(), close: () => client.close(),
    listTools: () => client.listTools(), callTool: args => client.callTool(args),
    listResources: () => client.listResources(), readResource: args => client.readResource(args),
    listPrompts: () => client.listPrompts(), getPrompt: args => client.getPrompt(args),
  };
}
export class McpSession {
  private adapter: McpAdapter | null = null;
  private epoch = 0;
  private state: McpStatus = { phase: 'idle' };
  private token = '';
  constructor(private readonly factory: (endpoint: string, token: string) => McpAdapter = officialAdapter, private readonly onStatus?: (status: McpStatus) => void) {}
  status() { return this.state; }
  private update(state: McpStatus) { this.state = state; this.onStatus?.(state); }
  async connect(endpoint: string, token: string, _instanceId: string): Promise<void> {
    const epoch = ++this.epoch;
    const previous = this.adapter; this.adapter = null;
    this.update({ phase: 'connecting' });
    if (previous) await this.release(previous);
    if (epoch !== this.epoch) return;
    this.token = token;
    this.update({ phase: 'connecting' });
    try {
      const adapter = this.factory(endpoint, token);
      if (epoch !== this.epoch) { void this.release(adapter); return; }
      this.adapter = adapter;
      await adapter.connect();
      if (epoch === this.epoch) this.update({ phase: 'connected' });
    } catch (error) {
      if (epoch === this.epoch) {
        const message = error instanceof Error ? error.message : 'Connection failed';
        this.update({ phase: 'error', error: token ? message.replaceAll(token, '[redacted]') : message });
        const adapter = this.adapter; this.adapter = null;
        if (adapter) void this.release(adapter);
      }
    }
  }
  private async release(adapter: McpAdapter) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A lost DELETE response must not indefinitely block the next instance.
      await Promise.race([
        adapter.terminateSession(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); }),
      ]);
    } catch { /* server may be offline or stateless */ }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      try { await adapter.close(); } catch { /* teardown best effort */ }
    }
  }
  async dispose() {
    ++this.epoch;
    const adapter = this.adapter; this.adapter = null;
    this.token = '';
    this.update({ phase: 'idle' });
    if (adapter) await this.release(adapter);
  }
  private async invoke(action: (adapter: McpAdapter) => Promise<unknown>) {
    const adapter = this.adapter; const epoch = this.epoch;
    if (!adapter || this.state.phase !== 'connected') throw Error('MCP is not connected');
    try {
      const result = await action(adapter);
      if (epoch !== this.epoch) throw Error('MCP connection changed');
      return result;
    } catch (error) {
      if (epoch !== this.epoch) throw Error('MCP connection changed');
      if (error instanceof Error && this.token) throw Error(error.message.replaceAll(this.token, '[redacted]'));
      throw error;
    }
  }
  listTools() { return this.invoke(a => a.listTools()); }
  callTool(name: string, input: string) { const args = jsonObject(input); return this.invoke(a => a.callTool({ name, arguments: args })); }
  listResources() { return this.invoke(a => a.listResources()); }
  readResource(uri: string) { return this.invoke(a => a.readResource({ uri })); }
  listPrompts() { return this.invoke(a => a.listPrompts()); }
  getPrompt(name: string, input: string) {
    const args = jsonObject(input);
    if (Object.values(args).some(value => typeof value !== 'string')) throw Error('Prompt arguments must be strings');
    return this.invoke(a => a.getPrompt({ name, arguments: args as Record<string, string> }));
  }
}
