import { useEffect, useState } from 'react';
import { McpSession, type McpStatus } from './session';

type Kind = 'tools' | 'resources' | 'prompts';
const message = (error: unknown) => error instanceof Error ? error.message : 'MCP request failed';
export function McpPanel({ endpoint, token, instanceId }: { endpoint: string; token: string; instanceId: string }) {
  const [session, setSession] = useState<McpSession | null>(null);
  const [status, setStatus] = useState<McpStatus>({ phase: 'idle' });
  const [kind, setKind] = useState<Kind>('tools');
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState('');
  const [input, setInput] = useState('{}');
  const [output, setOutput] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setItems([]); setSelected(''); setOutput(null); setError(''); setPending(false);
    if (!endpoint || !instanceId) { setStatus({ phase: 'idle' }); setSession(null); return; }
    const current = new McpSession(undefined, state => { if (active) setStatus(state); });
    setSession(current);
    void current.connect(endpoint, token, instanceId);
    return () => { active = false; void current.dispose(); };
  }, [endpoint, token, instanceId, generation]);
  useEffect(() => {
    if (!session || status.phase !== 'connected') return;
    let active = true;
    setItems([]); setSelected(''); setOutput(null); setError(''); setPending(true);
    const load = kind === 'tools' ? session.listTools() : kind === 'resources' ? session.listResources() : session.listPrompts();
    void load.then(result => {
      if (!active) return;
      const data = result as Record<string, unknown>;
      const list = data[kind]; setItems(Array.isArray(list) ? list as Record<string, unknown>[] : []);
    }).catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [session, status.phase, kind]);
  async function execute() {
    if (!session || !selected) return;
    setPending(true); setError(''); setOutput(null);
    try {
      const result = kind === 'tools' ? await session.callTool(selected, input)
        : kind === 'resources' ? await session.readResource(selected)
        : await session.getPrompt(selected, input);
      if (session.status().phase === 'connected') setOutput(result);
    } catch (e) { if (session.status().phase === 'connected') setError(message(e)); }
    finally { if (session.status().phase === 'connected') setPending(false); }
  }
  return <section aria-label="MCP panel">
    <p role="status">MCP: {status.phase === 'idle' ? 'Not configured' : status.phase === 'connecting' ? 'Connecting…' : status.phase === 'connected' ? 'Connected' : 'Connection failed'}</p>
    {status.error && <p role="alert">{status.error}</p>}
    {status.phase === 'error' && <button type="button" onClick={() => setGeneration(n => n + 1)}>Retry connection</button>}
    <nav aria-label="MCP capabilities">{(['tools', 'resources', 'prompts'] as const).map(value =>
      <button type="button" key={value} onClick={() => setKind(value)} aria-pressed={kind === value}>{value}</button>)}</nav>
    {pending && <p role="status">Request pending…</p>}
    {error && <p role="alert">{error}</p>}
    <label>{kind === 'resources' ? 'Resource URI' : kind === 'tools' ? 'Tool' : 'Prompt'}
      <select value={selected} onChange={e => { setSelected(e.target.value); setOutput(null); }} disabled={status.phase !== 'connected'}>
        <option value="">Select {kind.slice(0, -1)}</option>
        {items.map((item, index) => { const value = String(kind === 'resources' ? item.uri ?? '' : item.name ?? ''); return <option key={`${value}-${index}`} value={value}>{String(item.title ?? item.name ?? item.uri ?? value)}</option>; })}
      </select>
    </label>
    {kind !== 'resources' && <label>JSON arguments<textarea value={input} onChange={e => setInput(e.target.value)} spellCheck={false} /></label>}
    <button type="button" disabled={status.phase !== 'connected' || pending || !selected} onClick={() => void execute()}>{kind === 'tools' ? 'Call tool' : kind === 'resources' ? 'Read resource' : 'Get prompt'}</button>
    {output !== null && <pre aria-label="MCP result">{JSON.stringify(output, null, 2)}</pre>}
    <p>Sampling is unavailable: requests for model completions are not accepted.</p>
  </section>;
}
export default McpPanel;
