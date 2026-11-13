import { useMatch } from 'react-router-dom';

export const SCHEDULED_TASKS_PATH = '/cron';
export const SKILLS_PATH = '/skills';
export const APPROVAL_SESSION_PATH = '/approval-session';
export const WINDOWS_PATH = '/windows';
export const SETTINGS_PATH = '/settings';
export const SETTINGS_SECTION_PATH = '/settings/:section';

// 会话的两种 URL 形状。整条壳只挂一条通配路由，这些形状由 AppShell
// 用 useMatch 认出来 —— 换成专门的 <Route> 会把壳整个卸载，状态就丢了。
export const PROJECT_CHAT_PATH = '/p/:projectName/c/:sessionId';
export const PROJECT_PATH = '/p/:projectName';
export const LEGACY_SESSION_PATH = '/session/:sessionId';

// 任务复现视图：把一条对话（或整个项目的全部对话）从提需求到完成的过程
// 重放出来，供用户用外部硬件录屏记录。整条壳只有一条通配路由，复现视图同样
// 由 AppShell 用 useMatch 认出来，不新增 <Route>。
export const REPLAY_SESSION_PATH = '/replay/s/:sessionId';
export const REPLAY_PROJECT_PATH = '/replay/p/:projectName';

// The auth gate and shell must agree on which URLs actually render Settings.
// A prefix check would also admit nested URLs that the shell treats as chat.
export function useSettingsRouteMatch() {
  const index = useMatch({ path: SETTINGS_PATH, end: true });
  const section = useMatch({ path: SETTINGS_SECTION_PATH, end: true });
  return section ?? index;
}

export const DEDICATED_TAB_PATHS = {
  cron: SCHEDULED_TASKS_PATH,
  skills: SKILLS_PATH,
  approval: APPROVAL_SESSION_PATH,
  windows: WINDOWS_PATH,
} as const;

export type DedicatedTab = keyof typeof DEDICATED_TAB_PATHS;

export function getDedicatedTabPath(tab: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DEDICATED_TAB_PATHS, tab)
    ? DEDICATED_TAB_PATHS[tab as DedicatedTab]
    : undefined;
}

/**
 * URL 形状 → 专用页签。
 *
 * 顺序就是优先级：几个专用页互斥，同时匹配上时按这里定的来。
 * AppShell 把 useMatch 的结果交给它，认成「当前是哪一个专用页」。
 */
export function resolveDedicatedTab(
  matched: Partial<Record<DedicatedTab, boolean>>,
): DedicatedTab | null {
  // `approval` must be included: otherwise /approval-session is navigated to
  // but never resolved as a dedicated tab, so MainArea falls back to chat.
  for (const tab of ['skills', 'cron', 'approval', 'windows'] as const) {
    if (matched[tab]) return tab;
  }
  return null;
}
