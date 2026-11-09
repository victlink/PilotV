import ArtifactsConsolePane from './ArtifactsConsolePane';
import TaskMonitorPanel from './TaskMonitorPanel';
import TaskSessionStats from './TaskSessionStats';
import { usePendingConfirmations } from './usePendingConfirmations';
import { FileConversationContext } from '../main-content-v2/fileConversationContext';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Database, Folder, GitBranch, Library, PanelsTopLeft, PanelLeftOpen, PanelRightClose, PanelRightOpen, Radio, type LucideIcon } from 'lucide-react';
import type { ConversationSkill } from '../../contexts/SkillConversationContext';
import type { AlwaysOnSubTab, AppTab, Project, ProjectSession } from '../../types/app';
import MainContent from '../main-content/view/MainContent';
import { ChatHistorySearchControllerProvider } from '../chat/view/ChatHistorySearchController';
import type { MainContentProps } from '../main-content/types/types';
import { projectDisplayName, sessionDisplayTitle, setSessionCustomTitle, useCustomNamesVersion } from '../../lib/customNames';
import { isImeEnterEvent } from '../../utils/ime';
import { isGeneralProject } from './appShellSelection';
import { REVIEW_CLOSE_EVENT } from '../chat-review/reviewEvents';
import ApprovalSessionPanel from '../approval-session/ApprovalSessionPanel';

const CronPanel = lazy(() => import('../cron/view/CronPanel'));
const SkillsPanel = lazy(() => import('../skills/view/SkillsPanel'));

