// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, within, waitFor, type RenderOptions } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../i18n/testInstance';
import enSidebar from '../../i18n/locales/en/sidebar.json';
import zhSidebar from '../../i18n/locales/zh-CN/sidebar.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import Sidebar from './Sidebar';
import { resetArtifactCounts } from './artifactsMedia';

vi.mock('./DeviceSwitcher', () => ({ default: () => <button aria-label="选择设备">设备</button> }));
vi.mock('./DeviceUrlSync', () => ({ default: () => null }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('lucide-react', () => ({
  ChevronRight: () => null,
  Loader2: () => <svg data-testid="running-indicator" />,
  Folder: () => null,
  GitBranch: () => null,
  MessageSquarePlus: () => null,
  Pin: () => null,
  Plus: () => null,
  Pencil: () => null,
  Settings2: () => null,
  PanelLeftOpen: () => null,
  Trash2: () => null,
  X: () => null,
  LayoutDashboard: () => null,
  Brain: () => null,
  Zap: () => null,
  BookOpen: () => null,
  Sparkles: () => null,
  CalendarClock: () => null,
  PanelLeftClose: () => null,
}));

const general: Project = {
  name: 'general',
  displayName: 'general',
  fullPath: '/workspace/general',
  sessions: [],
};

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
  sessions: [],
};

function renderSidebarProps(selectedProject: Project | null, extra?: Partial<ComponentProps<typeof Sidebar>>): ComponentProps<typeof Sidebar> {
  return {
    projects: [general, project],
    selectedProject,
    selectedSession: null,
    activeTab: 'chat',
    isLoading: false,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onCreateProject: vi.fn(),
    onRequestDeleteProject: vi.fn(),
    onRequestDeleteSession: vi.fn(),
    onShowSettings: vi.fn(),
    ...extra,
  };
}

function renderSidebar(selectedProject: Project | null, extra?: Partial<ComponentProps<typeof Sidebar>>, options?: RenderOptions) {
  return render(<Sidebar {...renderSidebarProps(selectedProject, extra)} />, options);
}

// 探索是侧栏底部的一个分区：默认收起，展开方式和「项目」一样点标题上的箭头。
function expandExplore() {
  fireEvent.click(screen.getByRole('button', { name: 'Expand explore' }));
}

function exploreSection() {
  return within(document.querySelector('.explore-section') as HTMLElement);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.pilotdeckDesktop;
});

