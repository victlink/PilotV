export interface ConfigInput { name: string; rest: string; ws: string; mcp: string; token: string; notes: string; rememberToken: boolean }
export interface Config extends ConfigInput { id: string }
export function parseConfig(input: ConfigInput): ConfigInput {
  const name = input.name.trim();
  if (!name) throw Error('请填写实例名称');
  function url(value: string, protocols: string[], label: string, optional = false): string {
    if (optional && !value.trim()) return '';
    try { const parsed = new URL(value.trim()); if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname || parsed.search || parsed.hash) throw Error(); return parsed.toString().replace(/\/$/, ''); }
    catch { throw Error(`${label} 地址无效，仅支持 ${protocols.join(' / ')} 且不能含凭据、查询或片段`); }
  }
  return { name, rest: url(input.rest, ['http:', 'https:'], 'REST'), ws: url(input.ws, ['ws:', 'wss:'], 'WebSocket'), mcp: url(input.mcp, ['http:', 'https:'], 'MCP', true), token: input.token, notes: input.notes, rememberToken: input.rememberToken };
}
export type Pending<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
export interface Scope { active(): boolean; dispose(): void; controller(): AbortController; onClose(fn: () => void): void; pending<T>(id: string): Pending<T>; forget(id: string): void }
export function createScope(): Scope {
  let alive = true;
  const controllers = new Set<AbortController>();
  const closers = new Set<() => void>();
  const pending = new Map<string, Pending<unknown>>();
  return {
    active: () => alive,
    controller() { const c = new AbortController(); if (!alive) c.abort(); else controllers.add(c); return c; },
    onClose(fn) { if (!alive) fn(); else closers.add(fn); },
    pending<T>(id: string): Pending<T> {
      if (!alive) throw Error('实例已切换');
      let resolve!: (value: T) => void; let reject!: (error: Error) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      const entry = { promise, resolve, reject };
      pending.set(id, entry as Pending<unknown>);
      return entry;
    },
    forget(id) { pending.delete(id); },
    dispose() {
      if (!alive) return;
      alive = false;
      for (const c of controllers) c.abort(); controllers.clear();
      for (const close of closers) close(); closers.clear();
      for (const item of pending.values()) item.reject(Error('实例已切换')); pending.clear();
    }
  };
}
const key = 'pilotdeck-mobile.instances.v1';
export function loadConfigs(): Config[] {
  try { const raw: unknown = JSON.parse(localStorage.getItem(key) || '[]'); if (!Array.isArray(raw)) return []; return raw.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    try { const config = parseConfig({ name: String(record.name || ''), rest: String(record.rest || ''), ws: String(record.ws || ''), mcp: String(record.mcp || ''), token: String(record.token || ''), notes: String(record.notes || ''), rememberToken: record.rememberToken === true }); return typeof record.id === 'string' ? [{ ...config, id: record.id }] : []; } catch { return []; }
  }); } catch { return []; }
}
export function saveConfigs(configs: Config[]) { localStorage.setItem(key, JSON.stringify(configs.map(c => ({ ...c, token: c.rememberToken ? c.token : '' })))); }
export function selectedId() { return localStorage.getItem('pilotdeck-mobile.selected.v1') || ''; }
export function setSelectedId(id: string) { localStorage.setItem('pilotdeck-mobile.selected.v1', id); }