function DedicatedWorkspacePage({ title, isSidebarCollapsed, onOpenSidebar, children }: {
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
          <button type="button" onClick={onOpenSidebar}
            aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="workspace-title flex-1">
          <h1 className="min-w-0 truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50">{title}</h1>
        </div>
      </header>
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
function PageFallback() {
  return <div className="flex h-full w-full items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" /></div>;
}
function ApprovalSessionArea({ isSidebarCollapsed, onOpenSidebar }: { isSidebarCollapsed?: boolean; onOpenSidebar?: () => void }) {
  return <DedicatedWorkspacePage title="审批会话" isSidebarCollapsed={isSidebarCollapsed} onOpenSidebar={onOpenSidebar}><ApprovalSessionPanel /></DedicatedWorkspacePage>;
}
function ScheduledTasksArea({ isSidebarCollapsed, onOpenSidebar }: { isSidebarCollapsed?: boolean; onOpenSidebar?: () => void }) {
  const { t } = useTranslation();
  return (
    <DedicatedWorkspacePage title={t('sidebar:quickActions.scheduledTasks', { defaultValue: 'Scheduled Tasks' })} isSidebarCollapsed={isSidebarCollapsed} onOpenSidebar={onOpenSidebar}>
      <Suspense fallback={<PageFallback />}><CronPanel /></Suspense>
    </DedicatedWorkspacePage>
  );
}
function SkillsArea({ isSidebarCollapsed, onOpenSidebar, selectedProject, projects, onSkillsProjectChange, onUseSkill }: {
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  selectedProject: Project | null;
  projects: Project[];
  onSkillsProjectChange?: (project: Project | null) => void;
  onUseSkill?: (skill: ConversationSkill, project: Project | null) => void;
}) {
  return (
    <div className="pd-workspace-content relative flex h-full min-h-0 min-w-0 flex-col bg-white dark:bg-neutral-950">
      <Suspense fallback={<PageFallback />}>
        <SkillsPanel onProjectChange={onSkillsProjectChange} onUseSkill={onUseSkill} selectedProject={selectedProject} projects={projects} isSidebarCollapsed={isSidebarCollapsed} onOpenSidebar={onOpenSidebar} />
      </Suspense>
    </div>
  );
}

// 项目室撤掉了：每个对话自己就是项目室，不恢复独立房间列表。
type Tab = { id: AppTab; labelKey: string; icon: LucideIcon };
const FILES_TAB: Tab = { id: 'files', labelKey: 'tabs.files', icon: Folder };
// 改动页仍由侧栏事件打开，不在右侧页面抽屉里重复入口。
const REVIEW_TAB: Tab = { id: 'git', labelKey: 'dashboardSwitcher.changes', icon: GitBranch };
const DASHBOARD_TABS: Tab[] = [
  { id: 'dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
  { id: 'memory', labelKey: 'tabs.memory', icon: Database },
  { id: 'always-on', labelKey: 'tabs.alwaysOn', icon: Radio },
  { id: 'weknora', labelKey: 'tabs.weknora', icon: Library },
];

type MainAreaProps = MainContentProps & {
  onSkillsProjectChange?: (project: Project | null) => void;
  onUseSkill?: (skill: ConversationSkill, project: Project | null) => void;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  onNavigateToSession?: (sessionId: string) => void;
};
const PAGE_TABS_STORAGE_KEY = 'pilotdeck:pageTabsOpen';
function readPageTabsOpen() {
  try { return localStorage.getItem(PAGE_TABS_STORAGE_KEY) !== 'collapsed'; }
  catch { return true; }
}

function MainAreaContent(props: MainAreaProps) {
  const { t } = useTranslation();
  const { selectedProject, selectedSession, activeTab, setActiveTab, isSidebarCollapsed, onOpenSidebar, onStartNewSession } = props;
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
    try { localStorage.setItem(PAGE_TABS_STORAGE_KEY, pageTabsOpen ? 'expanded' : 'collapsed'); }
    catch { /* Storage may be unavailable. */ }
  }, [pageTabsOpen]);
  const generalConversation = Boolean(selectedProject && isGeneralProject(selectedProject));
  const projectFilesEnabled = Boolean(selectedProject && !generalConversation && selectedProject.capabilities?.files !== false);
  const projectExploreEnabled = Boolean(selectedProject && !generalConversation && selectedProject.capabilities?.explore !== false);
  const activeTabIsUnavailable = (activeTab === 'files' && !projectFilesEnabled) || (DASHBOARD_TABS.some((tab) => tab.id === activeTab) && !projectExploreEnabled);
  const displayActiveTab = activeTab === 'home' || activeTabIsUnavailable ? 'chat' : activeTab;
  useEffect(() => {
    if (activeTab === 'home' || activeTabIsUnavailable) setActiveTab('chat');
  }, [activeTab, activeTabIsUnavailable, setActiveTab]);

  // 评审面板在对话子树中，重复点击仍应产生新的打开请求。
  const openChangesPage = useCallback(() => {
    setShowArtifacts(false);
    setActiveTab(REVIEW_TAB.id);
    setReviewOpenRequest(previous => ({ tab: 'changes', sequence: (Number(previous?.sequence) || 0) + 1 }));
  }, [setActiveTab]);
  useEffect(() => {
    window.addEventListener('pilotdeck:open-changes', openChangesPage);
    return () => window.removeEventListener('pilotdeck:open-changes', openChangesPage);
  }, [openChangesPage]);
  const leaveReviewPanel = useCallback(() => window.dispatchEvent(new Event(REVIEW_CLOSE_EVENT)), []);
  useCustomNamesVersion();
  const activeDashboardTab = DASHBOARD_TABS.find((tab) => tab.id === displayActiveTab) ?? null;
  const tabLabelKey = displayActiveTab === FILES_TAB.id ? FILES_TAB.labelKey : activeDashboardTab?.labelKey;
  const tabLabel = tabLabelKey ? t(tabLabelKey) : displayActiveTab.startsWith('plugin:') ? displayActiveTab.replace('plugin:', '') : displayActiveTab;
  const sessionSummary = selectedSession ? sessionDisplayTitle(selectedSession) : '';
  const projectName = selectedProject
    ? isGeneralProject(selectedProject) ? t('sidebar:general.name', { defaultValue: 'General conversation' }) : projectDisplayName(selectedProject)
    : t('sidebar:general.name', { defaultValue: 'General conversation' });
  const headerTitle = sessionSummary || (displayActiveTab === FILES_TAB.id ? tabLabel || projectName : projectName);
  const isRenamingSessionTitle = Boolean(selectedSession && renamingSessionId === selectedSession.id);
  useEffect(() => {
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  }, [selectedSession?.id]);
  const startConversationFromInk = useCallback(() => {
    const target = selectedProject ?? props.projects.find(isGeneralProject) ?? props.projects[0];
    if (target) onStartNewSession?.(target);
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
          // PilotV 标识留在侧栏，折叠后这里只显示打开侧栏按钮。
          <button type="button" onClick={onOpenSidebar}
            aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="workspace-title flex min-w-0 flex-1 items-center gap-3">
          {/* 顶栏只留面包屑，页面切换保留在右侧悬浮抽屉。 */}
          <div className="flex min-w-0 items-center gap-1.5">
            <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
            <span className="min-w-0 max-w-[24rem] truncate text-[12px] text-neutral-500 dark:text-neutral-400" title={projectName}>{projectName}</span>
            {selectedSession ? <span aria-hidden="true" className="shrink-0 text-neutral-400 dark:text-neutral-500">/</span> : null}
            {isRenamingSessionTitle ? (
              <input ref={sessionTitleInputRef} value={sessionTitleDraft} onChange={(event) => setSessionTitleDraft(event.target.value)} onBlur={commitSessionTitleRename}
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
                className="h-6 min-w-0 max-w-[34rem] rounded border border-neutral-300 bg-white px-1.5 text-[15px] font-semibold leading-5 text-neutral-950 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50" />
            ) : selectedSession ? (
              <h1 className="min-w-0 max-w-[34rem] truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50 cursor-text" title={headerTitle} data-desktop-no-drag="" onDoubleClick={beginSessionTitleRename}>{headerTitle}</h1>
            ) : null}
          </div>
          <button type="button" onClick={() => setTaskMonitorOpen(value => !value)} aria-expanded={taskMonitorOpen} aria-label={t('sidebar:tasks.toggle')} title={t('sidebar:tasks.toggle')}
            className={`ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${taskMonitorOpen
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
              : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}>
            <PanelsTopLeft className="h-4 w-4" aria-hidden />{t('sidebar:tasks.toggle')}
          </button>
        </div>
      </header>
      <TaskSessionStats sessionId={selectedSession?.id ?? null} />
      {taskMonitorOpen ? (
        <TaskMonitorPanel projects={props.projects} processingSessions={props.processingSessions} unreadSessionIds={props.unreadSessionIds} pendingConfirmations={pendingConfirmations} selectedSessionId={selectedSession?.id}
          onOpenSession={entry => {
            setTaskMonitorOpen(false);
            setShowArtifacts(false);
            if (props.onNavigateToSession) props.onNavigateToSession(entry.session.id);
            else props.onSelectSession?.(entry.project, entry.session.id);
          }} onClose={() => setTaskMonitorOpen(false)} />
      ) : null}
      <div className="relative z-0 flex min-h-0 flex-1 overflow-hidden">
        {showArtifacts && <div className="min-h-0 flex-1 overflow-hidden"><ArtifactsConsolePane sessionId={selectedSession?.id} projectName={selectedProject?.name} onStartNewConversation={startConversationFromInk} /></div>}
        {/* Keep chat mounted so switching views does not discard the composer. */}
        <div hidden={showArtifacts} className={showArtifacts ? 'hidden' : 'relative min-h-0 flex-1 overflow-hidden'}>
          <FileConversationContext.Provider value={{ id: selectedSession?.id, cwd: typeof selectedSession?.cwd === 'string' ? selectedSession.cwd : undefined }}>
            <MainContent {...props} activeTab={displayActiveTab} reviewOpenRequest={reviewOpenRequest} alwaysOnSubTab={alwaysOnSubTab} onAlwaysOnSubTabChange={setAlwaysOnSubTab} />
          </FileConversationContext.Provider>
        </div>
        {/* 抽屉不占内容宽度；改动页只保留侧栏事件入口。 */}
        <div className="pd-page-drawer">
          {pageTabsOpen ? (
            <nav aria-label="页面切换" className="right-rail pd-page-drawer-panel">
              <button type="button" aria-pressed={!showArtifacts && displayActiveTab === 'chat'} data-pane-state={!showArtifacts && displayActiveTab === 'chat' ? 'on' : 'off'}
                onClick={() => { setShowArtifacts(false); setActiveTab('chat'); leaveReviewPanel(); }} className={!showArtifacts && displayActiveTab === 'chat' ? 'active' : ''}><span>对话</span></button>
              {projectFilesEnabled ? (
                <button type="button" aria-pressed={!showArtifacts && displayActiveTab === FILES_TAB.id} data-pane-state={!showArtifacts && displayActiveTab === FILES_TAB.id ? 'on' : 'off'}
                  onClick={() => { setShowArtifacts(false); setActiveTab(FILES_TAB.id); leaveReviewPanel(); }} className={!showArtifacts && displayActiveTab === FILES_TAB.id ? 'active' : ''}><span>文件</span></button>
              ) : null}
              <button type="button" aria-pressed={showArtifacts} data-pane-state={showArtifacts ? 'on' : 'off'} onClick={() => { leaveReviewPanel(); setShowArtifacts(true); }} className={showArtifacts ? 'active' : ''}><span>成果</span></button>
              <span aria-hidden="true" className="pd-page-drawer-divider" />
              <button type="button" aria-label="收起页面标签" title="收起页面标签" onClick={() => setPageTabsOpen(false)} className="pd-page-drawer-toggle"><PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.9} /></button>
            </nav>
          ) : (
            <button type="button" aria-label="展开页面标签" title="展开页面标签" aria-expanded={false} onClick={() => setPageTabsOpen(true)} className="pd-page-drawer-handle"><PanelRightOpen className="h-4 w-4" strokeWidth={1.9} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MainArea(props: MainAreaProps) {
  if (props.activeTab === 'approval') return <ApprovalSessionArea isSidebarCollapsed={props.isSidebarCollapsed} onOpenSidebar={props.onOpenSidebar} />;
  if (props.activeTab === 'cron') return <ScheduledTasksArea isSidebarCollapsed={props.isSidebarCollapsed} onOpenSidebar={props.onOpenSidebar} />;
  if (props.activeTab === 'skills') return <SkillsArea onSkillsProjectChange={props.onSkillsProjectChange} onUseSkill={props.onUseSkill} isSidebarCollapsed={props.isSidebarCollapsed} onOpenSidebar={props.onOpenSidebar} selectedProject={props.selectedProject} projects={props.projects} />;
  return <ChatHistorySearchControllerProvider><MainAreaContent {...props} /></ChatHistorySearchControllerProvider>;
}
