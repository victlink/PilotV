import { useEffect, useRef, useState } from 'react';
import type { Gateway } from '../gateway';
import { object, text } from '../gateway';
import { contracts, isNativeModule, parseParams, substitute, type Operation } from './contracts';
export interface NativePanelProps { module: string; gateway: Gateway | null; projectKey: string; sessionKey: string }
function display(value: unknown) { return JSON.stringify(value, null, 2) ?? String(value); }
function recordArray(value: unknown, key: string): Record<string, unknown>[] { const v = object(value)[key]; return Array.isArray(v) ? v.map(object) : []; }
function summaries(module: string, data: unknown): Record<string, unknown>[] {
  const key = ({ workspaces: 'projects', agents: 'sessions', tasks: 'tasks', files: 'items', plugins: 'items', logs: 'messages' } as Record<string, string>)[module];
  return key ? recordArray(data, key) : [];
}
function itemTitle(value: Record<string, unknown>): string { return ['name', 'title', 'message', 'relativePath', 'slug', 'sessionKey', 'projectKey', 'taskId', 'id'].map(k => text(value[k])).find(Boolean) || display(value).slice(0, 90); }
function contextParams(op: Operation, context: { projectKey: string; sessionKey: string }) { return substitute(op.template, context) as Record<string, unknown>; }
export function NativePanel({ module, gateway, projectKey, sessionKey }: NativePanelProps) {
  const [data, setData] = useState<unknown>(null);
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Operation | null>(null);
  const [draft, setDraft] = useState('');
  const generation = useRef(0);
  const contract = isNativeModule(module) ? contracts[module] : null;
  const context = { projectKey, sessionKey };
  const list = contract?.list;
  useEffect(() => {
    const id = ++generation.current;
    setData(null); setError(''); setNotice(''); setSelected(null); setCapabilities(null);
    if (!gateway || !list) return;
    let cancelled = false;
    const get = async () => {
      try {
        const info = object(await gateway.request('describe_server'));
        if (cancelled || id !== generation.current) return;
        setCapabilities(Array.isArray(info.capabilities) ? info.capabilities.filter((v): v is string => typeof v === 'string') : []);
        if (list.capability && !(Array.isArray(info.capabilities) && info.capabilities.includes(list.capability))) return;
        if ((module === 'files' || module === 'tasks' || module === 'agents') && !projectKey) return;
        if (module === 'logs' && !sessionKey) return;
        const result = await gateway.request(list.method, contextParams(list, context));
        if (!cancelled && id === generation.current) setData(result);
      } catch (e) { if (!cancelled && id === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    };
    void get();
    return () => { cancelled = true; generation.current++; };
  }, [gateway, module, projectKey, sessionKey, list]);
  function select(op: Operation, item?: Record<string, unknown>) {
    const params = contextParams(op, context);
    if (item) {
      for (const key of ['taskId', 'revision', 'message', 'schedule', 'timezone', 'slug', 'scope', 'subagentId', 'sessionKey', 'projectKey', 'fromEntryId', 'relativePath']) {
        const output = key === 'revision' ? 'expectedRevision' : key;
        if (item[key] !== undefined && Object.prototype.hasOwnProperty.call(params, output)) params[output] = item[key];
      }
    }
    setSelected(op); setDraft(display(params)); setError(''); setNotice('');
  }
  async function run(op: Operation, params: Record<string, unknown>) {
    if (!gateway || busy) return;
    if (op.destructive && !window.confirm(`确认${op.title}？`)) return;
    setBusy(true); setError(''); setNotice('');
    const id = generation.current;
    try {
      const result = await gateway.request(op.method, params);
      if (id !== generation.current) return;
      setNotice(`${op.title}：${display(result)}`);
      if (op.refresh && list && (!list.capability || capabilities?.includes(list.capability))) {
        const updated = await gateway.request(list.method, contextParams(list, context));
        if (id === generation.current) setData(updated);
      } else if (!op.refresh) setData(result);
    } catch (e) { if (id === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  if (!contract) return <section aria-label="未知原生模块">未知模块：{module}</section>;
  const items = summaries(module, data);
  const cursor = text(object(data).nextCursor);
  return <section className="native-panel" aria-label={contract.title}>
    <h2>{contract.title}</h2>
    {!gateway && <p role="status">请先连接网关。</p>}
    {contract.unavailable.map(value => <p key={value} role="note">不可用：{value}</p>)}
    {list && <div><button disabled={!gateway || busy || Boolean(list.capability && capabilities !== null && !capabilities.includes(list.capability))} onClick={() => select(list)}>刷新 / 查询 · {list.title}</button>
      {list.capability && capabilities !== null && !capabilities.includes(list.capability) && <p role="status">此网关未提供 {list.capability} 能力。</p>}
      {cursor && <button disabled={busy} onClick={() => { const params = { ...contextParams(list, context), cursor }; void run(list, params); }}>下一页</button>}
    </div>}
    {items.length > 0 && <ul>{items.map((item, i) => <li key={i}><strong>{itemTitle(item)}</strong><details><summary>详情</summary><pre>{display(item)}</pre></details><div>{contract.actions.map(op => <button key={op.method} disabled={!gateway || busy || Boolean(op.capability && capabilities !== null && !capabilities.includes(op.capability))} onClick={() => select(op, item)}>{op.title}</button>)}</div></li>)}</ul>}
    {data !== null && items.length === 0 && <pre aria-label="网关返回">{display(data)}</pre>}
    <div>{contract.actions.map(op => <button key={op.method} disabled={!gateway || busy || Boolean(op.capability && capabilities !== null && !capabilities.includes(op.capability))} onClick={() => select(op)}>{op.title}{op.capability && capabilities !== null && !capabilities.includes(op.capability) ? '（不可用）' : ''}</button>)}</div>
    {selected && <form onSubmit={e => { e.preventDefault(); try { void run(selected, parseParams(draft)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}><label>{selected.title} · 网关参数 JSON<textarea rows={12} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}/></label><button type="submit" disabled={busy || !gateway || Boolean(selected.capability && capabilities !== null && !capabilities.includes(selected.capability))}>执行</button><button type="button" onClick={() => setSelected(null)}>取消</button></form>}
    {busy && <p role="status">请求中…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <pre role="status">{notice}</pre>}
  </section>;
}
export default NativePanel;
