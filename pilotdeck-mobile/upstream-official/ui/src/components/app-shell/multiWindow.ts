// 多窗口工作区的纯逻辑：布局、窗格配置、iframe URL 构造。
//
// 之所以把这部分单独放一个文件，是因为 URL 里有几个容易静默出错的约定：
//  1. 每个 iframe 必须显式带 ?d=。网关把设备记在 Cookie 里，而 Cookie 是
//     整个浏览器共享的；多个窗格同时连不同设备时，后加载的那个会覆盖前一个。
//     显式 query 的优先级高于 Cookie，且窗格内注入的 X-PilotV-Device 头也
//     跟着各自的 runtime 走，这才真正做到互不干扰。
//  2. 每个 iframe 带 ?embed=1，让里面的壳隐藏侧栏和多窗口入口，否则 1/6
//     屏塞一整套导航，也会无限嵌套出新的多窗口页。
//  3. 登录令牌按后端 origin 分开存（deviceTokens.ts），runtime 来自网关注入，
//     所以不同设备的窗格各自用自己的令牌，不会互相顶掉登录态。
//  4. 不再由父页决定每格显示「对话 / 文件 / 成果台」：窗格内本来就有右侧
//     悬浮按钮，用户直接在那儿切。父页只负责设备、会话、侧栏和布局，视图
//     由 iframe 自己的 ?view= 记住；父页重建 iframe 时把这个参数带过去。
// 这些约定值得有单元测试盯着，不要塞进组件里。

import type { PaneView } from './embedMode';

export type WindowLayout = 2 | 4 | 6;
export const WINDOW_LAYOUTS: readonly WindowLayout[] = [2, 4, 6];
export const MAX_PANES = 6;
export const MULTI_WINDOW_STORAGE_KEY = 'pilotv-multi-window-v1';

export interface PaneConfig {
  id: string;
  /** 后端 origin；空串表示跟随顶层页面当前设备。 */
  device: string;
  /** 空串表示「当前对话」，由调用方把 currentSessionId 补进来。 */
  sessionId: string;
  /** 是否在这个窗格里展开该设备自己的侧栏（用于挑它的会话）。 */
  sidebar: boolean;
}

export interface MultiWindowState {
  layout: WindowLayout;
  panes: PaneConfig[];
}

export function defaultPane(index: number): PaneConfig {
  return { id: `pane-${index + 1}`, device: '', sessionId: '', sidebar: false };
}

export function defaultState(): MultiWindowState {
  return {
    layout: 2,
    panes: Array.from({ length: MAX_PANES }, (_, index) => defaultPane(index)),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 读回本地配置时逐项校验：坏数据不能让整个工作区白屏。旧版的 view/path 字段会被忽略。 */
export function normalizeState(raw: unknown): MultiWindowState {
  const fallback = defaultState();
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Partial<MultiWindowState>;
  const layout = WINDOW_LAYOUTS.includes(value.layout as WindowLayout)
    ? value.layout as WindowLayout
    : fallback.layout;
  const stored = Array.isArray(value.panes) ? value.panes : [];
  const panes = Array.from({ length: MAX_PANES }, (_, index) => {
    const base = fallback.panes[index];
    const item = stored[index];
    if (!item || typeof item !== 'object') return base;
    const pane = item as Partial<PaneConfig>;
    const device = asString(pane.device).trim();
    return {
      id: base.id,
      device: /^https?:\/\//i.test(device) ? device.replace(/\/$/, '') : '',
      sessionId: asString(pane.sessionId).trim(),
      sidebar: pane.sidebar === true,
    };
  });
  return { layout, panes };
}

export function readState(): MultiWindowState {
  try { return normalizeState(JSON.parse(localStorage.getItem(MULTI_WINDOW_STORAGE_KEY) || 'null')); }
  catch { return defaultState(); }
}

export function writeState(state: MultiWindowState): void {
  try { localStorage.setItem(MULTI_WINDOW_STORAGE_KEY, JSON.stringify(state)); }
  catch { /* 存储不可用时不该影响使用，只是不记住布局 */ }
}

export interface BuildPaneUrlOptions {
  origin: string;
  /** 网关注入的当前后端；没有网关时传 null，就不要画蛇添足地加 ?d=。 */
  currentDevice?: string | null;
  currentSessionId?: string | null;
  /** 窗格内嵌时精简 UI；弹出独立窗口时去掉它。 */
  embed?: boolean;
  /** 窗格里当前选中的视图（右侧悬浮按钮）；重建 iframe 时用它保持原样。 */
  view?: PaneView | null;
}

export function buildPaneUrl(pane: PaneConfig, options: BuildPaneUrlOptions): string {
  const { origin, currentDevice = null, currentSessionId = null, embed = true, view = null } = options;
  const sessionId = pane.sessionId.trim() || (currentSessionId ?? '').trim();
  const url = new URL(sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/', origin);
  if (currentDevice) url.searchParams.set('d', pane.device || currentDevice);
  if (embed) url.searchParams.set('embed', '1');
  if (embed && pane.sidebar) url.searchParams.set('sidebar', '1');
  if (view) url.searchParams.set('view', view);
  return url.toString();
}

/** grid 类名写成完整字面量：Tailwind 只会扫描源码里出现过的类名。 */
export function layoutGridClass(layout: WindowLayout, focused: boolean): string {
  if (focused) return 'grid-cols-1 grid-rows-1';
  if (layout === 4) return 'grid-cols-1 grid-rows-4 sm:grid-cols-2 sm:grid-rows-2';
  if (layout === 6) return 'grid-cols-1 grid-rows-6 sm:grid-cols-2 sm:grid-rows-3 lg:grid-cols-3 lg:grid-rows-2';
  return 'grid-cols-1 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1';
}
