import type { Config, Scope } from './core';
export type RecordValue = Record<string, unknown>;
export function object(value: unknown): RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
export function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export interface StreamEvent { id: string; seq: number; final: boolean; event: unknown }
export class Gateway {
  private socket!: WebSocket;
  private ready!: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private readyDone = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private streams = new Map<string, (event: StreamEvent) => void>();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private config: Config, private scope: Scope, private onStatus: (status: string) => void) {
    this.resetReady();
    scope.onClose(() => {
      clearTimeout(this.timer); clearTimeout(this.retryTimer);
      this.fail(Error('实例已切换'));
      this.socket.close();
    });
    this.connect();
  }
  private resetReady() {
    this.readyDone = false;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // A connection may close before any caller has started waiting for readiness.
    void this.ready.catch(() => {});
  }
  private connect() {
    if (!this.scope.active()) return;
    const socket = new WebSocket(this.config.ws);
    this.socket = socket;
    this.timer = setTimeout(() => { if (socket === this.socket) { this.onStatus('连接超时'); socket.close(); } }, 12000);
    socket.onopen = () => {
      if (this.scope.active() && socket === this.socket) {
        this.onStatus('正在握手');
        socket.send(JSON.stringify({ type: 'hello', protocolVersion: '1.1', clientName: 'pilotdeck-mobile', clientVersion: '0.1.0', token: this.config.token }));
      }
    };
    socket.onmessage = e => {
      if (!this.scope.active() || socket !== this.socket) return;
      let message: RecordValue;
      try { message = object(JSON.parse(String(e.data))); } catch { return; }
      if (message.type === 'hello_ok') {
        clearTimeout(this.timer); this.retries = 0;
        if (!this.readyDone) { this.readyDone = true; this.readyResolve(); }
        this.onStatus('已连接'); return;
      }
      if (message.type === 'hello_error' || message.type === 'error' && !message.id) {
        this.onStatus(text(message.message) || text(message.error) || '握手失败'); socket.close(); return;
      }
      const id = text(message.id);
      if (message.type === 'response' && id) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.remove(id);
        if (message.ok === true) pending.resolve(message.result); else pending.reject(Error(text(object(message.error).message) || text(message.error) || '请求失败'));
      } else if (message.type === 'event' && id) {
        this.streams.get(id)?.({ id, seq: typeof message.seq === 'number' ? message.seq : 0, final: message.final === true, event: message.event });
        if (message.final === true) {
          const pending = this.pending.get(id);
          if (pending) { this.remove(id); pending.resolve(message.event); }
        }
      }
    };
    socket.onerror = () => { if (socket === this.socket && this.scope.active()) { this.onStatus('WebSocket 网络错误'); socket.close(); } };
    socket.onclose = () => {
      if (socket !== this.socket || !this.scope.active()) return;
      this.fail(Error('连接已断开'));
      if (this.retries < 3) {
        this.resetReady();
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.connect(); }, 1000 * 2 ** this.retries++);
      }
    };
  }
  private remove(id: string) {
    const pending = this.pending.get(id);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending.delete(id); this.scope.forget(id); this.streams.delete(id);
  }
  private fail(error: Error) {
    clearTimeout(this.timer);
    if (!this.readyDone) { this.readyDone = true; this.readyReject(error); }
    if (this.scope.active()) this.onStatus(error.message);
    for (const [id, p] of this.pending) { p.reject(error); this.remove(id); }
  }
  async request(method: string, params: RecordValue = {}, onEvent?: (event: StreamEvent) => void): Promise<unknown> {
    await this.ready;
    if (!this.scope.active() || this.socket.readyState !== WebSocket.OPEN) throw Error('实例已切换或连接已断开');
    const id = crypto.randomUUID();
    const pending = this.scope.pending<unknown>(id);
    const entry: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve: pending.resolve, reject: pending.reject };
    this.pending.set(id, entry);
    if (onEvent) this.streams.set(id, onEvent);
    if (method !== 'submit_turn') entry.timer = setTimeout(() => { this.remove(id); pending.reject(Error('请求超时')); }, 30000);
    try { this.socket.send(JSON.stringify({ type: 'request', id, method, params })); }
    catch (error) { this.remove(id); pending.reject(error instanceof Error ? error : Error('发送失败')); }
    return pending.promise.finally(() => this.remove(id));
  }
}
export function rows(value: unknown, key: string): RecordValue[] { const array = object(value)[key]; return Array.isArray(array) ? array.map(object) : []; }