describe('Sidebar layout', () => {
  it('distinguishes a project load failure from an empty project list', () => {
    const onRetryLoad = vi.fn();
    renderSidebar(null, {
      projects: [],
      loadError: 'Gateway unavailable',
      onRetryLoad,
    });

    expect(screen.getByRole('status').textContent).toMatch(/temporarily unavailable|暂时无法加载/);
    expect(screen.queryByText(/No projects found|未找到项目/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it('shows brand text, quick actions and one project tree', () => {
    renderSidebar(null);

    // 顶栏换成了 PilotV 品牌加设备切换器，不再是官方那张双图 wordmark。
    // logo 本身就是设置入口：侧栏只剩探索、项目、设置三块。
    const brand = screen.getByRole('button', { name: 'Settings' });
    expect(brand.textContent).toBe('PilotV');
    expect(screen.getByLabelText('选择设备')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: /Quick actions|Primary actions/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start a new conversation in PilotDeck|在 PilotDeck 中新建对话/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create new project|创建新项目/ })).toBeTruthy();
    expect(screen.getByText('Projects')).toBeTruthy();
    // 探索现在是侧栏底部的一个分区，默认收起：只有标题行，看不到里面的条目。
    expect(screen.getByText('Explore')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand explore' })).toBeTruthy();
    expect(screen.queryByText('Scheduled Tasks')).toBeNull();
    // 定时任务的独立入口撤了，它只在探索分区里。
    expect(document.querySelectorAll('.explore-section')).toHaveLength(1);

    // 对话主目录撤了，只剩一棵项目树。
    expect(screen.queryByText('Conversations')).toBeNull();
    // 新对话大按钮和技能按钮一起撤掉，侧栏不再有这两个入口。
    expect(screen.queryByText(/New conversation|新对话/)).toBeNull();
    expect(screen.queryByText('Skills')).toBeNull();
  });

  it('opens settings from the PilotV logo', () => {
    const onShowSettings = vi.fn();
    renderSidebar(null, { onShowSettings });

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onShowSettings).toHaveBeenCalledTimes(1);
  });

  it('lists general as a project folder next to the other projects', () => {
    renderSidebar(general);

    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('PilotDeck')).toBeTruthy();
    expect(screen.getByText('General')).toBeTruthy();
    // general 是个普通文件夹：「在该项目新建对话」和其它项目一样在行上。
    expect(screen.getByRole('button', { name: /Start a new conversation in General|在 General 中新建对话/ })).toBeTruthy();
    expect((document.querySelector('.project-tree-list') as HTMLElement).textContent).toContain('General');
  });

  it('shows the device entry and keeps settings reachable when the sidebar is compact', () => {
    localStorage.setItem('sidebar-v2-width', '76');
    const onShowSettings = vi.fn();
    renderSidebar(null, { onShowSettings });

    // 收起时 logo 换成了「设备」按钮，所以设置必须在底部补一个图标入口。
    expect(screen.queryByText('PilotV')).toBeNull();
    const compactEntry = screen.getByRole('button', { name: '展开设备选择' });
    expect(compactEntry).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onShowSettings).toHaveBeenCalledTimes(1);
  });

  it('collapses and expands the explore section like the projects section', () => {
    renderSidebar(null);

    // 和「项目」一样：收起时只有标题行，展开后条目才出现，再点一次又收回去。
    expect(screen.queryByText('Memory')).toBeNull();
    expandExplore();
    expect(screen.getByRole('button', { name: 'Collapse explore' })).toBeTruthy();
    expect(screen.getByText('Memory')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse explore' }));
    expect(screen.getByRole('button', { name: 'Expand explore' })).toBeTruthy();
    expect(screen.queryByText('Memory')).toBeNull();
  });

  it('opens scheduled tasks and skills from the explore section', () => {
    const onSelectTab = vi.fn();
    renderSidebar(null, { onSelectTab });

    expandExplore();
    const section = exploreSection();
    // 定时任务从原来的独立快捷入口搬进探索分区。
    fireEvent.click(section.getByText('Scheduled Tasks'));
    expect(onSelectTab).toHaveBeenCalledWith('cron');
    // 分区保持展开：切过去以后还能直接换别的入口。
    expect(screen.getByText('Skills')).toBeTruthy();

    fireEvent.click(screen.getByText('Skills'));
    expect(onSelectTab).toHaveBeenCalledWith('skills');
  });

  it('marks the active explore destination as the current page', () => {
    renderSidebar(null, { activeTab: 'skills' });

    expandExplore();
    expect(screen.getByText('Skills').closest('button')?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Scheduled Tasks').closest('button')?.getAttribute('aria-current')).toBeNull();
  });

  it('no longer offers a project rooms entry', () => {
    const onSelectTab = vi.fn();
    renderSidebar(null, { onSelectTab });

    // 项目室撤掉了：每个对话自己就是一个项目室，侧栏不再单开一页。
    expect(screen.queryByRole('button', { name: 'Project Rooms' })).toBeNull();
    expect(screen.queryByText('Project Rooms')).toBeNull();
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('hides dashboard and weknora from explore for projects without explore', () => {
    const noExplore: Project = { ...general, capabilities: { explore: false } };
    renderSidebar(noExplore, { projects: [noExplore, project] });

    expandExplore();

    const section = exploreSection();
    expect(section.queryByText('Dashboard')).toBeNull();
    expect(section.queryByText('资料')).toBeNull();
    // 但记忆／常驻／改动这些不依赖项目能力的必须留着，否则它们没入口了。
    expect(section.getByText('Memory')).toBeTruthy();
    expect(section.getByText('Always-on')).toBeTruthy();
    expect(section.getByText('Changes')).toBeTruthy();
  });

  it('asks the main area to open the changes review from explore', () => {
    renderSidebar(null);

    const opened = vi.fn();
    window.addEventListener('pilotdeck:open-changes', opened);
    expandExplore();
    fireEvent.click(screen.getByText('Changes'));
    window.removeEventListener('pilotdeck:open-changes', opened);

    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('lists projects by lastActivity descending with general in the same tree', () => {
    const older: Project = {
      name: 'Users-wukai-test0806',
      displayName: 'test0806',
      fullPath: '/tmp/test0806',
      lastActivity: 1787215786943,
      sessions: [],
    };
    const newer: Project = {
      name: 'Users-wukai-test0807',
      displayName: 'test0807',
      fullPath: '/tmp/test0807',
      lastActivity: 1787570906592,
      sessions: [],
    };

    renderSidebar(newer, { projects: [general, older, newer] });

    const list = document.querySelector('.project-tree-list') as HTMLElement;
    expect(list).toBeTruthy();
    const labels = within(list)
      .getAllByText(/test080[67]/)
      .map((node) => node.textContent?.trim());
    expect(labels).toEqual(['test0807', 'test0806']);
    // 对话主目录删了之后，general 也在这棵树里。
    expect(within(list).getByText('General')).toBeTruthy();
  });

  it('selects a project when its row is clicked', () => {
    const onSelectProject = vi.fn();
    renderSidebar(null, { onSelectProject });

    fireEvent.click(screen.getByRole('button', { name: /^PilotDeck$/ }));

    expect(onSelectProject).toHaveBeenCalledWith(project);
  });

  it('toggles the project tree only from the heading chevron', () => {
    renderSidebar(general);

    const projectsHeading = screen.getByRole('button', { name: 'Collapse projects' }).closest('.tree-heading') as HTMLElement;

    expect(screen.getByText('PilotDeck')).toBeTruthy();
    expect(within(projectsHeading).getByRole('button', { name: /Create new project|创建新项目/ })).toBeTruthy();

    // 点标题本身不折叠，只有折叠键能折叠。
    fireEvent.click(screen.getByText('Projects'));
    expect(screen.getByText('PilotDeck')).toBeTruthy();
    fireEvent.click(within(projectsHeading).getByRole('button', { name: 'Collapse projects' }));
    expect(screen.queryByText('PilotDeck')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand projects' }));
    expect(screen.getByText('PilotDeck')).toBeTruthy();
  });

  it('starts the project folders expanded so general conversations are visible', () => {
    const chattyGeneral: Project = {
      ...general,
      sessions: [{ id: 's1', title: 'hello world', lastActivity: '2026-08-01' }],
    };
    renderSidebar(chattyGeneral, { projects: [chattyGeneral, project] });

    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.getByText('PilotDeck')).toBeTruthy();
    // 对话主目录的折叠键不存在了，只有项目树一个。
    expect(screen.queryByRole('button', { name: /Collapse conversations|收起对话/ })).toBeNull();
  });

  it('opens project creation from the Projects heading', () => {
    const onCreateProject = vi.fn();
    renderSidebar(general, { onCreateProject });

    fireEvent.click(screen.getByRole('button', { name: /Create new project|创建新项目/ }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('starts a project conversation from the row action, general included', () => {
    const onStartNewSession = vi.fn();
    renderSidebar(null, { onStartNewSession });

    fireEvent.click(screen.getByRole('button', {
      name: /Start a new conversation in PilotDeck|在 PilotDeck 中新建对话/,
    }));
    expect(onStartNewSession).toHaveBeenLastCalledWith(project);

    fireEvent.click(screen.getByRole('button', {
      name: /Start a new conversation in General|在 General 中新建对话/,
    }));
    expect(onStartNewSession).toHaveBeenLastCalledWith(general);
  });

  it('opens the same menu on long press so touch devices can pin too', () => {
    vi.useFakeTimers();
    try {
      renderSidebar(null);

      const row = screen.getByRole('button', { name: /^PilotDeck$/ }).closest('.project-row') as HTMLElement;
      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 12, clientY: 24, bubbles: true });
      act(() => { vi.advanceTimersByTime(500); });

      expect(screen.getByRole('menu')).toBeTruthy();

      // 松手那一下 click 必须被吞掉：否则它会落到行上、把刚开出来的菜单又关掉。
      fireEvent.click(row, { bubbles: true });
      expect(screen.getByRole('menu')).toBeTruthy();

      fireEvent.click(screen.getByRole('menuitem', { name: /Pin|置顶/ }));
      expect(JSON.parse(localStorage.getItem('pilotdeck:pinnedItems') || '{}').projects).toEqual(['pilotdeck']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins a project and a conversation from the context menu and keeps pinned rows first', () => {
    const pinnedProject: Project = {
      ...project,
      lastActivity: 1,
      sessions: [
        { id: 'old', title: 'older talk', lastActivity: '2026-08-01' },
        { id: 'new', title: 'newer talk', lastActivity: '2026-09-01' },
      ],
    };
    const fresh: Project = {
      name: 'fresh',
      displayName: 'fresh',
      fullPath: '/workspace/fresh',
      lastActivity: 9_000_000_000_000,
      sessions: [],
    };
    renderSidebar(pinnedProject, { projects: [general, pinnedProject, fresh] });

    const projectLabels = () => (document.querySelector('.project-tree-list') as HTMLElement)
      .textContent || '';
    expect(projectLabels().indexOf('fresh')).toBeLessThan(projectLabels().indexOf('PilotDeck'));

    fireEvent.contextMenu(screen.getByRole('button', { name: /^PilotDeck$/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Pin|置顶/ }));

    expect(projectLabels().indexOf('PilotDeck')).toBeLessThan(projectLabels().indexOf('fresh'));

    // 置顶只写本地存储，不碰后端返回的项目顺序本身。
    expect(JSON.parse(localStorage.getItem('pilotdeck:pinnedItems') || '{}').projects).toEqual(['pilotdeck']);

    fireEvent.contextMenu(screen.getByText('older talk'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Pin|置顶/ }));

    const sessions = document.querySelector('.project-tree-list') as HTMLElement;
    const order = (sessions.textContent || '').indexOf('older talk') < (sessions.textContent || '').indexOf('newer talk');
    expect(order).toBe(true);
  });
});

it('renders running, unread and idle indicators in the same slot', () => {
  const withSessions = {...project, sessions:[{id:'running',title:'Running'}, {id:'unread',title:'Unread'}, {id:'idle',title:'Idle'}]};
  const view = renderSidebar(withSessions, {projects:[withSessions],selectedSession:{id:'running'},processingSessions:new Set(['running']),unreadSessionIds:new Set(['running','unread'])});
  expect(view.container.querySelector('[data-session-indicator="running"]')?.getAttribute('data-status')).toBe('processing');
  expect(screen.getByTestId('running-indicator')).toBeTruthy();
  expect(view.container.querySelector('[data-session-indicator="unread"]')?.getAttribute('data-status')).toBe('unread');
  expect(view.container.querySelector('[data-session-indicator="idle"]')?.getAttribute('data-status')).toBe('idle');
});

// 有成果的会话要被标出来，并且在折叠时不能跟着 Show more 一起藏起来。
function stubArtifactWorkspace(counts: Record<string, number>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    // 只认成果工作区；设备、任务这些接口各有自己的响应格式，
    // 一并喂成果数据会让别的组件解析失败，侧栏跟着渲染不出来。
    if (String(input).includes('/api/artifacts/workspace')) {
      return {
        ok: true,
        json: async () => ({
          projects: [{
            sessions: Object.entries(counts).map(([id, n]) => ({
              id,
              artifacts: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}` })),
            })),
          }],
        }),
      } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }));
}

const sessionRows = () =>
  screen.getAllByRole('button').filter(b => b.className.includes('project-conversation'));

const rowNamed = (name: string) => sessionRows().find(b => b.textContent?.includes(name));

describe('Sidebar artifact marks', () => {
  beforeEach(() => resetArtifactCounts());
  afterEach(() => { vi.unstubAllGlobals(); resetArtifactCounts(); });

  /** 计数是异步拉进 state 的，断言前要把微任务和组件卸载都处理干净。 */
  const settle = async () => {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };

  it('marks a conversation that has artifacts and leaves the others plain', async () => {
    stubArtifactWorkspace({ 'web:s_with': 37, 'web:s_without': 0 });
    const busy: Project = {
      ...project,
      sessions: [
        { id: 'web:s_with', title: '设计 PilotV logo', lastActivity: '2026-10-14T10:00:00Z' },
        { id: 'web:s_without', title: '闲聊', lastActivity: '2026-10-14T09:00:00Z' },
      ] as Project['sessions'],
    };
    // 会话只在项目处于展开状态时才渲染，selectedProject 就是那个开关。
    renderSidebar(busy, { projects: [busy] });

    await settle();
    const badge = await screen.findByTestId('artifact-count-web:s_with');
    expect(badge.textContent).toContain('37');
    expect(screen.queryByTestId('artifact-count-web:s_without')).toBeNull();
  });

  it('keeps an artifact-bearing conversation visible after the list is collapsed', async () => {
    // 成果全落在折叠区的话，侧栏看起来就像成果没了。
    const withArtifacts = { id: 'web:s_art', title: '你去重启服务', lastActivity: '2026-01-01T00:00:00Z' };
    const plain = Array.from({ length: 8 }, (_, i) => ({
      id: `web:s_plain_${i}`,
      title: `闲聊 ${i}`,
      lastActivity: `2026-10-14T09:0${i}:00Z`,
    }));
    stubArtifactWorkspace({ 'web:s_art': 33, 'web:s_plain_0': 0 });
    const busyProject = {
      ...project,
      sessions: [withArtifacts, ...plain] as Project['sessions'],
    };
    renderSidebar(busyProject, { projects: [busyProject] });

    await settle();
    expect(rowNamed('你去重启服务')).toBeTruthy();
    fireEvent.click(screen.getByText('Show less'));

    // 折叠后仍然看得见，徽标也还在。
    expect(rowNamed('你去重启服务')).toBeTruthy();
    expect(await screen.findByTestId('artifact-count-web:s_art')).toBeTruthy();
    // 折叠本身仍然生效：最近活动的 5 条照常露出，没有成果的旧对话被收起。
    expect(rowNamed('闲聊 7')).toBeTruthy();
    expect(rowNamed('闲聊 0')).toBeFalsy();
  });

  it('re-reads the counts once more sessions arrive, since the first page can be short', async () => {
    // 首屏只回一部分会话时，徽标会漏掉后面那些有成果的对话；会话到齐要重拉一次。
    let reply: Record<string, number> = { 'web:s_early': 4 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes('/api/artifacts/workspace')
        ? {
          ok: true,
          json: async () => ({
            projects: [{
              sessions: Object.entries(reply).map(([id, n]) => ({
                id,
                artifacts: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}` })),
              })),
            }],
          }),
        } as Response
        : { ok: false, json: async () => ({}) } as Response
    ));
    vi.stubGlobal('fetch', fetchMock);

    const early: Project = {
      ...project,
      sessions: [
        { id: 'web:s_early', title: '先到的', lastActivity: '2026-10-14T10:00:00Z' },
        { id: 'web:s_plain', title: '闲聊', lastActivity: '2026-10-14T09:30:00Z' },
      ] as Project['sessions'],
    };
    const { rerender } = renderSidebar(early, { projects: [early] });
    await settle();
    expect(await screen.findByTestId('artifact-count-web:s_early')).toBeTruthy();
    expect(screen.queryByTestId('artifact-count-web:s_later')).toBeNull();

    // 成果台这时才把后到的会话补上，侧栏要跟着更新。
    reply = { 'web:s_early': 4, 'web:s_later': 12 };
    const grown: Project = {
      ...early,
      sessions: [...early.sessions!, { id: 'web:s_later', title: '后到的', lastActivity: '2026-10-14T09:00:00Z' }] as Project['sessions'],
    };
    rerender(<Sidebar {...(renderSidebarProps(grown, { projects: [grown] }))} />);
    await settle();
    expect(await screen.findByTestId('artifact-count-web:s_later')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/artifacts/workspace')).length).toBe(2);
  });

  it('still renders the sidebar when the artifact list cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes('/api/artifacts/workspace')
        ? { ok: false, json: async () => ({}) } as Response
        : { ok: false, json: async () => ({}) } as Response
    )));
    const plainProject = {
      ...project,
      sessions: [{ id: 'web:s_x', title: '没有成果标记', lastActivity: '2026-10-14T09:00:00Z' }] as Project['sessions'],
    };
    renderSidebar(plainProject, { projects: [plainProject] });

    // 拿不到计数只是少个徽标，不能把侧栏整个搞坏。
    await settle();
    expect(await screen.findByText('PilotDeck')).toBeTruthy();
    expect(rowNamed('没有成果标记')).toBeTruthy();
    expect(screen.queryByTestId('artifact-count-web:s_x')).toBeNull();
  });
});

