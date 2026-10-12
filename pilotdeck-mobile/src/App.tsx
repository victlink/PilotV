import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CirclePlus, Menu, Send, Square, Settings2, Wifi, WifiOff, X } from 'lucide-react';
import { createScope, loadConfigs, parseConfig, saveConfigs, selectedId, setSelectedId, type Config, type ConfigInput, type Scope } from './core';
import { Gateway, object, rows, text, type RecordValue, type StreamEvent } from './gateway';
import NativePanel from './native/NativePanel';
import McpPanel from './mcp/McpPanel';
import { UiRestPanel } from './rest/UiRestPanel';
import type { NativeModule } from './native/contracts';
import './style.css';
const blank: ConfigInput = { name: '', rest: '', ws: '', mcp: '', token: '', notes: '', rememberToken: false };
function label(r: RecordValue, ...keys: string[]) { return keys.map(k => text(r[k])).find(Boolean) || '未命名'; }
function errorMessage(e: unknown) { return e instanceof Error ? e.message : '请求失败'; }
function formatted(v: unknown) { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? ''; }
const tabs = [['chat', '会话'], ['workspaces', '工作空间'], ['agents', '代理'], ['tasks', '任务'], ['files', '文件'], ['memory', '记忆'], ['plugins', '扩展'], ['settings', '设置'], ['logs', '记录'], ['mcp', 'MCP']] as const;
type Tab = (typeof tabs)[number][0];
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function time(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date).replaceAll('/', '-');
}
function sortedSessions(value: unknown) { return rows(value, 'sessions').sort((a, b) => (Number(b.lastModified) || 0) - (Number(a.lastModified) || 0)); }
export default function App() {
  const [configs, setConfigs] = useState<Config[]>(loadConfigs);
  const [id, setId] = useState(selectedId);
  const [editor, setEditor] = useState<ConfigInput | null>(null);
  const [editingId, setEditingId] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [businessChannel, setBusinessChannel] = useState<'ws' | 'rest'>('ws');
  const [gatewayState, setGatewayState] = useState<{ identity: string; gateway: Gateway } | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [status, setStatus] = useState('未连接');
  const [projects, setProjects] = useState<RecordValue[]>([]);
  const [sessions, setSessions] = useState<RecordValue[]>([]);
  const [projectKey, setProjectKey] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const [messages, setMessages] = useState<unknown[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const scopeRef = useRef<Scope | null>(null);
  const gatewayRef = useRef<Gateway | null>(null);
  const selectionRef = useRef(0);
  const config = configs.find(c => c.id === id);
  const identity = JSON.stringify([id, config?.rest, config?.ws, config?.token, connectionRevision]);
  function clearView() { setProjects([]); setSessions([]); setProjectKey(''); setSessionKey(''); setMessages([]); setEvents([]); setBusy(false); setNotice(''); }
  useEffect(() => {
    setSelectedId(id);
    const scope = createScope(); scopeRef.current = scope; gatewayRef.current = null; setGatewayState(null);
    clearView(); setInput(''); selectionRef.current++;
    const current = configs.find(c => c.id === id);
    if (!current) { setStatus('选择实例后连接'); return () => scope.dispose(); }
    setStatus('正在连接');
    const gateway = new Gateway(current, scope, s => { if (scope.active()) setStatus(s); }); gatewayRef.current = gateway; setGatewayState({ identity, gateway });
    gateway.request('list_projects').then(result => { if (scope.active()) setProjects(rows(result, 'projects')); }).catch(e => { if (scope.active()) setNotice(errorMessage(e)); });
    return () => { scope.dispose(); if (scopeRef.current === scope) { scopeRef.current = null; gatewayRef.current = null; } };
    // Instance identity, not config array identity: updates to other entries must not reconnect.
  }, [id, config?.rest, config?.ws, config?.token, connectionRevision]);
  async function selectProject(key: string) {
    setProjectKey(key); setSessionKey(''); setSessions([]); setMessages([]); setEvents([]); setBusy(false); setNotice('');
    const scope = scopeRef.current; const gateway = gatewayRef.current; const selection = ++selectionRef.current;
    if (!scope || !gateway || !key) return;
    try { const result = await gateway.request('list_sessions', { projectKey: key }); if (scope.active() && selectionRef.current === selection) setSessions(sortedSessions(result)); }
    catch (e) { if (scope.active() && selectionRef.current === selection) setNotice(errorMessage(e)); }
  }
  async function selectSession(key: string, project = projectKey) {
    setSessionKey(key); setMessages([]); setEvents([]); setBusy(false); setNotice('');
    const scope = scopeRef.current; const gateway = gatewayRef.current; const selection = ++selectionRef.current;
    if (!scope || !gateway || !key) return;
    try { const result = await gateway.request('read_session_messages', { sessionKey: key, projectKey: project }); if (scope.active() && selectionRef.current === selection) { const data = object(result); setMessages(Array.isArray(data.messages) ? data.messages : Array.isArray(result) ? result : []); } }
    catch (e) { if (scope.active() && selectionRef.current === selection) setNotice(errorMessage(e)); }
  }
  async function newSession() {
    const scope = scopeRef.current; const gateway = gatewayRef.current; const project = projectKey;
    if (!scope || !gateway || !project) return;
    let selection = ++selectionRef.current;
    const current = () => scope.active() && selectionRef.current === selection;
    try {
      const result = object(await gateway.request('new_session', { channelKey: 'web', projectKey: project }));
      if (!current()) return;
      const key = text(result.sessionKey); if (!key) throw Error('未返回 sessionKey');
      setSessionKey(key); setMessages([]); setEvents([]); setBusy(false); setNotice(''); setTab('chat'); setDrawer(false);
      selection = ++selectionRef.current;
      const [list, history] = await Promise.all([
        gateway.request('list_sessions', { projectKey: project }),
        gateway.request('read_session_messages', { sessionKey: key, projectKey: project }),
      ]);
      if (current()) {
        setSessions(sortedSessions(list));
        const data = object(history); setMessages(Array.isArray(data.messages) ? data.messages : Array.isArray(history) ? history : []);
      }
    } catch (e) { if (current()) setNotice(errorMessage(e)); }
  }
  async function send() {
    const message = input.trim(); const scope = scopeRef.current; const gateway = gatewayRef.current;
    if (!message || !sessionKey || !gateway || !scope || busy) return;
    const selection = selectionRef.current;
    setBusy(true); setInput(''); setEvents([]); setNotice('');
    setMessages(prev => [...prev, { role: 'user', content: message, createdAt: new Date().toISOString() }]);
    try { await gateway.request('submit_turn', { sessionKey, channelKey: 'web', message, projectKey }, event => { if (scope.active() && selectionRef.current === selection) setEvents(prev => [...prev, event]); }); if (scope.active() && selectionRef.current === selection) { const result = object(await gateway.request('read_session_messages', { sessionKey, projectKey })); if (scope.active() && selectionRef.current === selection && Array.isArray(result.messages)) setMessages(result.messages); } }
    catch (e) { if (scope.active() && selectionRef.current === selection) setNotice(errorMessage(e)); }
    finally { if (scope.active() && selectionRef.current === selection) setBusy(false); }
  }
  async function abort() { const scope = scopeRef.current; try { await gatewayRef.current?.request('abort_turn', { sessionKey }); if (scope?.active()) setNotice('已请求停止'); } catch (e) { if (scope?.active()) setNotice(errorMessage(e)); } }
  function save() {
    if (!editor) return;
    try { const parsed = parseConfig(editor); const next = editingId ? configs.map(c => c.id === editingId ? { ...parsed, id: editingId } : c) : [...configs, { ...parsed, id: crypto.randomUUID() }]; setConfigs(next); saveConfigs(next); const target = editingId || next[next.length - 1].id; if (target === id) setConnectionRevision(n => n + 1); else setId(target); setEditor(null); setEditingId(''); setDrawer(false); }
    catch (e) { setNotice(errorMessage(e)); }
  }
  function remove(c: Config) { if (!confirm(`删除实例「${c.name}」？`)) return; const next = configs.filter(x => x.id !== c.id); setConfigs(next); saveConfigs(next); if (id === c.id) setId(''); }
  function importConfig() {
    const raw = prompt('粘贴实例 JSON（name、rest、ws、mcp、notes；令牌请在表单内手动输入）'); if (!raw) return;
    try {
      const value: unknown = JSON.parse(raw);
      const items = Array.isArray(value) ? value : [value];
      if (!items.length) throw Error('没有可导入的实例');
      const imported = items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('每个实例必须是 JSON 对象');
        const data = item as Record<string, unknown>;
        const field = (key: string) => typeof data[key] === 'string' ? data[key] as string : '';
        return { ...parseConfig({ ...blank, name: field('name'), rest: field('rest'), ws: field('ws'), mcp: field('mcp'), notes: field('notes') }), id: crypto.randomUUID() };
      });
      const next = [...configs, ...imported]; saveConfigs(next); setConfigs(next);
      setNotice(`已导入 ${imported.length} 个实例；令牌未导入，请按需编辑配置`);
    } catch (e) { setNotice(errorMessage(e)); }
  }
  return <div className="app">
    <header className="top"><button className="icon mobile" aria-label="打开导航" onClick={() => setDrawer(true)}><Menu size={21}/></button><div className="brand"><span className="mark">P</span><div><strong>PilotDeck</strong><small>MOBILE CONSOLE</small></div></div><div className="top-right"><span className={'status ' + (status === '已连接' ? 'online' : '')}>{status === '已连接' ? <Wifi size={14}/> : <WifiOff size={14}/>} {status}</span><button className="icon" aria-label="实例设置" onClick={() => setDrawer(true)}><Settings2 size={20}/></button></div></header>
    <div className="layout"><aside className={'sidebar ' + (drawer ? 'open' : '')}><div className="side-head"><span>工作空间</span><button className="icon mobile" aria-label="关闭导航" onClick={() => setDrawer(false)}><X size={19}/></button></div>
      <div className="side-scroll"><div className="section-title">连接实例 <button className="mini" onClick={() => { setEditingId(''); setEditor(blank); }}>＋ 新建</button></div><select aria-label="选择实例" value={id} onChange={e => { if (e.target.value !== id) { scopeRef.current?.dispose(); selectionRef.current++; setGatewayState(null); setInput(''); setBusy(false); } setId(e.target.value); setDrawer(false); }}><option value="">选择实例</option>{configs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      {config && <div className="instance-tools"><button onClick={() => { setEditingId(config.id); setEditor(config); }}>编辑配置</button><button onClick={() => remove(config)}>删除</button></div>}
      <button className="import" onClick={importConfig}>导入实例 JSON</button>
      <div className="section-title">项目 <span>{projects.length}</span></div>{projects.map((p, i) => { const key = label(p, 'projectKey', 'key', 'id'); return <button className={'nav-row ' + (projectKey === key ? 'selected' : '')} key={key + i} onClick={() => void selectProject(key)}><span className="folder">⌁</span><span className="truncate">{label(p, 'name', 'displayName', 'projectKey', 'key')}</span></button>; })}
      {projectKey && <><div className="section-title">会话 <button className="mini" onClick={() => void newSession()}>＋ 新建</button></div>{sessions.map((s, i) => { const key = label(s, 'sessionKey', 'sessionId', 'key', 'id'); return <button className={'nav-row ' + (sessionKey === key ? 'selected' : '')} key={key + i} onClick={() => { void selectSession(key); setDrawer(false); }}><span className="session-dot"/><span className="truncate">{label(s, 'customTitle', 'aiTitle', 'summary', 'sessionKey', 'sessionId')}<small style={{ display: 'block' }}>{time(s.lastModified)}</small></span></button>; })}</>}
      </div><div className="side-foot">仅显示网关返回的真实数据</div></aside>{drawer && <button className="backdrop" aria-label="关闭导航" onClick={() => setDrawer(false)}/>}
      <main className="main"><div className="main-head"><div><div className="eyebrow">{config?.name || '未选择实例'} / {projectKey || '项目'}</div><h1>{tab === 'chat' ? sessionKey ? '会话' : '选择会话' : tabs.find(([key]) => key === tab)?.[1]}</h1></div><div className="head-actions">{sessionKey && tab === 'chat' && <button className="secondary" onClick={() => void selectSession(sessionKey)}><ArrowLeft size={15}/> 刷新记录</button>}</div></div>
      <nav className="tabs" aria-label="功能模块">{tabs.map(([key, name]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{name}</button>)}</nav>
      {tab !== 'chat' && tab !== 'mcp' && <nav className="tabs" aria-label="业务通道"><button className={businessChannel === 'ws' ? 'active' : ''} onClick={() => setBusinessChannel('ws')}>原生 Gateway WS</button><button className={businessChannel === 'rest' ? 'active' : ''} onClick={() => setBusinessChannel('rest')}>官方 UI REST（独立鉴权）</button></nav>}
      {notice && <div className="notice" role="alert">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
      {tab === 'chat' ? <div className="chat"><div className="feed">{!sessionKey ? <div className="empty"><div className="empty-icon"><CirclePlus size={26}/></div><h2>从真实会话开始</h2><p>{!config ? '添加实例并连接网关，开始浏览项目与会话。' : !projectKey ? '从左侧选择一个项目。' : '选择现有会话，或创建新会话。'}</p>{projectKey && <button className="primary" onClick={() => void newSession()}>创建会话</button>}</div> : <>{messages.length === 0 && events.length === 0 && <div className="empty compact"><h2>暂无消息</h2><p>发送消息后，事件将按网关原始内容展示。</p></div>}{messages.map((m, i) => { const record = object(m); const role = label(record, 'role', 'sender', 'type'); const body = record.content ?? record.text ?? m; return <article className={'message ' + (role === 'user' ? 'mine' : '')} key={i}><div className="message-meta">{role}{time(record.createdAt) && <time dateTime={text(record.createdAt)} style={{ marginLeft: 8 }}>{time(record.createdAt)} (Asia/Shanghai)</time>}</div><pre>{formatted(body)}</pre></article>; })}{events.length > 0 && <div className="stream"><div className="stream-title">实时事件 · 原始数据</div>{events.map((ev, i) => <article className="event" key={i}><small>#{ev.seq}{ev.final ? ' · 完成' : ''}</small><pre>{formatted(ev.event)}</pre></article>)}</div>}</>}</div><div className="composer"><textarea aria-label="发送消息" placeholder={sessionKey ? '向 PilotDeck 发送消息…' : '请先选择会话'} value={input} disabled={!sessionKey} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); } }}/><div className="compose-bottom"><small>Enter 发送 · Shift + Enter 换行</small>{busy ? <button className="stop" onClick={() => void abort()}><Square size={14}/> 停止</button> : <button className="primary" disabled={!sessionKey || !input.trim()} onClick={() => void send()}><Send size={15}/> 发送</button>}</div></div></div> : tab === 'mcp' ? <McpPanel key={`${id}:${config?.mcp ?? ''}:${config?.token ?? ''}`} instanceId={id} endpoint={config?.mcp ?? ''} token={config?.token ?? ''}/> : businessChannel === 'rest' ? <UiRestPanel key={`${id}:${tab}:${config?.rest ?? ''}`} module={tab} endpoint={config?.rest ?? ''} instanceId={id} projectKey={projectKey} sessionKey={sessionKey}/> : <NativePanel key={`${id}:${tab}`} module={tab as NativeModule} gateway={gatewayState?.identity === identity ? gatewayState.gateway : null} projectKey={projectKey} sessionKey={sessionKey}/>}</main></div>
    {editor && <div className="modal-layer" onMouseDown={e => { if (e.target === e.currentTarget) setEditor(null); }}><div className="modal" role="dialog" aria-modal="true" aria-label="实例配置"><div className="modal-head"><div><small>LOCAL CONNECTION</small><h2>{editingId ? '编辑实例' : '添加实例'}</h2></div><button className="icon" aria-label="关闭" onClick={() => setEditor(null)}><X size={20}/></button></div><div className="form"><label>实例名称<input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="例如：家中工作站"/></label><label>REST 地址<input value={editor.rest} onChange={e => setEditor({ ...editor, rest: e.target.value })} placeholder="https://host.example"/></label><label>WebSocket 地址<input value={editor.ws} onChange={e => setEditor({ ...editor, ws: e.target.value })} placeholder="wss://host.example/ws"/></label><label>MCP 地址 <span className="muted">选填 · 尚未连接</span><input value={editor.mcp} onChange={e => setEditor({ ...editor, mcp: e.target.value })} placeholder="https://host.example/mcp"/></label><label>访问令牌<input type="password" autoComplete="off" value={editor.token} onChange={e => setEditor({ ...editor, token: e.target.value })} placeholder="默认仅保留在当前页面内存"/></label><label className="check"><input type="checkbox" checked={editor.rememberToken} onChange={e => setEditor({ ...editor, rememberToken: e.target.checked })}/> 记住令牌（不推荐：明文保存于此浏览器 localStorage）</label><label>备注<textarea value={editor.notes} onChange={e => setEditor({ ...editor, notes: e.target.value })} placeholder="仅保存在此设备"/></label></div><div className="modal-footer"><button className="secondary" onClick={() => setEditor(null)}>取消</button><button className="primary" onClick={save}>保存实例</button></div></div></div>}
  </div>;
}
