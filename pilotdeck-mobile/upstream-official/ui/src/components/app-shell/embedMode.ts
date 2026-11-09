// iframe 内嵌模式的 URL 开关。
//
// 多窗口工作区用同源 iframe 承载每个窗格。若里面仍渲染完整外壳，窄格里
// 会塞进整套侧栏，而且能再次点开「多窗口」造成无限嵌套。这里只负责读 URL
// 参数，具体隐藏由 AppShell / MainArea 决定。

export const EMBED_QUERY_KEY = 'embed';
export const VIEW_QUERY_KEY = 'view';
export const SIDEBAR_QUERY_KEY = 'sidebar';

function currentSearch(search?: string): string {
  if (typeof search === 'string') return search;
  return typeof window === 'undefined' ? '' : window.location.search;
}

export function isEmbeddedView(search?: string): boolean {
  return new URLSearchParams(currentSearch(search)).get(EMBED_QUERY_KEY) === '1';
}

/** 多窗口窗格里的右侧悬浮按钮只有这三种视图，用 URL 记住，避免共享 localStorage。 */
export type PaneView = 'chat' | 'files' | 'artifacts';

export function readPaneView(search?: string): PaneView {
  const value = new URLSearchParams(currentSearch(search)).get(VIEW_QUERY_KEY);
  return value === 'artifacts' || value === 'files' ? value : 'chat';
}

/** 成果台没有独立路由，用 ?view=artifacts 让内嵌实例直达成果台面板。 */
export function shouldOpenArtifacts(search?: string): boolean {
  return readPaneView(search) === 'artifacts';
}

/** 内嵌窗格把当前视图回写到自己的 URL：刷新/切设备后仍是用户刚选的那一页。 */
export function syncEmbeddedPaneView(view: PaneView, href?: string): string | null {
  if (typeof window === 'undefined') return null;
  const source = href ?? window.location.href;
  const url = new URL(source, window.location.origin);
  if (!isEmbeddedView(url.search)) return null;
  // 始终显式写值（chat 也写），避免「删掉参数」被路由的补参逻辑又加回来。
  url.searchParams.set(VIEW_QUERY_KEY, view);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (href === undefined && next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    try { window.history.replaceState(window.history.state, '', next); }
    catch { /* 历史 API 不可用时忽略：本窗格仍可正常切换视图。 */ }
  }
  return next;
}

/**
 * 默认精简掉侧栏；但连到另一台设备时，用户需要那台设备自己的项目/会话列表
 * 才能挑对话。?sidebar=1 让单个窗格按需展开，不必把所有格子都塞满导航。
 */
export function shouldShowEmbeddedSidebar(search?: string): boolean {
  const params = new URLSearchParams(currentSearch(search));
  return params.get(EMBED_QUERY_KEY) === '1' && params.get(SIDEBAR_QUERY_KEY) === '1';
}