it('shows waiting questions and approvals ahead of running and unread indicators', () => {
  const withSessions = {...project, sessions:[{id:'question',title:'Question'}, {id:'approval',title:'Approval'}]};
  const view = renderSidebar(withSessions, {projects:[withSessions],processingSessions:new Set(['question','approval']),unreadSessionIds:new Set(['question','approval']),waitingSessions:new Map([['question','question'],['approval','approval']])});
  expect(view.container.querySelector('[data-session-indicator="question"]')?.getAttribute('aria-label')).toMatch(/Waiting for your answer|等待你回答/);
  expect(view.container.querySelector('[data-session-indicator="approval"]')?.getAttribute('aria-label')).toMatch(/Waiting for approval|等待你审批/);
  expect(screen.queryByTestId('running-indicator')).toBeNull();
});

describe('desktop working-directory actions', () => {
  async function localizedOptions(language = 'en'): Promise<RenderOptions> {
    const i18n = await createTestI18n(language);
    i18n.addResourceBundle('en', 'sidebar', enSidebar);
    i18n.addResourceBundle('zh-CN', 'sidebar', zhSidebar);
    return { wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider> };
  }
  it.each([
    ['win32', 'en', 'Open in File Explorer'], ['win32', 'zh-CN', '在文件资源管理器中打开'],
    ['darwin', 'en', 'Open in Finder'], ['darwin', 'zh-CN', '在 Finder 中打开'],
    ['linux', 'en', 'Open in File Manager'], ['linux', 'zh-CN', '在文件管理器中打开'],
  ])('opens the session working directory on %s in %s', async (platform, language, label) => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform, openDirectory } as never;
    const withSessions = { ...project, sessions: [{ id: 'native', title: 'Native chat', cwd: '/worktree/space 中文' }] };
    const onSelectSession = vi.fn();
    renderSidebar(withSessions, { projects: [withSessions], onSelectSession }, await localizedOptions(language));
    fireEvent.contextMenu(screen.getByText('Native chat'), { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith('/worktree/space 中文'));
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the project directory when a conversation has no recorded cwd', async () => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform: 'win32', openDirectory } as never;
    const withSessions = { ...project, sessions: [{ id: 'fallback', title: 'Fallback chat' }] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('Fallback chat'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in File Explorer|在文件资源管理器中打开/ }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith(project.fullPath));
    fireEvent.contextMenu(screen.getByText('PilotDeck'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in File Explorer|在文件资源管理器中打开/ }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledTimes(2));
  });

  it.each([general.fullPath, '/previous/general'])('uses the current General workspace instead of stale cwd %s', async (cwd) => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform: 'darwin', openDirectory } as never;
    const withSessions = { ...general, workspaceCwd: '/managed/workspace', sessions: [{ id: 'general-chat', title: 'General chat', cwd }] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('General chat'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in Finder|在 Finder 中打开/ }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith('/managed/workspace'));
  });

  it('keeps native file manager actions out of the browser', () => {
    renderSidebar(project);
    fireEvent.contextMenu(screen.getByText('PilotDeck'));
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('inherits the parent working directory for a background conversation', async () => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform: 'linux', openDirectory } as never;
    const withSessions: Project = { ...project, sessions: [
      { id: 'parent', title: 'Parent chat', cwd: '/worktree/parent' },
      { id: 'background', title: 'Background chat', parentSessionId: 'parent', sessionKind: 'background_task' },
    ] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('Background chat'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in File Manager' }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith('/worktree/parent'));
  });

  it('hides the action when General has no working directory', async () => {
    window.pilotdeckDesktop = { platform: 'darwin', openDirectory: vi.fn() } as never;
    const withSessions = { ...general, sessions: [{ id: 'legacy', title: 'Legacy general chat', cwd: general.fullPath }] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('Legacy general chat'));
    expect(screen.queryByRole('menuitem', { name: 'Open in Finder' })).toBeNull();
  });

  it.each([false, 'reject'])('reports a localized failure when opening returns %s', async failure => {
    const openDirectory = failure === false ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(new Error('missing'));
    window.pilotdeckDesktop = { platform: 'win32', openDirectory } as never;
    const toast = vi.fn();
    window.addEventListener('pilotdeck:toast', toast);
    try {
      renderSidebar(project, undefined, await localizedOptions(failure === false ? 'en' : 'zh-CN'));
      fireEvent.contextMenu(screen.getByText('PilotDeck'));
      fireEvent.click(screen.getByRole('menuitem', { name: /Open in File Explorer|在文件资源管理器中打开/ }));
      await waitFor(() => expect(toast).toHaveBeenCalledOnce());
      expect(toast.mock.calls[0][0].detail).toMatchObject({ kind: 'error' });
      expect(toast.mock.calls[0][0].detail.message).toMatch(/Could not open the working directory|无法打开工作目录/);
    } finally { window.removeEventListener('pilotdeck:toast', toast); }
  });
});

it('opens global search from the sidebar entry', () => {
  const onOpenGlobalSearch = vi.fn();
  renderSidebar(null, { onOpenGlobalSearch });
  fireEvent.click(document.querySelector('.sidebar-global-search') as HTMLElement);
  expect(onOpenGlobalSearch).toHaveBeenCalledTimes(1);
});
