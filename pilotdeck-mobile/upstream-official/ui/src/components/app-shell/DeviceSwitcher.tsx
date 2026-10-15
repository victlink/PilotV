import { useEffect, useRef, useState } from 'react';
import DeviceSettingsDialog from './DeviceSettingsDialog';
import { getPilotVRuntime, switchBackend } from './pilotvRuntime';
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
  type Device,
} from './deviceRegistry';
import { deleteServerDevice, diffDeviceChanges, fetchServerDevices, saveServerDevice } from './deviceApi';

function safeRead(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function safeWrite(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* 存储不可用则忽略 */ } }

/**
 * 服务端回给我们的清单里，必须真的带着这次要保存的每一台设备，且名字一致。
 *
 * 以前只判断「请求没报错」就算成功：网关把改名记下了却没让清单生效时，它照样回 200，
 * 于是窗口照关、名字纹丝不动，用户只会得到一句「保存不了」，连失败的原因都看不到。
 * 这份清单是服务端说的真话，跟它对一遍才能知道到底存没存上。
 */
function unappliedDevices(updated: Device[], next: Device[], removedOrigins: string[]): Device[] {
  const gone = new Set(removedOrigins);
  const byOrigin = new Map(updated.map(device => [device.origin, device.name]));
  return next.filter(device => !gone.has(device.origin) && byOrigin.get(device.origin) !== device.name);
}

