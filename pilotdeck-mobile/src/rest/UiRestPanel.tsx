import { useEffect, useMemo, useRef, useState } from 'react';
import { UiRestTransport } from './transport';

export interface UiRestPanelProps { module: string; endpoint: string; instanceId: string; projectKey: string; sessionKey: string }
type Operation = { label: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; sample?: string; destructive?: boolean };
const PROJECT = ':project';
const operations: Record<string, Operation[]> = {
  workspaces: [
    { label: 'List projects', method: 'GET', path: '/api/projects' },
    { label: 'Add existing workspace', method: 'POST', path: '/api/projects/create-workspace', sample: '{"workspaceType":"existing","path":"/absolute/workspace"}' },
    { label: 'Register project', method: 'POST', path: '/api/projects/create', sample: '{"path":"/absolute/workspace"}' },
    { label: 'Delete project', method: 'DELETE', path: `/api/projects/${PROJECT}`, destructive: true },
  ],
  agents: [{ label: 'Runtime configuration', method: 'GET', path: '/api/agents/runtime-config' }],
  files: [
    { label: 'File tree', method: 'GET', path: `/api/projects/${PROJECT}/files` },
    { label: 'Read text file', method: 'GET', path: `/api/projects/${PROJECT}/file` },
    { label: 'Write text file', method: 'PUT', path: `/api/projects/${PROJECT}/file`, sample: '{"filePath":"README.txt","content":"hello"}' },
    { label: 'Create file or directory', method: 'POST', path: `/api/projects/${PROJECT}/files/create`, sample: '{"path":"","type":"file","name":"new.txt"}' },
    { label: 'Delete file or directory', method: 'DELETE', path: `/api/projects/${PROJECT}/files`, sample: '{"path":"new.txt","type":"file"}', destructive: true },
  ],
  memory: [
    { label: 'Overview', method: 'GET', path: '/api/memory/overview' },
    { label: 'List memories', method: 'GET', path: '/api/memory/memory/list' },
    { label: 'Memory actions (advanced)', method: 'POST', path: '/api/memory/memory/actions', sample: '{}', destructive: true },
    { label: 'Clear current project memory', method: 'POST', path: '/api/memory/clear', sample: '{"scope":"current_project"}', destructive: true },
  ],
  plugins: [
    { label: 'List plugins', method: 'GET', path: '/api/plugins' },
    { label: 'Install plugin', method: 'POST', path: '/api/plugins/install', sample: '{"url":"https://example.com/plugin.git"}' },
  ],
  settings: [
    { label: 'Get configuration', method: 'GET', path: '/api/config' },
    { label: 'Validate YAML', method: 'POST', path: '/api/config/validate', sample: '{"raw":""}' },
    { label: 'Save configuration (requires current baseRevision)', method: 'PUT', path: '/api/config', sample: '{"raw":"# complete YAML","baseRevision":"revision from GET"}', destructive: true },
    { label: 'Reload configuration', method: 'POST', path: '/api/config/reload', destructive: true },
    { label: 'Get permissions', method: 'GET', path: '/api/settings/permissions' },
    { label: 'Get notification preferences', method: 'GET', path: '/api/settings/notification-preferences' },
  ],
  logs: [],
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** UI-server REST is independent of the native Gateway; credentials live only in component memory. */
export function UiRestPanel({ module, endpoint, instanceId, projectKey, sessionKey }: UiRestPanelProps) {
  const [origin, setOrigin] = useState(endpoint);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [jwt, setJwt] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [selection, setSelection] = useState(0);
  const [input, setInput] = useState('');
  const [filePath, setFilePath] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const client = useMemo(() => {
    try { return new UiRestTransport(origin, jwt, apiKey); } catch { return null; }
  }, [origin, instanceId]);
  const live = useRef(client);
  // Abandon old requests and output whenever the active instance/origin/module/session changes.
  useEffect(() => { live.current = client; return () => { epoch.current++; client?.dispose(); }; }, [client, instanceId, module, projectKey, sessionKey]);
  useEffect(() => { setOrigin(endpoint); setUsername(''); setPassword(''); setJwt(''); setApiKey(''); setResult(''); setBusy(false); }, [endpoint, instanceId]);
  useEffect(() => { setSelection(0); setResult(''); setBusy(false); setFile(null); setInput(''); }, [module, projectKey, sessionKey]);
  useEffect(() => { client?.setCredentials(jwt, apiKey); }, [client, jwt, apiKey]);
  const items = operations[module] ?? [];
  const operation = items[selection] ?? items[0];
  async function execute(action: () => Promise<unknown>, apply?: (data: unknown) => void) {
    if (!client) { setResult('Enter a valid UI server origin.'); return; }
    const current = ++epoch.current;
    setBusy(true);
    try {
      const data = await action();
      if (current === epoch.current && live.current === client) {
        apply?.(data);
        if (current === epoch.current) setResult(JSON.stringify(data, null, 2) ?? 'Success');
      }
    } catch (error) {
      if (current === epoch.current && live.current === client) setResult(error instanceof Error ? error.message : String(error));
    } finally { if (current === epoch.current && live.current === client) setBusy(false); }
  }
  function changeSelection(index: number) { client?.abortPending(); epoch.current++; setBusy(false); setResult(''); setSelection(index); setInput(items[index]?.sample ?? ''); }
  function submit() {
    if (!operation || !client) return;
    if (operation.destructive && !window.confirm(`Confirm ${operation.label}?`)) return;
    let body: object | undefined;
    if (operation.method !== 'GET' && operation.sample !== undefined) {
      try { const parsed: unknown = JSON.parse(input || operation.sample); if (!record(parsed)) throw new Error('Body must be a JSON object'); body = parsed; }
      catch (error) { setResult(error instanceof Error ? error.message : String(error)); return; }
    }
    const path = operation.path.replace(PROJECT, encodeURIComponent(projectKey));
    if (path.includes(PROJECT) || (operation.path.includes(PROJECT) && !projectKey)) { setResult('Select a project first.'); return; }
    const query = operation.label === 'Read text file' ? `?filePath=${encodeURIComponent(filePath)}` : '';
    if (query && !filePath) { setResult('Enter a file path.'); return; }
    void execute(() => client.json(operation.method, path + query, body));
  }
  function upload() { if (!client || !file || !projectKey) return; void execute(() => client.upload(projectKey, targetPath, file)); }
  function download() {
    if (!client || !projectKey) return;
    const downloadEpoch = epoch.current + 1;
    void execute(async () => {
      const blob = await client.download(projectKey);
      if (live.current !== client || epoch.current !== downloadEpoch) return 'Cancelled';
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${projectKey.replace(/[^\w.-]/g, '_')}.zip`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return `Downloaded ${blob.size} bytes`;
    });
  }
  return <section aria-label="UI REST panel">
    <h3>UI server REST · {module}</h3>
    <p>REST origin must point to the UI server, NOT the native Gateway. Credentials here are independent of the native token and are kept only in memory. Browser CORS and HTTPS/mixed-content policies apply.</p>
    <label>UI server origin <input value={origin} onChange={event => setOrigin(event.target.value)} placeholder="http://localhost:3001" /></label>
    <div><label>Username <input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>
    <label>Password (memory only) <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
    <button disabled={!client || busy || !username || !password} onClick={() => { if (client) void execute(() => client.login(username, password), data => { if (record(data) && typeof data.token === 'string') { setJwt(data.token); epoch.current++; setBusy(false); setResult('Authenticated'); } setPassword(''); }); }}>Login to UI server</button></div>
    <label>UI JWT <input type="password" autoComplete="off" value={jwt} onChange={event => setJwt(event.target.value)} /></label>
    <label>Optional x-api-key <input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
    <p>Project: {projectKey || '(none)'} · Session: {sessionKey || '(none)'}</p>
    {items.length ? <><label>Operation <select value={selection} onChange={event => changeSelection(Number(event.target.value))}>{items.map((item, index) => <option key={item.label} value={index}>{item.method} {item.label}</option>)}</select></label>
      {operation?.label === 'Read text file' && <label>File path <input value={filePath} onChange={event => setFilePath(event.target.value)} /></label>}
      {operation?.sample !== undefined && <><label><input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} /> Advanced JSON body</label>{advanced ? <textarea aria-label="JSON body" value={input || operation.sample} onChange={event => setInput(event.target.value)} rows={7} /> : <p>Example body: <code>{operation.sample}</code> (enable advanced mode to edit)</p>}</>}
      <button disabled={!client || busy || (operation?.sample !== undefined && !advanced)} onClick={submit}>Run operation</button>
    </> : <p>No verified UI REST log endpoint; unavailable in this panel.</p>}
    {module === 'files' && <div><label>Upload destination path <input value={targetPath} onChange={event => setTargetPath(event.target.value)} /></label><input type="file" aria-label="Upload file" onChange={event => setFile(event.target.files?.[0] ?? null)} /><button disabled={!client || busy || !file || !projectKey} onClick={upload}>Upload file</button><button disabled={!client || busy || !projectKey} onClick={download}>Download project ZIP</button></div>}
    <pre aria-live="polite" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{busy ? 'Loading…' : result}</pre>
  </section>;
}
