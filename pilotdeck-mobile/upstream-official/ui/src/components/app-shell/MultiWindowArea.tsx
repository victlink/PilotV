import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, LayoutGrid, Maximize2, Minimize2, PanelLeftOpen, RefreshCw } from 'lucide-react';
import type { Project, ProjectSession } from '../../types/app';
import { decodeDeviceDefaults, type Device } from './deviceRegistry';
import { getPilotVRuntime } from './pilotvRuntime';
import { readPaneView } from './embedMode';
import {
  buildPaneUrl,
  layoutGridClass,
  readState,
  WINDOW_LAYOUTS,
  writeState,
  type MultiWindowState,
  type PaneConfig,
  type WindowLayout,
} from './multiWindow';

type Props = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  isEmbedded?: boolean;
  onBack?: () => void;
};


const SELECT_CLASS = 'h-6 max-w-[9rem] shrink-0 rounded border border-neutral-200 bg-white px-1 text-[11px] text-neutral-700 outline-none focus:border-indigo-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200';
const ICON_BUTTON_CLASS = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

function PaneToolbar({
  pane, index, devices, focused, onUpdate, onRefresh, onFocus, onPopout,
}: {
  pane: PaneConfig;
  index: number;
  devices: Device[];
  focused: boolean;
  onUpdate: (patch: Partial<PaneConfig>) => void;
  onRefresh: () => void;
  onFocus: () => void;
  onPopout: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-1.5 text-[11px] dark:border-neutral-800 dark:bg-neutral-900">
      <span className="shrink-0 tabular-nums text-neutral-400" aria-label={`窗口 ${index + 1}`}>{index + 1}</span>
      <select aria-label={`窗口 ${index + 1} 设备`} title="选择设备" className={SELECT_CLASS}
        value={pane.device} onChange={(event) => onUpdate({ device: event.target.value, sessionId: '', path: '/' })}>
        <option value="">当前设备</option>
        {devices.map((device) => <option key={device.origin} value={device.origin}>{device.name}</option>)}
      </select>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button type="button" aria-pressed={pane.sidebar}
          aria-label={pane.sidebar ? '隐藏此窗口侧栏' : '显示此窗口侧栏'}
          title="展开该设备自己的侧栏，可浏览它的项目与会话"
          onClick={() => onUpdate({ sidebar: !pane.sidebar })}
          className={`h-6 shrink-0 rounded border px-1.5 text-[11px] transition-colors ${pane.sidebar
            ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
            : 'border-neutral-200 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800'}`}>
          侧栏
        </button>
        <button type="button" className={ICON_BUTTON_CLASS} onClick={onRefresh} aria-label="刷新此窗口" title="刷新此窗口"><RefreshCw className="h-3.5 w-3.5" aria-hidden /></button>
        <button type="button" className={ICON_BUTTON_CLASS} onClick={onFocus} aria-label={focused ? '还原此窗口' : '放大此窗口'} title={focused ? '还原此窗口' : '放大此窗口'}>
          {focused ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
        </button>
        <button type="button" className={ICON_BUTTON_CLASS} onClick={onPopout} aria-label="弹出为独立窗口" title="弹出为独立浏览器窗口"><ExternalLink className="h-3.5 w-3.5" aria-hidden /></button>
      </div>
    </div>
  );
}

/**
 * 2 / 4 / 6 分屏工作区。
 *
 * 每个窗格是一个同源 iframe，靠 ?d= 让网关把请求转发到各自的后端设备，
 * 靠 ?embed=1 让里面的壳精简成纯工作区。登录令牌按设备分开存，所以不同
 * 设备的窗格可以同时保持登录，不会像单个标签页切换设备那样互相顶掉。
 *
 * 「对话 / 文件 / 成果台」不在父页做下拉：窗格里本来就有一列右侧悬浮按钮，
 * 切换结果由 iframe 自己记在 ?view= 上。父页只在必须重建 iframe（换设备、
 * 换会话、切侧栏、刷新、弹出）之前读一次该窗格当前的 view，再带回新地址。
 */
export default function MultiWindowArea({ selectedSession, isSidebarCollapsed, onOpenSidebar, isEmbedded = false, onBack }: Props) {
  const [state, setState] = useState<MultiWindowState>(readState);
  const [devices, setDevices] = useState<Device[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({});
  // Live toolbar values must not change the launch configuration used for iframe src/key.
  const [displayDevices, setDisplayDevices] = useState<Record<string, string>>({});
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const contexts = useRef<Record<string, Partial<PaneConfig>>>({});
  const [mountedCount, setMountedCount] = useState(state.layout);
  const runtime = getPilotVRuntime();
  const currentDevice = runtime?.backend ?? null;
  // 外层后续选中项不能驱动已打开窗格跳转。
  const currentSessionId = useRef(selectedSession?.id ?? null).current;
  const origin = window.location.origin;

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => { writeState({ ...state, panes: state.panes.map(pane => ({ ...pane, ...contexts.current[pane.id] })) }); }, [state]);
  useEffect(() => {
    const capture = (event: MessageEvent) => {
      if (event.origin !== origin || event.data?.type !== 'pilotv-pane-context') return;
      const id = Object.keys(frames.current).find(key => frames.current[key]?.contentWindow === event.source);
      if (id) capturePaneContext(id);
    };
    const save = () => Object.keys(frames.current).forEach(capturePaneContext);
    window.addEventListener('message', capture);
    window.addEventListener('pagehide', save);
    return () => { window.removeEventListener('message', capture); window.removeEventListener('pagehide', save); };
  }, [origin]);

  // 设备清单以网关同步到 dist 的 devices.json 为准；没部署时退回管理接口。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const source of ['/devices.json', '/api/pilotv/devices']) {
        try {
          const response = await fetch(source, { cache: 'no-store' });
          if (!response.ok) continue;
          const list = decodeDeviceDefaults(await response.json());
          if (!cancelled && list.length) { setDevices(list); return; }
        } catch { /* 试下一个来源 */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const livePaneContext = (id: string): Partial<PaneConfig> | null => {
    try {
      const href = frames.current[id]?.contentWindow?.location.href;
      if (!href) return null;
      const url = new URL(href, origin);
      if (url.origin !== origin || !url.searchParams.has('window')) return null;
      return { path: url.pathname, view: readPaneView(url.search), device: url.searchParams.get('d') || currentDevice || '' };
    } catch { return null; }
  };
  const capturePaneContext = (id: string) => {
    const context = livePaneContext(id);
    if (context) {
      contexts.current[id] = context;
      setDisplayDevices(previous => previous[id] === context.device ? previous : { ...previous, [id]: context.device ?? '' });
      // 启动配置保持不变；同步工具条与存储不应改变 iframe src。
      writeState({ ...stateRef.current, panes: stateRef.current.panes.map(pane => ({ ...pane, ...contexts.current[pane.id] })) });
    }
  };

  const updatePane = (id: string, patch: Partial<PaneConfig>) => {
    capturePaneContext(id);
    contexts.current[id] = { ...contexts.current[id], ...patch };
    if (patch.device !== undefined) setDisplayDevices(previous => ({ ...previous, [id]: patch.device! }));
    setState((previous) => ({
      ...previous,
      panes: previous.panes.map((pane) => (pane.id === id ? { ...pane, ...contexts.current[id], ...patch } : pane)),
    }));
  };
  const setLayout = (layout: WindowLayout) => { setMountedCount(previous => Math.max(previous, layout) as WindowLayout); setState((previous) => ({ ...previous, layout })); setFocused(null); };
  const refresh = (id: string) => { capturePaneContext(id); setState(previous => ({ ...previous, panes: previous.panes.map(pane => pane.id === id ? { ...pane, ...contexts.current[id] } : pane) })); setReloadTokens((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 })); };
  const paneUrl = (pane: PaneConfig, embed: boolean) => buildPaneUrl(pane, {
    origin,
    currentDevice,
    currentSessionId,
    embed,
    view: pane.view ?? null,
  });
  const popout = (pane: PaneConfig) => {
    capturePaneContext(pane.id);
    const context = { ...pane, ...contexts.current[pane.id], id: `popup-${crypto.randomUUID()}` };
    const url = buildPaneUrl(context, { origin, currentDevice, currentSessionId, embed: false });
    window.open(url, '_blank', 'popup,noopener,noreferrer');
  };

  const visible = state.panes.slice(0, mountedCount);

  return (
    <div className="pd-workspace-content flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="workspace-header relative z-[80] shrink-0 overflow-visible">
        {isSidebarCollapsed && !isEmbedded ? (
          <button type="button" onClick={onOpenSidebar} aria-label="展开侧栏" title="展开侧栏"
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="workspace-title flex min-w-0 flex-1 items-center gap-2">
          <LayoutGrid className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
          <h1 className="shrink-0 text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50">多窗口</h1>
          <span className="hidden shrink-0 text-[11px] text-neutral-400 sm:inline">布局、设备与会话自动保存；用每个窗口右侧的悬浮按钮切换对话 / 文件 / 成果台</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {WINDOW_LAYOUTS.map((layout) => (
              <button key={layout} type="button" aria-pressed={state.layout === layout} aria-label={`${layout} 窗口布局`} title={`${layout} 窗口布局`}
                onClick={() => setLayout(layout)}
                className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors ${state.layout === layout
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
                  : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}>
                {layout} 窗
              </button>
            ))}
            {focused ? (
              <button type="button" onClick={() => setFocused(null)} aria-label="取消放大" title="取消放大"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800">
                <Minimize2 className="h-3.5 w-3.5" aria-hidden />还原
              </button>
            ) : null}
            {onBack ? (
              <button type="button" onClick={onBack} aria-label="返回对话" title="返回对话"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800">
                <ArrowLeft className="h-4 w-4" aria-hidden />返回对话
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <div className={`grid min-h-0 flex-1 gap-1.5 bg-neutral-100 p-1.5 dark:bg-neutral-900 ${layoutGridClass(state.layout, Boolean(focused))}`}>
        {visible.map((pane) => {
          const index = state.panes.findIndex((item) => item.id === pane.id);
          const url = paneUrl(pane, true);
          return (
            <section key={pane.id} aria-label={`窗口 ${index + 1}`}
              hidden={focused ? pane.id !== focused : index >= state.layout}
              style={{ display: (focused ? pane.id !== focused : index >= state.layout) ? 'none' : undefined }}
              className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
              <PaneToolbar pane={{ ...pane, device: displayDevices[pane.id] ?? pane.device }} index={index} devices={devices}
                focused={focused === pane.id}
                onUpdate={(patch) => updatePane(pane.id, patch)}
                onRefresh={() => refresh(pane.id)}
                onFocus={() => setFocused((previous) => previous === pane.id ? null : pane.id)}
                onPopout={() => popout(pane)} />
              <div className="min-h-0 flex-1">
                <iframe ref={(node) => { frames.current[pane.id] = node; }}
                  onLoad={() => capturePaneContext(pane.id)}
                  key={`${pane.id}:${url}:${reloadTokens[pane.id] ?? 0}`} src={url} title={`窗口 ${index + 1}`}
                  className="h-full w-full border-0 bg-white dark:bg-neutral-950" />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