export default function DeviceSwitcher({ compact }: { compact: boolean }) {
  const runtime = getPilotVRuntime();
  // 网关决定当前实际连的是哪台后端；没有网关时退回页面自身的 origin。
  const current = runtime?.backend || window.location.origin;
  const localDevice = { name: runtime?.defaultName || '当前设备', origin: runtime?.defaultBackend || window.location.origin };
  const [devices, setDevices] = useState<Device[]>(() => {
    try { return decodeDevices(safeRead(DEVICE_KEY)); } catch { return []; }
  });
  const [presetOrigins, setPresetOrigins] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ mode: 'add' | 'edit'; origin?: string } | null>(null);
  const [error, setError] = useState('');
  // 上一次保存被服务端拒绝的原因。显示在设置窗口里，所以窗口不能关。
  const [commitError, setCommitError] = useState('');
  // 齿轮按钮取消后，关闭设置窗口时把焦点还回设备下拉，别把人丢在文档开头。
  const selectRef = useRef<HTMLSelectElement>(null);
  const restoreFocus = () => selectRef.current?.focus();
  // 设备清单以网关那份为准：在设置窗口里加的设备、改的名字，换个浏览器打开也看得见。
  // 服务端拿不到（没部署网关、直接开 vite preview）时，才退回预置清单加本地存储。
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // 串行，不是并行：两个请求一起发的话，谁后回来谁说了算，删掉的设备
    // 会被慢一步的预置清单复活。服务端问到了就到此为止，不再去拉预置。
    (async () => {
      const list = await fetchServerDevices(controller.signal).catch(() => null);
      if (cancelled) return;
      if (list) {
        setDevices(list.devices);
        setPresetOrigins(list.devices.map(device => device.origin));
        safeWrite(DEVICE_KEY, JSON.stringify(list.devices));
        return;
      }
      const response = await fetch(DEVICE_DEFAULTS_URL, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(String(response.status));
      const defaults = decodeDeviceDefaults(await response.json());
      if (cancelled || !defaults.length) return;
      const hidden = decodeHiddenOrigins(safeRead(DEVICE_HIDDEN_KEY));
      const merged = mergeDeviceDefaults(devices, defaults, hidden);
      setPresetOrigins(defaults.map(device => device.origin));
      setDevices(merged);
      safeWrite(DEVICE_KEY, JSON.stringify(merged));
    })().catch(() => { /* 两边都拿不到就先用本地缓存 */ });
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

  // 本机自己永远要在列表里：否则切到别的设备之后就再也切不回来了。
  const withLocal = devices.some(d => d.origin === localDevice.origin) ? devices : [localDevice, ...devices];
  // 网关认得但本地没登记的设备（比如服务端新增的）也要能选中，不能让它凭空消失。
  const options = withLocal.some(d => d.origin === current)
    ? withLocal
    : [{ name: runtime?.device?.name || current, origin: current }, ...withLocal];
  // 网关不认识的设备会被静默回落，这里必须让人看见自己其实没切过去。
  const staleDevice = Boolean(runtime?.unknownDevice) && !devices.some(d => d.origin === current);
  function persistLocal(next: Device[], removedOrigins: string[]) {
    const hidden = decodeHiddenOrigins(safeRead(DEVICE_HIDDEN_KEY));
    const mergedHidden = [...hidden, ...removedOrigins.filter(origin => !hidden.includes(origin))];
    safeWrite(DEVICE_HIDDEN_KEY, JSON.stringify(mergedHidden));
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(next)); setDevices(next); setError(''); setCommitError(''); setDialog(null); restoreFocus(); return true; }
    catch { setError('浏览器无法保存配置，请检查存储权限'); return false; }
  }

  // 保存走服务端，这样别的浏览器、别的标签页打开时看到的是同一份清单。
  // 网关拒绝了就把它的原话显示出来——静默存到本地只会让人以为改成功了，
  // 切过去才发现根本没切走。
  async function persist(next: Device[], removedOrigins: string[]) {
    const changes = diffDeviceChanges(devices, next);
    const targets = [
      ...changes.changed.map(device => () => saveServerDevice(device)),
      ...[...changes.removed, ...removedOrigins].map(origin => () => deleteServerDevice(origin)),
    ];
    let updated: Device[] | null = null;
    for (const call of targets) {
      const result = await call();
      if (result.ok) { updated = result.devices; continue; }
      if (!result.missing) { setCommitError(result.error); return false; }
      // 这个网关没有管理接口：退回纯本地保存，功能不至于瘫掉。
      return persistLocal(next, removedOrigins);
    }
    if (!updated) return persistLocal(next, removedOrigins);
    // 拒绝了只是开头。服务端要是把这次改动吞了（清单里没有、或还是旧名字），
    // 窗口必须留着，并把这几台点名，不然用户只会看到「保存了但没变」。
    const missed = unappliedDevices(updated, next, removedOrigins);
    if (missed.length) {
      setCommitError(`网关没有接受这次改动：${missed.map(device => `${device.name}（${device.origin}）`).join('、')}。设置窗口保持打开，可以改完再存一次。`);
      return false;
    }
    safeWrite(DEVICE_KEY, JSON.stringify(updated));
    setDevices(updated);
    setError('');
    setCommitError('');
    setDialog(null);
    restoreFocus();
    return true;
  }
  return <div style={{ padding: compact ? '4px' : '8px 12px', flexShrink: 0, minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <select ref={selectRef} aria-label="选择设备" value={current} style={{ appearance: 'none', width: '100%', minWidth: 0, height: 44, padding: '0 32px 0 12px', fontSize: 13, fontWeight: 500, lineHeight: '20px', textOverflow: 'ellipsis', borderRadius: 8, background: 'transparent', color: 'inherit', border: '1px solid var(--border, #8884)', cursor: 'pointer' }} onChange={e => {
          const destination = e.target.value;
          // Restore the current device for actions and cancelled navigation alike.
          e.currentTarget.value = current;
          if (destination === '__add_device__') { setDialog({ mode: 'add' }); setError(''); setCommitError(''); return; }
          if (destination === '__device_settings__') { setDialog({ mode: 'add' }); setError(''); setCommitError(''); return; }
          // 切换的是后端，不是页面：仍留在 PilotV 这个入口，只把 ?d= 换成目标设备。
          // 页面会重新加载，未发送的内容不会带过去，所以先问一句。
          if (destination === current) return;
          if (window.confirm(`切换到「${options.find(d => d.origin === destination)?.name || destination}」的后端？页面会重新加载，未发送的内容不会带过去。`)) {
            switchBackend(destination);
          }
        }}>
          {options.map(d => <option key={d.origin} value={d.origin}>{d.name}</option>)}
          <option value="__add_device__">＋ 增加设备</option>
          {/* 设备设置是设备列表的最后一项，而不是旁边的另一个按键：
              手机上这一行本来就窄，再挂一个 44px 的齿轮会把设备名挤没。 */}
          <option value="__device_settings__">设备设置…</option>
        </select>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ position: 'absolute', right: 12, top: 15, pointerEvents: 'none', opacity: 0.6 }}><path d="m6 9 6 6 6-6" /></svg>
      </div>
    </div>
    {error && <p role="alert" style={{ fontSize: 12, marginTop: 6 }}>{error}</p>}
    {staleDevice && <p role="alert" style={{ fontSize: 12, marginTop: 6 }}>这台设备不在服务端允许的清单里，已回落到当前设备。</p>}
    {dialog && <DeviceSettingsDialog devices={devices} presetOrigins={presetOrigins} mode={dialog.mode} origin={dialog.origin}
      commitError={commitError}
      onClose={() => { setDialog(null); setCommitError(''); restoreFocus(); }}
      onCommit={persist} />}
  </div>;
}