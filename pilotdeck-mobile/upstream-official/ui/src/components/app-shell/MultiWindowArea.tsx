import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, LayoutGrid, Maximize2, Minimize2, PanelLeftOpen, RefreshCw } from 'lucide-react';
import type { Project, ProjectSession } from '../../types/app';
import { projectDisplayName, sessionDisplayTitle } from '../../lib/customNames';
import { decodeDeviceDefaults, type Device } from './deviceRegistry';
import { getPilotVRuntime } from './pilotvRuntime';
import {
  buildPaneUrl,
  layoutGridClass,
  readState,
  WINDOW_LAYOUTS,
  writeState,
  type MultiWindowState,
  type PaneConfig,
  type PaneView,
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

type SessionOption = { value: string; label: string };

const VIEW_OPTIONS: { value: PaneView; label: string }[] = [
  { value: 'home', label: '设备首页' },
  { value: 'session', label: '对话' },
  { value: 'artifacts', label: '成果台' },
  { value: 'custom', label: '自定义路径' },
];

const SELECT_CLASS = 'h-6 max-w-[9rem] shrink-0 rounded border border-neutral-200 bg-white px-1 text-[11px] text-neutral-700 outline-none focus:border-indigo-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200';
const ICON_BUTTON_CLASS = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

function PaneToolbar({
  pane, index, devices, sessionOptions, focused, onUpdate, onRefresh, onFocus, onPopout,
}: {
  pane: PaneConfig;
  index: number;
  devices: Device[];
  sessionOptions: SessionOption[];
  focused: boolean;
  onUpdate: (patch: Partial<PaneConfig>) => void;
  onRefresh: () => void;
  onFocus: () => void;
  onPopout: () => void;
}) {
  const needsSession = pane.view === 'session' || pane.view === 'artifacts';
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-1.5 text-[11px] dark:border-neutral-800 dark:bg-neutral-900">
      <span className="shrink-0 tabular-nums text-neutral-400" aria-label={`窗口 ${index + 1}`}>{index + 1}</span>
      <select aria-label={`窗口 ${index + 1} 设备`} title="选择设备" className={SELECT_CLASS}
        value={pane.device} onChange={(event) => onUpdate({ device: event.target.value })}>
        <option value="">当前设备</option>
        {devices.map((device) => <option key={device.origin} value={device.origin}>{device.name}</option>)}
      </select>
      <select aria-label={`窗口 ${index + 1} 内容`} title="选择显示内容" className={SELECT_CLASS}
        value={pane.view} onChange={(event) => onUpdate({ view: event.target.value as PaneView })}>
        {VIEW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {needsSession ? (
        <select aria-label={`窗口 ${index + 1} 会话`} title="选择会话" className={SELECT_CLASS}
          value={pane.sessionId} onChange={(event) => onUpdate({ sessionId: event.target.value })}>
          <option value="">当前对话</option>
          {sessionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : null}
      {pane.view === 'custom' ? (
        <input aria-label={`窗口 ${index + 1} 路径`} title="站内路径，例如 /p/我的项目" placeholder="/p/我的项目"
          value={pane.path} onChange={(event) => onUpdate({ path: event.target.value })}
          className="h-6 w-32 shrink-0 rounded border border-neutral-200 bg-white px-1.5 text-[11px] outline-none focus:border-indigo-400 dark:border-neutral-700 dark:bg-neutral-900" />
      ) : null}
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
 */
export default function MultiWindowArea({ projects, selectedSession, isSidebarCollapsed, onOpenSidebar, isEmbedded = false, onBack }: Props) {
  const [state, setState] = useState<MultiWindowState>(readState);
  const [devices, setDevices] = useState<Device[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({});
  const runtime = getPilotVRuntime();
  const currentDevice = runtime?.backend ?? null;
  const currentSessionId = selectedSession?.id ?? null;
  const origin = window.location.origin;

  useEffect(() => { writeState(state); }, [state]);

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

  const sessionOptions = useMemo<SessionOption[]>(() => projects.flatMap((project) =>
    (project.sessions ?? []).map((session) => ({
      value: session.id,
      label: `${projectDisplayName(project)} / ${sessionDisplayTitle(session)}`,
    }))), [projects]);

  const updatePane = (id: string, patch: Partial<PaneConfig>) => {
    setState((previous) => ({
      ...previous,
      panes: previous.panes.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane)),
    }));
  };
  const setLayout = (layout: WindowLayout) => { setState((previous) => ({ ...previous, layout })); setFocused(null); };
  const refresh = (id: string) => setReloadTokens((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
  const paneUrl = (pane: PaneConfig, embed: boolean) => buildPaneUrl(pane, {
    origin,
    currentDevice,
    currentSessionId,
    embed,
  });
  const popout = (pane: PaneConfig) => {
    window.open(paneUrl(pane, false), '_blank', 'noopener,noreferrer');
  };

  const visible = focused
    ? state.panes.filter((pane) => pane.id === focused)
    : state.panes.slice(0, state.layout);

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
          <span className="hidden shrink-0 text-[11px] text-neutral-400 sm:inline">布局与每台窗口的设备、会话会自动保存</span>
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
              className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
              <PaneToolbar pane={pane} index={index} devices={devices} sessionOptions={sessionOptions}
                focused={focused === pane.id}
                onUpdate={(patch) => updatePane(pane.id, patch)}
                onRefresh={() => refresh(pane.id)}
                onFocus={() => setFocused((previous) => previous === pane.id ? null : pane.id)}
                onPopout={() => popout(pane)} />
              <div className="min-h-0 flex-1">
                <iframe key={`${pane.id}:${url}:${reloadTokens[pane.id] ?? 0}`} src={url} title={`窗口 ${index + 1}`}
                  className="h-full w-full border-0 bg-white dark:bg-neutral-950" />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
