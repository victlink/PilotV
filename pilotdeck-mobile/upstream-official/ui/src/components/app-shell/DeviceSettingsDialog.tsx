import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { validateDevice, type Device } from './deviceRegistry';

type Draft = { origin: string | null; name: string; address: string };

export type DeviceSettingsDialogProps = {
  devices: Device[];
  /** 来自 devices.json 的地址，用来在列表里标注「预置」。 */
  presetOrigins?: readonly string[];
  /** 打开时的初始形态：新增空白表单，或把某台设备载入表单改名/改地址。 */
  mode?: 'add' | 'edit';
  origin?: string;
  onClose: () => void;
  /** 保存时服务端没接受这次改动的原因。一路传到窗口里显示，窗口不关。 */
  commitError?: string;
  /** 提交整份列表；同时带上本次被移除的地址，供调用方写入「已删除预置」记录。 */
  onCommit: (devices: Device[], removedOrigins: string[]) => void;
};

/** 就地替换：保持原位置；地址被改掉时按 origin 去重，旧的自动让位。 */
function upsert(list: Device[], previousOrigin: string | null, device: Device): Device[] {
  if (!previousOrigin) return [...list, device];
  const next = [...list];
  const index = next.findIndex(item => item.origin === previousOrigin);
  if (index >= 0) next[index] = device; else next.push(device);
  return next.filter((item, position) => next.findIndex(other => other.origin === item.origin) === position);
}

/**
 * 独立的设备设置悬浮窗：新增、改名、改地址、删除都只改本机列表。
 * 打开与取消都不改变当前选择，也不会跳转页面；删除二次确认后立即生效，
 * 新增与改名则等点「保存设备」才提交，避免误触。
 */
export default function DeviceSettingsDialog({ devices, presetOrigins, mode = 'add', origin, onClose, commitError = '', onCommit }: DeviceSettingsDialogProps) {
  const titleId = useId();
  const hintId = useId();
  const panel = useRef<HTMLElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft>(() => {
    const target = mode === 'edit' ? devices.find(device => device.origin === origin) : undefined;
    return target ? { origin: target.origin, name: target.name, address: target.origin } : { origin: null, name: '', address: '' };
  });
  const [error, setError] = useState('');
  // 窗口留着的唯一理由就是上一次没存上，所以这条原因必须一直挂在窗口上：
  // 用户正是要照着它改完再存一次，中途把它撤掉等于重新变回「保存了但没变」。
  // 本地校验的错排前面——那是这一下输入的问题，比上一次的保存失败更要紧。
  const message = error || commitError;

  // onClose 是父组件传的内联箭头，每次渲染都是新函数。要是把它放进下面那个
  // effect 的依赖里，上层每收到一条推送重渲染一次，这个 effect 就重跑一轮：
  // 清理时先把焦点还给「设备设置」按钮，再抢回「设备名称」。两下一折腾，
  // 正在合成的中文被强行打断，候选窗反复弹起——就是「输入法键盘跳来跳去」。
  // 所以焦点只在挂载时安排一次，之后按键处理统一走这个 ref 拿最新的 onClose。
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameField.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (!panel.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); if (previous?.isConnected) previous.focus(); };
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const device = validateDevice(draft.name, draft.address);
      const dropped = draft.origin && draft.origin !== device.origin ? [draft.origin] : [];
      onCommit(upsert(devices, draft.origin, device), dropped);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '配置无效');
    }
  }

  function remove(target: Device) {
    if (!window.confirm(`删除设备配置“${target.name}”？不会删除后端数据。`)) return;
    onCommit(devices.filter(device => device.origin !== target.origin), [target.origin]);
  }

  const presets = new Set(presetOrigins ?? []);
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" data-dialog-backdrop onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId}
        className="pd-device-settings flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl">
        <header className="flex items-start gap-3 px-5 pb-3 pt-5">
          <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">设备设置</h2>
          <button type="button" onClick={onClose} aria-label="关闭设备设置" className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 text-sm">
          <ul className="flex flex-col gap-1.5">
            {devices.map(device => <li key={device.origin} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{device.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{device.origin}</span>
              </span>
              {presets.has(device.origin) && <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">预置</span>}
              <button type="button" aria-label={`编辑设备 ${device.name}`} title="改名或改地址" onClick={() => { setDraft({ origin: device.origin, name: device.name, address: device.origin }); setError(''); nameField.current?.focus(); }} className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="h-4 w-4" /></button>
              <button type="button" aria-label={`删除设备 ${device.name}`} title="删除配置" onClick={() => remove(device)} className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
            </li>)}
            {!devices.length && <li className="rounded-md border border-dashed border-border px-3 py-4 text-center text-muted-foreground">还没有设备，用下方表单添加一台。</li>}
          </ul>

          <form id="pd-device-settings-form" aria-label="设备配置表单" onSubmit={submit} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              设备名称
              <input ref={nameField} aria-label="设备名称" required maxLength={80} placeholder="例如 marc-linux-pc" value={draft.name}
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pd-accent,#5b5ce2)]" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              官方 UI 地址
              <input aria-label="官方 UI 地址" type="url" required placeholder="http://100.x.x.x:3001/" value={draft.address}
                onChange={event => setDraft(current => ({ ...current, address: event.target.value }))}
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pd-accent,#5b5ce2)]" />
            </label>
            {draft.origin && <p className="text-xs text-muted-foreground">正在修改已存在的设备；名称可随意自定义，地址填官方 UI 根地址。</p>}
            {message && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-destructive">{message}</p>}
          </form>
          <p id={hintId} className="mt-3 text-xs text-muted-foreground">仅本浏览器保存名称与地址，不保存密码或 Token。切换设备会打开目标网页并使用其独立登录态。</p>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button type="button" onClick={() => { setDraft({ origin: null, name: '', address: '' }); setError(''); nameField.current?.focus(); }}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent"><Plus className="h-4 w-4" />新增</button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="h-9 shrink-0 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent">取消</button>
            <button type="submit" form="pd-device-settings-form"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-[var(--pd-accent,#5b5ce2)] px-3 py-2 text-sm font-medium text-white enabled:hover:bg-[var(--pd-accent-strong,#4948cf)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pd-accent,#5b5ce2)]">
              保存设备
            </button>
          </div>
        </footer>
      </section>
    </div>, document.body,
  );
}
