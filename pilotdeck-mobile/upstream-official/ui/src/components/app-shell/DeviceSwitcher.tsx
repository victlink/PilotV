import { useEffect, useState } from 'react';
import {
  DEVICE_DEFAULTS_URL,
  DEVICE_HIDDEN_KEY,
  DEVICE_KEY,
  decodeDeviceDefaults,
  decodeDevices,
  decodeHiddenOrigins,
  mergeDeviceDefaults,
  mergeDevices,
  parseDeviceImport,
  validateDevice,
  type Device,
} from './deviceRegistry';

function safeRead(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function safeWrite(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* 存储不可用则忽略 */ } }

export default function DeviceSwitcher({ compact }: { compact: boolean }) {
  const current = window.location.origin;
  const [devices, setDevices] = useState<Device[]>(() => {
    try { return decodeDevices(safeRead(DEVICE_KEY)); } catch { return []; }
  });
  // 预置设备来自随构建发布的 devices.json：换台机器打开也能看到同一批设备，
  // 不再依赖每个浏览器手工录入一次。拉取失败就退回纯本地列表。
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    fetch(DEVICE_DEFAULTS_URL, { cache: 'no-store', signal: controller.signal })
      .then(response => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled || !payload) return;
        const defaults = decodeDeviceDefaults(payload);
        if (!defaults.length) return;
        setDevices(currentDevices => {
          const hidden = decodeHiddenOrigins(safeRead(DEVICE_HIDDEN_KEY));
          const merged = mergeDeviceDefaults(currentDevices, defaults, hidden);
          safeWrite(DEVICE_KEY, JSON.stringify(merged));
          return merged;
        });
      })
      .catch(() => { /* 离线或未部署该文件：用本机列表即可 */ });
    return () => { cancelled = true; controller.abort(); };
  }, []);

  // 一次性设备导入：?addDevice=… 只写这台浏览器本地，写完就把参数抹掉，
  // 刷新后不会重复导入，也不会把地址留在地址栏或历史记录里。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('addDevice');
    if (!raw) return;
    const incoming = parseDeviceImport(raw);
    if (incoming.length) {
      const merged = mergeDevices(devices, incoming);
      try { localStorage.setItem(DEVICE_KEY, JSON.stringify(merged)); setDevices(merged); setError(''); } catch { /* 只读存储则忽略 */ }
    }
    params.delete('addDevice');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  }, [devices]);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const options = devices.some(d => d.origin === current) ? devices : [{ name: '当前设备', origin: current }, ...devices];
  function persist(next: Device[]) {
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(next)); setDevices(next); setError(''); return true; }
    catch { setError('浏览器无法保存配置，请检查存储权限'); return false; }
  }
  return <div style={{ padding: compact ? '4px' : '8px 12px', flexShrink: 0, minWidth: 0 }}>
    <div style={{ position: 'relative', width: '100%' }}>
      <select aria-label="选择设备" value={current} style={{ appearance: 'none', width: '100%', minWidth: 0, height: 44, padding: '0 32px 0 12px', fontSize: 13, fontWeight: 500, lineHeight: '20px', textOverflow: 'ellipsis', borderRadius: 8, background: 'transparent', color: 'inherit', border: '1px solid var(--border, #8884)', cursor: 'pointer' }} onChange={e => {
        const destination = e.target.value;
        // Restore the current device for actions and cancelled navigation alike.
        e.currentTarget.value = current;
        if (destination === '__add_device__') { setOpen(true); setError(''); return; }
        if (destination !== current && window.confirm('将打开所选设备的官方页面，当前未发送的内容不会转移。继续？')) window.location.assign(destination + '/');
      }}>
        {options.map(d => <option key={d.origin} value={d.origin}>{d.name}</option>)}
        <option value="__add_device__">＋ 增加设备</option>
      </select>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ position: 'absolute', right: 12, top: 15, pointerEvents: 'none', opacity: 0.6 }}><path d="m6 9 6 6 6-6" /></svg>
    </div>
    {open && <form aria-label="增加设备表单" onSubmit={e => {
      e.preventDefault();
      try {
        const device = validateDevice(name, address);
        if (persist([...devices.filter(d => d.origin !== device.origin), device])) { setName(''); setAddress(''); setOpen(false); }
      } catch (failure) { setError(failure instanceof Error ? failure.message : '配置无效'); }
    }} style={{ display: 'grid', gap: 8, marginTop: 8, overflowWrap: 'anywhere' }}>
      <label>设备名称<input aria-label="设备名称" required maxLength={80} value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', color: 'inherit', background: 'transparent', border: '1px solid var(--border)', padding: 6 }} /></label>
      <label>官方 UI 地址<input aria-label="官方 UI 地址" type="url" required placeholder="http://100.x.x.x:3001/" value={address} onChange={e => setAddress(e.target.value)} style={{ width: '100%', color: 'inherit', background: 'transparent', border: '1px solid var(--border)', padding: 6 }} /></label>
      <p style={{ fontSize: 12 }}>仅本浏览器保存名称与地址。切换会打开目标网页并使用其独立登录态；设备列表不会自动同步至另一地址。HTTP 仅建议用于可信网络。</p>
      <div style={{ display: 'flex', gap: 8, fontSize: 13 }}><button type="submit" style={{ minHeight: 44, flex: 1 }}>保存设备</button><button type="button" style={{ minHeight: 44 }} onClick={() => { setOpen(false); setError(''); }}>取消</button></div>
      {devices.map(d => <div key={d.origin} style={{ display: 'flex', gap: 4, minWidth: 0 }}><span style={{ flex: 1 }}>{d.name}</span><button type="button" aria-label={`删除设备 ${d.name}`} onClick={() => { if (window.confirm(`删除设备配置“${d.name}”？不会删除后端数据。`)) {
          const hidden = decodeHiddenOrigins(safeRead(DEVICE_HIDDEN_KEY));
          if (!hidden.includes(d.origin)) safeWrite(DEVICE_HIDDEN_KEY, JSON.stringify([...hidden, d.origin]));
          persist(devices.filter(item => item.origin !== d.origin));
        } }}>删除</button></div>)}
    </form>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
