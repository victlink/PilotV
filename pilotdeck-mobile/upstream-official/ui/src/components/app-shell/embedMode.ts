// iframe 内嵌模式的 URL 开关。
//
// 多窗口工作区用同源 iframe 承载每个窗格。若里面仍渲染完整外壳，窄格里
// 会塞进整套侧栏，而且能再次点开「多窗口」造成无限嵌套。这里只负责读 URL
// 参数，具体隐藏由 AppShell / MainArea 决定。

export const EMBED_QUERY_KEY = 'embed';
export const VIEW_QUERY_KEY = 'view';

function currentSearch(search?: string): string {
  if (typeof search === 'string') return search;
  return typeof window === 'undefined' ? '' : window.location.search;
}

export function isEmbeddedView(search?: string): boolean {
  return new URLSearchParams(currentSearch(search)).get(EMBED_QUERY_KEY) === '1';
}

/** 成果台没有独立路由，用 ?view=artifacts 让内嵌实例直达成果台面板。 */
export function shouldOpenArtifacts(search?: string): boolean {
  return new URLSearchParams(currentSearch(search)).get(VIEW_QUERY_KEY) === 'artifacts';
}
