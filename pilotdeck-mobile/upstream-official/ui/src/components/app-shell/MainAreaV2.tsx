import ArtifactsConsolePane from './ArtifactsConsolePane';
import TaskMonitorPanel from './TaskMonitorPanel';
import { usePendingConfirmations } from './usePendingConfirmations';
import { FileConversationContext } from '../main-content-v2/fileConversationContext';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Database,
  Folder,
  GitBranch,
  Library,
  PanelsTopLeft,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  type LucideIcon,
} from 'lucide-react';
import type {
  AlwaysOnSubTab,
  AppTab,
  Project,
  ProjectSession,
} from '../../types/app';
import MainContent from '../main-content/view/MainContent';
import { ChatHistorySearchControllerProvider } from '../chat-v2/ChatHistorySearchController';
import type { MainContentProps } from '../main-content/types/types';
import {
  projectDisplayName,
  sessionDisplayTitle,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../lib/customNames';
import { isImeEnterEvent } from '../../utils/ime';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import { isGeneralProject } from './appShellSelection';
import { REVIEW_CLOSE_EVENT } from '../chat-review/reviewEvents';

const CronV2 = lazy(() => import('../main-content-v2/CronV2'));
const SkillsV2 = lazy(() => import('../main-content-v2/SkillsV2'));

function DedicatedWorkspacePage({
  title,
  isSidebarCollapsed,
  onOpenSidebar,
  children,
}: {
  title: string;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="pd-workspace-content flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="workspace-header relative z-[80] shrink-0 overflow-visible">
        {isSidebarCollapsed ? (
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="workspace-title flex-1">
          <h1 className="min-w-0 truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50">
            {title}
          </h1>
        </div>
      </header>
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function PageFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
    </div>
  );
}

function ScheduledTasksArea({
  isSidebarCollapsed,
  onOpenSidebar,
}: {
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DedicatedWorkspacePage
      title={t('sidebar:quickActions.scheduledTasks', { defaultValue: 'Scheduled Tasks' })}
      isSidebarCollapsed={isSidebarCollapsed}
      onOpenSidebar={onOpenSidebar}
    >
      <Suspense fallback={<PageFallback />}>
        <CronV2 />
      </Suspense>
    </DedicatedWorkspacePage>
  );
}

function SkillsArea({
  isSidebarCollapsed,
  onOpenSidebar,
  selectedProject,
  projects,
}: {
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  selectedProject: Project | null;
  projects: Project[];
}) {
  const { t } = useTranslation();

  return (
    <DedicatedWorkspacePage
      title={t('sidebar:quickActions.skills', { defaultValue: 'Skills' })}
      isSidebarCollapsed={isSidebarCollapsed}
      onOpenSidebar={onOpenSidebar}
    >
      <Suspense fallback={<PageFallback />}>
        <SkillsV2 selectedProject={selectedProject} projects={projects} />
      </Suspense>
    </DedicatedWorkspacePage>
  );
}

type Tab = { id: AppTab; labelKey: string; icon: LucideIcon };

// Chat is the shell's default surface rather than a visible destination.
// Files is the only primary work mode; the remaining management dashboards
// live behind the compact overflow trigger and open beside the conversation.
const FILES_TAB: Tab = { id: 'files', labelKey: 'tabs.files', icon: Folder };
// 「改动」这一页就是对话旁的评审面板（变更 / Git / 历史）。AppTab 里的 'git'
// 是它早年的名字，管线（MainContent → ChatReviewProvider）一直都在。
const REVIEW_TAB: Tab = { id: 'git', labelKey: 'dashboardSwitcher.changes', icon: GitBranch };
const DASHBOARD_TABS: Tab[] = [
  { id: 'dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
  { id: 'memory',    labelKey: 'tabs.memory',    icon: Database },
  { id: 'always-on', labelKey: 'tabs.alwaysOn',  icon: Radio },
  // 资料 = 本机 WeKnora 知识库，整块 iframe 打开，不占用聊天旁边的看板宽度。
  { id: 'weknora',   labelKey: 'tabs.weknora',   icon: Library },
];

// V2 main shell: breadcrumb on the left, tool switcher on the right, and the
// active tool's content below. The sidebar stays focused on projects+sessions.
type MainAreaV2Props = MainContentProps & {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  onNavigateToSession?: (sessionId: string) => void;
};

// 页面标签抽屉的展开／收起状态存 localStorage：收起后重新打开仍然是收起的。
// 只影响标签把手本身，三个页面照旧各自整窗显示。
const PAGE_TABS_STORAGE_KEY = 'pilotdeck:pageTabsOpen';

function readPageTabsOpen() {
  try {
    return localStorage.getItem(PAGE_TABS_STORAGE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

function MainAreaV2Content(props: MainAreaV2Props) {
  const { t } = useTranslation();
  const {
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    isSidebarCollapsed,
    onOpenSidebar,
    onStartNewSession,
  } = props;
  const [alwaysOnSubTab, setAlwaysOnSubTab] = useState<AlwaysOnSubTab>('dashboard');
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [pageTabsOpen, setPageTabsOpen] = useState(readPageTabsOpen);
  const [taskMonitorOpen, setTaskMonitorOpen] = useState(false);
  const pendingConfirmations = usePendingConfirmations();
  const [reviewOpenRequest, setReviewOpenRequest] = useState<MainContentProps['reviewOpenRequest']>();
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const sessionTitleInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(PAGE_TABS_STORAGE_KEY, pageTabsOpen ? 'expanded' : 'collapsed');
    } catch {
      // Silently ignore storage errors
    }
  }, [pageTabsOpen]);
  const generalConversation = Boolean(selectedProject && isGeneralProject(selectedProject));
  const projectFilesEnabled = Boolean(
    selectedProject
    && !generalConversation
    && selectedProject.capabilities?.files !== false,
  );
  const projectExploreEnabled = Boolean(
    selectedProject
    && !generalConversation
    && selectedProject.capabilities?.explore !== false,
  );
  const activeTabIsUnavailable =
    (activeTab === 'files' && !projectFilesEnabled)
    || (DASHBOARD_TABS.some((tab) => tab.id === activeTab) && !projectExploreEnabled);
  const displayActiveTab = activeTab === 'home' || activeTabIsUnavailable ? 'chat' : activeTab;

  useEffect(() => {
    if (activeTab === 'home' || activeTabIsUnavailable) {
      setActiveTab('chat');
    }
  }, [activeTab, activeTabIsUnavailable, setActiveTab]);

  // 「改动」是独立的一页，评审面板住在对话内部，两棵子树互不相通：
  // 侧栏的探索菜单用 pilotdeck:open-changes 把请求递进来，序号每次加一，
  // 面板才会重新弹一次（否则已经在这一页时再点一次没反应）。
  const openChangesPage = useCallback(() => {
    setShowArtifacts(false);
    // 落在「改动」这一页，标签条上的选中态才不会跳回对话。
    setActiveTab(REVIEW_TAB.id);
    setReviewOpenRequest(previous => ({
      tab: 'changes',
      sequence: (Number(previous?.sequence) || 0) + 1,
    }));
  }, [setActiveTab]);

  useEffect(() => {
    window.addEventListener('pilotdeck:open-changes', openChangesPage);
    return () => window.removeEventListener('pilotdeck:open-changes', openChangesPage);
  }, [openChangesPage]);

  // 离开评审面板：切到别的页面时递个事件过去。少了这一步，面板的开合和
  // activeTab 是两份互不相干的状态，标签条点「对话」只能换主区、面板还开着。
  const leaveReviewPanel = useCallback(() => {
    window.dispatchEvent(new Event(REVIEW_CLOSE_EVENT));
  }, []);

  // Re-render breadcrumb when the user renames a project/session via the
  // sidebar overlay (subscribes to localStorage + custom event).
  useCustomNamesVersion();

  // Header title: session title first, project context second. Project +
  // session strings flow through the customNames overlay so user renames in
  // the sidebar reflect here too.
  const activeDashboardTab = DASHBOARD_TABS.find((tab) => tab.id === displayActiveTab) ?? null;
  const tabLabelKey = displayActiveTab === FILES_TAB.id
    ? FILES_TAB.labelKey
    : activeDashboardTab?.labelKey;
  const tabLabel = tabLabelKey
    ? t(tabLabelKey)
    : displayActiveTab.startsWith('plugin:')
      ? displayActiveTab.replace('plugin:', '')
      : displayActiveTab;
  const sessionSummary = selectedSession ? sessionDisplayTitle(selectedSession) : '';
  const projectName = selectedProject
    ? isGeneralProject(selectedProject)
      ? t('sidebar:general.name', { defaultValue: 'General conversation' })
      : projectDisplayName(selectedProject)
    : t('sidebar:general.name', { defaultValue: 'General conversation' });
  const headerTitle =
    sessionSummary || (displayActiveTab === FILES_TAB.id ? tabLabel || projectName : projectName);
  const isRenamingSessionTitle = Boolean(
    selectedSession && renamingSessionId === selectedSession.id,
  );

  useEffect(() => {
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  }, [selectedSession?.id]);

  // 草图纸上「发送到新对话」用：对话输入本来就会在收到第一条消息时建会话，
  // 这里只需要把项目落到新对话态。落在当前项目，其次 General，最后第一个项目。
  const startConversationFromInk = useCallback(() => {
    const target = selectedProject
      ?? props.projects.find(isGeneralProject)
      ?? props.projects[0];
    if (!target) return;
    onStartNewSession?.(target);
  }, [selectedProject, props.projects, onStartNewSession]);

  useEffect(() => {
    if (!isRenamingSessionTitle) return;
    sessionTitleInputRef.current?.focus();
    sessionTitleInputRef.current?.select();
  }, [isRenamingSessionTitle]);

  const beginSessionTitleRename = () => {
    if (!selectedSession) return;
    setRenamingSessionId(selectedSession.id);
    setSessionTitleDraft(sessionDisplayTitle(selectedSession));
  };

  const commitSessionTitleRename = () => {
    if (!renamingSessionId) return;
    setSessionCustomTitle(renamingSessionId, sessionTitleDraft);
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  };

  const cancelSessionTitleRename = () => {
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  };

  return (
    <div className="pd-workspace-content flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="workspace-header relative z-[80] shrink-0 overflow-visible">
        {isSidebarCollapsed ? (
          // Just the "expand sidebar" affordance — the PilotDeck logo lives
          // in the sidebar header, so showing a duplicate badge here when
          // the sidebar is collapsed feels redundant.
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="workspace-title flex min-w-0 flex-1 items-center gap-3">
          {/* 顶栏只留面包屑。「对话／文件／成果」三个页面搬到了右边悬浮标签栏，
              每个标签各自整窗显示，顶栏不再有页面切换按钮。 */}
          <div className="flex min-w-0 items-center gap-1.5">
            <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
            <span className="min-w-0 max-w-[24rem] truncate text-[12px] text-neutral-500 dark:text-neutral-400" title={projectName}>{projectName}</span>
            {selectedSession ? <span aria-hidden="true" className="shrink-0 text-neutral-400 dark:text-neutral-500">/</span> : null}
            {isRenamingSessionTitle ? (
            <input
              ref={sessionTitleInputRef}
              value={sessionTitleDraft}
              onChange={(event) => setSessionTitleDraft(event.target.value)}
              onBlur={commitSessionTitleRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  if (isImeEnterEvent(event)) return;
                  event.preventDefault();
                  commitSessionTitleRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelSessionTitleRename();
                }
              }}
              aria-label={t('sidebar:sessions.renameSession', { defaultValue: 'Rename Session' }) as string}
              className="h-6 min-w-0 max-w-[34rem] rounded border border-neutral-300 bg-white px-1.5 text-[15px] font-semibold leading-5 text-neutral-950 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
            />
          ) : selectedSession ? (
            <h1
              className="min-w-0 max-w-[34rem] truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50 cursor-text"
              title={headerTitle}
              data-desktop-no-drag=""
              onDoubleClick={beginSessionTitleRename}
            >
              {headerTitle}
            </h1>
          ) : null}
          </div>
          <button
            type="button"
            onClick={() => setTaskMonitorOpen(value => !value)}
            aria-expanded={taskMonitorOpen}
            aria-label={t('sidebar:tasks.toggle')}
            title={t('sidebar:tasks.toggle')}
            className={`ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
              taskMonitorOpen
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
                : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800'
            }`}
          >
            <PanelsTopLeft className="h-4 w-4" aria-hidden />
            {t('sidebar:tasks.toggle')}
          </button>
        </div>
      </header>

      {taskMonitorOpen ? (
        <TaskMonitorPanel
          projects={props.projects}
          processingSessions={props.processingSessions}
          unreadSessionIds={props.unreadSessionIds}
          pendingConfirmations={pendingConfirmations}
          selectedSessionId={selectedSession?.id}
          onOpenSession={entry => {
            setTaskMonitorOpen(false);
            if (props.onNavigateToSession) props.onNavigateToSession(entry.session.id);
            else props.onSelectSession?.(entry.project, entry.session.id);
          }}
          onClose={() => setTaskMonitorOpen(false)}
        />
      ) : null}

      <div className="relative z-0 flex min-h-0 flex-1 overflow-hidden">
        {showArtifacts && <div className="min-h-0 flex-1 overflow-hidden"><ArtifactsConsolePane sessionId={selectedSession?.id} onStartNewConversation={startConversationFromInk} /></div>}
        {/* Keep chat mounted so switching views does not discard the composer. */}
        <div hidden={showArtifacts} className={showArtifacts ? 'hidden' : 'relative min-h-0 flex-1 overflow-hidden'}>
          <FileConversationContext.Provider value={{ id: selectedSession?.id, cwd: typeof selectedSession?.cwd === 'string' ? selectedSession.cwd : undefined }}>
          <MainContent
            {...props}
            activeTab={displayActiveTab}
            reviewOpenRequest={reviewOpenRequest}
            alwaysOnSubTab={alwaysOnSubTab}
            onAlwaysOnSubTabChange={setAlwaysOnSubTab}
          />
          </FileConversationContext.Provider>
        </div>
        {/* 悬浮抽屉式页面标签。四个页面依旧各自整窗显示，不把窗口分成两半；
            标签本身是一层浮在主区右缘的抽屉：absolute 定位，不占主区宽度，
            右侧圆角 + 投影让它读起来是「浮在上面」而不是「右边栏」。
            底部有收起按钮，收起后只留右缘一枚小把手，点把手再展开。
            抽屉上沿压在面板标题栏之下：侧面板的关闭按钮就在右上角，
            两者重叠的话面板一旦打开就点不掉了。 */}
        <div className="pd-page-drawer">
          {pageTabsOpen ? (
            <nav aria-label="页面切换" className="right-rail pd-page-drawer-panel">
              <button
                type="button"
                aria-pressed={!showArtifacts && displayActiveTab === 'chat'}
                data-pane-state={!showArtifacts && displayActiveTab === 'chat' ? 'on' : 'off'}
                onClick={() => { setShowArtifacts(false); setActiveTab('chat'); leaveReviewPanel(); }}
                className={!showArtifacts && displayActiveTab === 'chat' ? 'active' : ''}
              >
                <span>对话</span>
              </button>
              {projectFilesEnabled ? (
                <button
                  type="button"
                  aria-pressed={!showArtifacts && displayActiveTab === FILES_TAB.id}
                  data-pane-state={!showArtifacts && displayActiveTab === FILES_TAB.id ? 'on' : 'off'}
                  onClick={() => { setShowArtifacts(false); setActiveTab(FILES_TAB.id); leaveReviewPanel(); }}
                  className={!showArtifacts && displayActiveTab === FILES_TAB.id ? 'active' : ''}
                >
                  <span>文件</span>
                </button>
              ) : null}
              <button
                type="button"
                aria-pressed={!showArtifacts && displayActiveTab === REVIEW_TAB.id}
                data-pane-state={!showArtifacts && displayActiveTab === REVIEW_TAB.id ? 'on' : 'off'}
                onClick={openChangesPage}
                className={!showArtifacts && displayActiveTab === REVIEW_TAB.id ? 'active' : ''}
              >
                <span>改动</span>
              </button>
              <button
                type="button"
                aria-pressed={showArtifacts}
                data-pane-state={showArtifacts ? 'on' : 'off'}
                onClick={() => { leaveReviewPanel(); setShowArtifacts(true); }}
                className={showArtifacts ? 'active' : ''}
              >
                <span>成果</span>
              </button>
              <span aria-hidden="true" className="pd-page-drawer-divider" />
              <button
                type="button"
                aria-label="收起页面标签"
                title="收起页面标签"
                onClick={() => setPageTabsOpen(false)}
                className="pd-page-drawer-toggle"
              >
                <PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.9} />
              </button>
            </nav>
          ) : (
            <button
              type="button"
              aria-label="展开页面标签"
              title="展开页面标签"
              aria-expanded={false}
              onClick={() => setPageTabsOpen(true)}
              className="pd-page-drawer-handle"
            >
              <PanelRightOpen className="h-4 w-4" strokeWidth={1.9} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MainAreaV2(props: MainAreaV2Props) {
  if (props.activeTab === 'cron') {
    return (
      <ScheduledTasksArea
        isSidebarCollapsed={props.isSidebarCollapsed}
        onOpenSidebar={props.onOpenSidebar}
      />
    );
  }

  if (props.activeTab === 'skills') {
    return (
      <SkillsArea
        isSidebarCollapsed={props.isSidebarCollapsed}
        onOpenSidebar={props.onOpenSidebar}
        selectedProject={props.selectedProject}
        projects={props.projects}
      />
    );
  }

  const generalConversation = Boolean(
    props.selectedProject && isGeneralProject(props.selectedProject),
  );
  const fileScope = props.activeTab === 'files'
    && !generalConversation
    && props.selectedProject?.capabilities?.files !== false;

  return (
    <FindShortcutProvider activeScope={fileScope ? 'file' : 'chat'}>
      <ChatHistorySearchControllerProvider>
        <MainAreaV2Content {...props} />
      </ChatHistorySearchControllerProvider>
    </FindShortcutProvider>
  );
}
