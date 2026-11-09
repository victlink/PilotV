import { useDesktopCommands } from '../desktop/useDesktopCommands';
import { useAuth } from '../auth/context/AuthContext';
import { SessionViewReadyContext, useSessionIndicators } from './useSessionIndicators';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactDOM from 'react-dom';
import {
  SkillConversationContext,
  type ConversationSkill,
  type SkillConversationRequest,
} from '../../contexts/SkillConversationContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import Settings from '../settings/Settings';
import CreateWorkspaceModal from '../onboarding/view/subcomponents/CreateWorkspaceModal';
import { normalizeProjectForSettings, type SettingsProject } from '../../lib/projectSettings';
import { sessionDisplayTitle, setSessionCustomTitle } from '../../lib/customNames';
import {
  getSessionRequestParams,
  isBackgroundTaskSession,
  type AppTab,
  type Project,
  type ProjectSession,
} from '../../types/app';
import { api } from '../../utils/api';
import { useRejectExternalFileDropOutsideTargets } from '../../utils/externalFileDrop';
import { resolveMarkdownFileHref } from '../chat/utils/resolveMarkdownFileHref';
import type { SessionNavigationOptions } from '../main-content/types/types';
import { getSettingsPathFromTab } from '../settings/navigation';
import { ConnectionBanner } from '../ui/ConnectionBanner';
import Sidebar from './Sidebar';
import MainArea from './MainArea';
import GlobalSearchDialog from '../global-search/GlobalSearchDialog';
import { GlobalSearchProvider, useGlobalSearch, type GlobalSearchResult } from '../global-search/GlobalSearchContext';
import { useWorkspaceUpload } from '../file-tree/hooks/useWorkspaceUpload';
import { chooseDefaultProject, resolveHomeNewConversationProject } from './appShellSelection';
import {
  APPROVAL_SESSION_PATH,
  getDedicatedTabPath,
  LEGACY_SESSION_PATH,
  PROJECT_CHAT_PATH,
  PROJECT_PATH,
  resolveDedicatedTab,
  SCHEDULED_TASKS_PATH,
  SETTINGS_PATH,
  SKILLS_PATH,
  WINDOWS_PATH,
  useSettingsRouteMatch,
} from './appRoutes';
import { isEmbeddedView, shouldShowEmbeddedSidebar } from './embedMode';

type TypedSettingsProps = {
  onClose: () => void;
  projects: SettingsProject[];
  section?: string;
};
type DeleteSessionTarget = { project: Project; session: ProjectSession };
const SettingsComponent = Settings as unknown as (props: TypedSettingsProps) => React.JSX.Element;

// The application shell owns navigation and shared project/session state.
export default function AppShell() {
  const { user } = useAuth();
  return <GlobalSearchProvider userKey={String(user?.id ?? user?.username ?? 'local')}><AppShellContent /></GlobalSearchProvider>;
}

function AppShellContent() {
  const globalSearch = useGlobalSearch();
  useRejectExternalFileDropOutsideTargets();
  const navigate = useNavigate();
  const [skillConversationRequest, setSkillConversationRequest] = useState<SkillConversationRequest | null>(null);
  const consumeSkillConversation = useCallback((id: string) => {
    setSkillConversationRequest((request) => (request?.id === id ? null : request));
  }, []);
  // A single wildcard route owns this shell so state survives URL transitions.
  const matchProjectChat = useMatch(PROJECT_CHAT_PATH);
  const matchProject = useMatch(PROJECT_PATH);
  const matchLegacySession = useMatch(LEGACY_SESSION_PATH);
  const matchScheduledTasks = useMatch(SCHEDULED_TASKS_PATH);
  const matchSkills = useMatch(SKILLS_PATH);
  const matchApprovalSession = useMatch(APPROVAL_SESSION_PATH);
  const matchWindows = useMatch(WINDOWS_PATH);
  const settingsRouteMatch = useSettingsRouteMatch();
  const isSettingsRoute = Boolean(settingsRouteMatch);
  const settingsSection = settingsRouteMatch?.params.section;
  // 多窗口工作区的每个窗格都是同源 iframe。嵌进去的实例不渲染侧栏，
  // 也不再提供「多窗口」入口，否则窄格里会无限嵌套出新的工作区。
  const isEmbedded = isEmbeddedView();
  // ?embed=1&sidebar=1 让单个窗格按需展开该设备自己的侧栏。
  const hideEmbeddedSidebar = Boolean(matchWindows) || (isEmbedded && !shouldShowEmbeddedSidebar());
  const dedicatedTab = resolveDedicatedTab({
    skills: Boolean(matchSkills),
    cron: Boolean(matchScheduledTasks),
    approval: Boolean(matchApprovalSession),
    windows: Boolean(matchWindows),
  });
  const isDedicatedRoute = dedicatedTab !== null || isSettingsRoute;
  const projectNameParam = matchProjectChat?.params.projectName ?? matchProject?.params.projectName ?? undefined;
  const sessionId = matchProjectChat?.params.sessionId ?? matchLegacySession?.params.sessionId ?? undefined;
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const { ws, sendMessage, isConnected, subscribe } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const { user } = useAuth();
  const [readySessionId, setReadySessionId] = useState<string | null>(null);
  const {
    activeSessions,
    processingSessions: localProcessingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  } = useSessionProtection();
  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    externalMessageUpdateTarget,
    setActiveTab,
    setSelectedSession,
    setSidebarOpen,
    setIsInputFocused,
    refreshProjectsSilently,
    addCreatedProject,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleDeselectProject,
    handleResetProjectSessionPreview,
    setSelectedProject,
    draftSessionProjectName,
    loadMoreSessions,
    loadingMoreProjectIds,
    bumpSessionActivity,
    replaceOptimisticInProjects,
    dropOptimisticInProjects,
  } = useProjectsState({ sessionId, navigate, subscribe, isMobile, activeSessions });
  const shownWorkspaceNotice = useRef('');
  useEffect(() => {
    const general = sidebarSharedProps.projects.find(project => project.name === 'general');
    const notice = general?.workspaceNotice;
    if (!notice && !general?.workspaceUnavailable) return;
    const key = JSON.stringify({ notice, unavailable: general?.workspaceUnavailable, profile: general?.fullPath });
    if (shownWorkspaceNotice.current === key) return;
    shownWorkspaceNotice.current = key;
    try {
      if (localStorage.getItem('pilotdeck-workspace-notice') === key) return;
      localStorage.setItem('pilotdeck-workspace-notice', key);
    } catch { /* The per-mount guard still prevents repeated notifications. */ }
    window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: {
      kind: general?.workspaceUnavailable ? 'error' : 'info',
      message: general?.workspaceUnavailable ? t('settings:generalWorkspace.unavailableError') : t('settings:generalWorkspace.defaultAdjusted', notice!),
    } }));
  }, [sidebarSharedProps.projects, t]);
  // The wildcard route keeps this owner mounted across dedicated pages too.
  const workspaceUpload = useWorkspaceUpload(selectedProject?.name);
  const workspaceTab = activeTab === 'cron' || activeTab === 'skills' ? 'chat' : activeTab;
  const shellActiveTab = dedicatedTab ?? workspaceTab;
  const notificationSessionNames = useMemo(() => Object.fromEntries(sidebarSharedProps.projects.flatMap(project =>
    (project.sessions ?? []).map(session => [session.id, sessionDisplayTitle(session)]))), [sidebarSharedProps.projects]);
  const { processingSessions: remoteProcessingSessions, waitingSessions, unreadSessionIds, markRead, acknowledge, selectSession: acknowledgeNavigation } = useSessionIndicators({
    scope: String(user?.id ?? 'local'),
    viewedSessionId: !isSettingsRoute && shellActiveTab === 'chat' && selectedSession?.id === readySessionId ? readySessionId : null,
    subscribe, sendMessage, isConnected,
    sessionNames: notificationSessionNames,
  });
  // Composer callbacks cover the interval before the server sees a new send.
  const processingSessions = useMemo(() => new Set([...localProcessingSessions, ...remoteProcessingSessions]), [localProcessingSessions, remoteProcessingSessions]);
  useEffect(() => subscribe(message => {
    if (message?.type === 'session-activity' && !message.activity?.processing) markSessionAsNotProcessing(message.activity?.sessionId);
    if (message?.type === 'session-activity-snapshot' && Array.isArray(message.activities)) {
      const running = new Set(message.activities.filter((item: any) => item.processing).map((item: any) => item.sessionId));
      for (const id of localProcessingSessions) if (!running.has(id)) markSessionAsNotProcessing(id);
    }
  }), [subscribe, localProcessingSessions, markSessionAsNotProcessing]);

  const misroutedFileFromUrl = useMemo(() => {
    if (!sessionId) return null;
    const filePath = resolveMarkdownFileHref(`/session/${sessionId}`);
    if (!filePath) return null;
    if (isLoadingProjects) return filePath;
    const hasMatchingSession = sidebarSharedProps.projects.some((project) =>
      (project.sessions ?? []).some((session) => session.id === sessionId));
    return hasMatchingSession ? null : filePath;
  }, [sessionId, isLoadingProjects, sidebarSharedProps.projects]);
  const handleMisroutedFileUrlHandled = useCallback(() => {
    const target = selectedProject ? `/p/${encodeURIComponent(selectedProject.name)}` : '/';
    navigate(target, { replace: true });
  }, [navigate, selectedProject]);

  // Session URLs are resolved atomically by useProjectsState.
  useEffect(() => {
    if (!projectNameParam || sessionId || selectedProject?.name === projectNameParam) return;
    const target = sidebarSharedProps.projects.find((p) => p.name === projectNameParam);
    if (target) {
      handleProjectSelect(target);
      navigate(`/p/${encodeURIComponent(projectNameParam)}`, { replace: true });
    }
  }, [projectNameParam, sessionId, selectedProject?.name, sidebarSharedProps.projects, handleProjectSelect, navigate]);
  const didDefaultProjectRef = useRef(false);
  useEffect(() => {
    if (didDefaultProjectRef.current || isLoadingProjects) return;
    if (selectedProject || projectNameParam || sessionId) {
      didDefaultProjectRef.current = true;
      return;
    }
    const target = chooseDefaultProject(sidebarSharedProps.projects);
    if (!target) return;
    if (isDedicatedRoute) {
      setSelectedProject(target);
      didDefaultProjectRef.current = true;
      return;
    }
    handleProjectSelect(target);
    navigate(`/p/${encodeURIComponent(target.name)}`, { replace: true });
    didDefaultProjectRef.current = true;
  }, [isLoadingProjects, selectedProject, projectNameParam, sessionId, isDedicatedRoute, sidebarSharedProps.projects, handleProjectSelect, navigate, setSelectedProject]);
  useEffect(() => {
    window.refreshProjects = refreshProjectsSilently;
    return () => {
      if (window.refreshProjects === refreshProjectsSilently) delete window.refreshProjects;
    };
  }, [refreshProjectsSilently]);
  const openSettingsPage = useCallback((tab = 'appearance') => {
    navigate(getSettingsPathFromTab(tab));
  }, [navigate]);
  useEffect(() => {
    window.openSettings = openSettingsPage;
    return () => {
      if (window.openSettings === openSettingsPage) delete window.openSettings;
    };
  }, [openSettingsPage]);
  const switchProject = useCallback((projectName: string): boolean => {
    const trimmed = (projectName ?? '').trim();
    if (!trimmed) return false;
    const list = sidebarSharedProps.projects;
    const exact = list.find((p) => p.name === trimmed);
    const ciExact = exact ?? list.find((p) =>
      p.name.toLowerCase() === trimmed.toLowerCase() ||
      (p.displayName ?? '').toLowerCase() === trimmed.toLowerCase());
    const fuzzy = ciExact ?? list.find((p) =>
      p.name.toLowerCase().includes(trimmed.toLowerCase()) ||
      (p.displayName ?? '').toLowerCase().includes(trimmed.toLowerCase()));
    if (!fuzzy) return false;
    handleProjectSelect(fuzzy);
    navigate(`/p/${encodeURIComponent(fuzzy.name)}`);
    return true;
  }, [handleProjectSelect, navigate, sidebarSharedProps.projects]);
  useEffect(() => {
    window.switchProject = switchProject;
    return () => {
      if (window.switchProject === switchProject) delete window.switchProject;
    };
  }, [switchProject]);
  useEffect(() => {
    if (typeof navigator === 'undefined') return undefined;
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') return;
      if (user?.id !== undefined && message.scope && String(user.id) !== message.scope) return;
      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();
      if (typeof message.sessionId === 'string' && message.sessionId) {
        acknowledgeNavigation(message.sessionId);
        navigate(`/session/${encodeURIComponent(message.sessionId)}`);
        return;
      }
      navigate('/');
    };
    const handleNativeNavigation = (data: any) => handleServiceWorkerMessage({ data: { ...data, type: 'notification:navigate' } } as MessageEvent);
    const handleBrowserNavigation = (event: Event) => handleNativeNavigation((event as CustomEvent).detail);
    const unsubscribeNative = window.pilotdeckDesktop?.onNotificationNavigate?.(handleNativeNavigation);
    window.addEventListener('pilotdeck:notification-navigate', handleBrowserNavigation);
    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);
    return () => {
      unsubscribeNative?.();
      window.removeEventListener('pilotdeck:notification-navigate', handleBrowserNavigation);
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen, acknowledgeNavigation, user?.id]);
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;
    if (isReconnect) wasConnectedRef.current = true;
    else if (!isConnected) wasConnectedRef.current = false;
    if (isConnected && selectedSession?.id) sendMessage({ type: 'get-pending-permissions', sessionId: selectedSession.id });
  }, [isConnected, selectedSession?.id, sendMessage]);
  const onShowSettings = useCallback(() => navigate(SETTINGS_PATH), [navigate]);
  const onCloseSettings = useCallback(() => {
    const target = selectedSession ? `/session/${selectedSession.id}` : selectedProject ? `/p/${encodeURIComponent(selectedProject.name)}` : '/';
    navigate(target);
  }, [navigate, selectedProject, selectedSession]);
  const onMenuClick = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const onCollapseSidebar = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    else setDesktopSidebarOpen(false);
  }, [isMobile, setSidebarOpen]);
  const onOpenDesktopSidebar = useCallback(() => setDesktopSidebarOpen(true), []);
  useEffect(() => {
    if (!isMobile && activeTab === 'files') setDesktopSidebarOpen(true);
  }, [activeTab, isMobile]);

  const [showNewProject, setShowNewProject] = useState(false);
  const handleOpenNewProject = useCallback(() => setShowNewProject(true), []);
  const handleCloseNewProject = useCallback(() => setShowNewProject(false), []);
  const handleProjectCreated = useCallback((project?: Record<string, unknown>) => {
    setShowNewProject(false);
    const projectName = typeof project?.name === 'string' ? project.name : '';
    if (!projectName) {
      void refreshProjectsSilently();
      return;
    }
    const newProject = project as Project;
    addCreatedProject(newProject);
    handleNewSession(newProject);
    navigate(`/p/${encodeURIComponent(projectName)}`);
    setActiveTab('chat');
  }, [addCreatedProject, handleNewSession, navigate, refreshProjectsSilently, setActiveTab]);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const handleRequestDeleteProject = useCallback((project: Project) => {
    setDeleteError(null);
    setDeleteTarget(project);
  }, []);
  const handleCancelDelete = useCallback(() => {
    if (isDeletingProject) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, [isDeletingProject]);
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setIsDeletingProject(true);
    setDeleteError(null);
    try {
      const response = await api.deleteProject(target.name, true);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || t('uiText.httpFailed', { status: response.status }));
      }
      sidebarSharedProps.onProjectDelete?.(target.name);
      await refreshProjectsSilently();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('uiText.deleteProjectFailed'));
    } finally {
      setIsDeletingProject(false);
    }
  }, [deleteTarget, refreshProjectsSilently, sidebarSharedProps, t]);
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<DeleteSessionTarget | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
  const handleRequestDeleteSession = useCallback((project: Project, session: ProjectSession) => {
    setDeleteSessionError(null);
    setDeleteSessionTarget({ project, session });
  }, []);
  const handleCancelDeleteSession = useCallback(() => {
    if (isDeletingSession) return;
    setDeleteSessionTarget(null);
    setDeleteSessionError(null);
  }, [isDeletingSession]);
  const handleConfirmDeleteSession = useCallback(async () => {
    if (!deleteSessionTarget) return;
    const { project, session } = deleteSessionTarget;
    setIsDeletingSession(true);
    setDeleteSessionError(null);
    try {
      const response = isBackgroundTaskSession(session)
        ? await api.deleteSession(project.name, session.id, getSessionRequestParams(session))
        : await api.deleteSession(project.name, session.id);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || t('uiText.httpFailed', { status: response.status }));
      }
      sidebarSharedProps.onSessionDelete?.(session.id);
      markRead(session.id);
      setSessionCustomTitle(session.id, null);
      await refreshProjectsSilently();
      setDeleteSessionTarget(null);
    } catch (err) {
      setDeleteSessionError(err instanceof Error ? err.message : t('uiText.deleteSessionFailed'));
    } finally {
      setIsDeletingSession(false);
    }
  }, [deleteSessionTarget, refreshProjectsSilently, sidebarSharedProps, t, markRead]);
  const handleSelectProject = useCallback((project: Project) => {
    handleProjectSelect(project);
    navigate(`/p/${encodeURIComponent(project.name)}`);
  }, [handleProjectSelect, navigate]);
  const handleSelectSession = useCallback((project: Project, sessId: string, fallbackSession?: ProjectSession, options?: SessionNavigationOptions) => {
    acknowledgeNavigation(sessId);
    if (project.name !== selectedProject?.name) handleProjectSelect(project);
    const target = (project.sessions ?? []).find((s) => s.id === sessId);
    if (target) handleSessionSelect(fallbackSession ? { ...target, ...fallbackSession } : target);
    else if (fallbackSession) handleSessionSelect(fallbackSession);
    else navigate(`/session/${sessId}`);
    if (!options?.preserveActiveTab) setActiveTab('chat');
    // 手机侧栏是抽屉，选完会话收起，避免遮住成果台。
    if (isMobile) setSidebarOpen(false);
  }, [handleProjectSelect, handleSessionSelect, navigate, selectedProject?.name, setActiveTab, acknowledgeNavigation, isMobile, setSidebarOpen]);
  const workspacePath = selectedSession ? `/session/${selectedSession.id}` : selectedProject ? `/p/${encodeURIComponent(selectedProject.name)}` : '/';
  const handleSelectTab = useCallback((tab: AppTab) => {
    const dedicatedPath = getDedicatedTabPath(tab);
    if (dedicatedPath) {
      if (dedicatedTab !== tab) navigate(dedicatedPath);
      return;
    }
    if (tab === 'home') {
      acknowledgeNavigation(null);
      setSelectedSession(null);
      const target = selectedProject ? `/p/${encodeURIComponent(selectedProject.name)}` : '/';
      if (window.location.pathname !== target) navigate(target);
      setActiveTab('chat');
      return;
    }
    if (isDedicatedRoute) navigate(workspacePath);
    setActiveTab(tab);
  }, [dedicatedTab, isDedicatedRoute, navigate, selectedProject, setActiveTab, setSelectedSession, workspacePath, acknowledgeNavigation]);
  const handleStartNewSession = useCallback((project: Project, options?: SessionNavigationOptions) => {
    didDefaultProjectRef.current = true;
    acknowledgeNavigation(null);
    handleNewSession(project);
    navigate(`/p/${encodeURIComponent(project.name)}`);
    setActiveTab(options?.preserveActiveTab ? 'files' : 'chat');
  }, [handleNewSession, navigate, setActiveTab, acknowledgeNavigation]);
  const handleSkillsProjectChange = useCallback((project: Project | null) => {
    acknowledgeNavigation(null);
    setSelectedProject(project);
    setSelectedSession(null);
  }, [acknowledgeNavigation, setSelectedProject, setSelectedSession]);
  const handleUseSkill = useCallback((skill: ConversationSkill, project: Project | null) => {
    const target = project ?? sidebarSharedProps.projects.find((item) => item.name === 'general');
    const projectPath = target?.fullPath || target?.path;
    if (!target || !projectPath) return;
    setSkillConversationRequest({ id: crypto.randomUUID(), projectPath, skill });
    handleStartNewSession(target);
  }, [sidebarSharedProps.projects, handleStartNewSession]);
  const handleHomeNewConversation = useCallback(() => {
    const draftProject = resolveHomeNewConversationProject({ selectedProject, selectedSession, projectNameParam, projects: sidebarSharedProps.projects });
    if (draftProject) handleStartNewSession(draftProject);
  }, [handleStartNewSession, projectNameParam, selectedProject, selectedSession, sidebarSharedProps.projects]);
  useDesktopCommands({
    canNewConversation: !isLoadingProjects && Boolean(resolveHomeNewConversationProject({ selectedProject, selectedSession, projectNameParam, projects: sidebarSharedProps.projects })),
    hasProject: Boolean(selectedProject && selectedProject.capabilities?.files !== false && selectedProject.kind !== 'general' && selectedProject.name !== 'general'),
    canFind: true,
    sidebarVisible: desktopSidebarOpen && !isSettingsRoute,
    integrateMacCaption: desktopSidebarOpen && !isMobile && !isSettingsRoute && isConnected,
    execute: command => {
      switch (command) {
        case 'new-conversation': handleHomeNewConversation(); break;
        case 'new-project': handleOpenNewProject(); break;
        case 'settings': onShowSettings(); break;
        case 'check-updates':
          if (isSettingsRoute) window.dispatchEvent(new Event('pilotdeck:check-updates'));
          navigate(`${SETTINGS_PATH}/about`);
          break;
        case 'find': window.dispatchEvent(new Event('pilotdeck:find')); break;
        case 'toggle-sidebar':
          if (isSettingsRoute) onCloseSettings();
          setDesktopSidebarOpen(value => isSettingsRoute ? true : !value);
          break;
        case 'chat': handleSelectTab('chat'); break;
        case 'files': handleSelectTab('files'); break;
        case 'skills': handleSelectTab('skills'); break;
        case 'scheduled-tasks': handleSelectTab('cron'); break;
      }
    },
  });
  const handleSessionActivityBump = useCallback((projectName: string, sessionId: string, optimisticTitle?: string, inputId?: string) => {
    return bumpSessionActivity(projectName, sessionId, optimisticTitle, inputId);
  }, [bumpSessionActivity]);
  const handleReplaceTemporarySession = useCallback((realSessionId?: string | null) => {
    replaceTemporarySession(realSessionId);
    if (realSessionId) replaceOptimisticInProjects(realSessionId);
  }, [replaceTemporarySession, replaceOptimisticInProjects]);
  const handleSessionInactive = useCallback((sessionId?: string | null) => {
    markSessionAsInactive(sessionId);
    if (sessionId) dropOptimisticInProjects(sessionId);
  }, [markSessionAsInactive, dropOptimisticInProjects]);
  const sidebar = (
    <Sidebar
      projects={sidebarSharedProps.projects}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      activeTab={shellActiveTab}
      isLoading={isLoadingProjects}
      loadError={sidebarSharedProps.loadError}
      onRetryLoad={sidebarSharedProps.onRetryLoad}
      isMobile={isMobile}
      processingSessions={processingSessions}
      waitingSessions={waitingSessions}
      unreadSessionIds={unreadSessionIds}
      onSelectProject={handleSelectProject}
      onSelectSession={handleSelectSession}
      onStartNewSession={handleStartNewSession}
      onStartHomeNewConversation={handleHomeNewConversation}
      onOpenGlobalSearch={globalSearch?.open}
      onCreateProject={handleOpenNewProject}
      pendingDraftProjectName={draftSessionProjectName}
      onRequestDeleteProject={handleRequestDeleteProject}
      onRequestDeleteSession={handleRequestDeleteSession}
      onSelectTab={handleSelectTab}
      onShowSettings={onShowSettings}
      onOpenProjectSettings={(project) => navigate(`/settings/project-team?projectRoot=${encodeURIComponent(project.fullPath)}`)}
      onDeselectProject={handleDeselectProject}
      onResetProjectSessionPreview={handleResetProjectSessionPreview}
      onCollapse={onCollapseSidebar}
      onLoadMoreSessions={loadMoreSessions}
      loadingMoreProjectIds={loadingMoreProjectIds}
    />
  );
  return (
    <SessionViewReadyContext.Provider value={setReadySessionId}>
      <div className="app-root fixed inset-0 flex flex-col font-sans text-neutral-900 dark:text-neutral-100">
        <ConnectionBanner />
        {isSettingsRoute ? (
          <SettingsComponent onClose={onCloseSettings} projects={sidebarSharedProps.projects.map(normalizeProjectForSettings)} section={settingsSection} />
        ) : null}
        <div className={`app-shell min-h-0 flex-1 ${(!isMobile || isEmbedded) && desktopSidebarOpen && !hideEmbeddedSidebar ? '' : 'sidebar-hidden'}${isSettingsRoute ? ' hidden' : ''}`} aria-hidden={isSettingsRoute}>
          {!hideEmbeddedSidebar ? ((!isMobile || isEmbedded) ? (desktopSidebarOpen ? sidebar : null) : (
            <div className={`mobile-sidebar-drawer fixed inset-0 z-50 flex transition-opacity duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'}`}>
              <button type="button" className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} aria-label={t('uiText.closeSidebar')} />
              <div className={`relative h-full w-[85vw] max-w-sm transform transition-transform duration-150 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
                {sidebar}
              </div>
            </div>
          )) : null}
          <main onClickCapture={acknowledge} onKeyDownCapture={acknowledge} onInputCapture={acknowledge} onWheelCapture={acknowledge} onTouchMoveCapture={acknowledge} className="app-main flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950">
            <SkillConversationContext.Provider value={{ request: skillConversationRequest, consume: consumeSkillConversation }}>
              <MainArea
                isEmbedded={isEmbedded}
                onSkillsProjectChange={handleSkillsProjectChange}
                onUseSkill={handleUseSkill}
                workspaceUpload={workspaceUpload}
                projects={sidebarSharedProps.projects}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                activeTab={shellActiveTab}
                // Keep workspace effects from navigating away from settings.
                setActiveTab={isSettingsRoute ? setActiveTab : handleSelectTab}
                ws={ws}
                sendMessage={sendMessage}
                isMobile={isMobile}
                onMenuClick={onMenuClick}
                isLoading={isLoadingProjects}
                onInputFocusChange={setIsInputFocused}
                onSessionActive={markSessionAsActive}
                onSessionInactive={handleSessionInactive}
                onSessionProcessing={markSessionAsProcessing}
                onSessionNotProcessing={markSessionAsNotProcessing}
                onSessionActivityBump={handleSessionActivityBump}
                processingSessions={processingSessions}
                waitingSessions={waitingSessions}
                unreadSessionIds={unreadSessionIds}
                onReplaceTemporarySession={handleReplaceTemporarySession}
                onNavigateToSession={(sid: string) => {
                  const project = sidebarSharedProps.projects.find(item => item.sessions?.some(session => session.id === sid));
                  if (project) handleSelectSession(project, sid);
                  else {
                    acknowledgeNavigation(sid);
                    setSelectedSession((prev) => prev?.id === sid ? prev : { id: sid } as ProjectSession);
                    setActiveTab('chat');
                    if (isMobile) setSidebarOpen(false);
                    navigate(`/session/${sid}`);
                  }
                }}
                onStartNewSession={handleStartNewSession}
                onCreateProject={handleOpenNewProject}
                onSelectWorkspace={handleStartNewSession}
                onSelectSession={handleSelectSession}
                onShowSettings={onShowSettings}
                onSelectProjectByName={(name: string) => {
                  const target = sidebarSharedProps.projects.find((p) => p.name === name);
                  if (target) {
                    setSelectedProject(target);
                    setSelectedSession(null);
                    setActiveTab('dashboard');
                    navigate(`/p/${encodeURIComponent(target.name)}`);
                  }
                }}
                isSidebarCollapsed={isMobile || !desktopSidebarOpen || hideEmbeddedSidebar}
                onOpenSidebar={isMobile ? onMenuClick : onOpenDesktopSidebar}
                externalMessageUpdate={externalMessageUpdate}
                externalMessageUpdateTarget={externalMessageUpdateTarget}
                misroutedFileFromUrl={misroutedFileFromUrl}
                onMisroutedFileUrlHandled={handleMisroutedFileUrlHandled}
              />
            </SkillConversationContext.Provider>
          </main>
        </div>
        <GlobalSearchDialog projects={sidebarSharedProps.projects} onSelect={(result: GlobalSearchResult, query) => {
          const project = sidebarSharedProps.projects.find(item => item.name === result.project.name) || result.project;
          if (result.kind === 'files') {
            handleSelectProject(project);
            setActiveTab('files');
          } else if (result.sessionId) {
            handleSelectSession(project, result.sessionId, { id: result.sessionId, title: result.title, summary: result.title });
          }
          setSidebarOpen(false);
          globalSearch?.reveal(result, query);
        }} />
        {showNewProject ? ReactDOM.createPortal(<CreateWorkspaceModal onClose={handleCloseNewProject} onProjectCreated={handleProjectCreated} />, document.body) : null}
        {deleteTarget ? ReactDOM.createPortal(<DeleteProjectDialog project={deleteTarget} isDeleting={isDeletingProject} error={deleteError} onCancel={handleCancelDelete} onConfirm={handleConfirmDelete} />, document.body) : null}
        {deleteSessionTarget ? ReactDOM.createPortal(<DeleteSessionDialog target={deleteSessionTarget} isDeleting={isDeletingSession} error={deleteSessionError} onCancel={handleCancelDeleteSession} onConfirm={handleConfirmDeleteSession} />, document.body) : null}
      </div>
    </SessionViewReadyContext.Provider>
  );
}

type DeleteProjectDialogProps = {
  project: Project;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};
function DeleteProjectDialog({ project, isDeleting, error, onCancel, onConfirm }: DeleteProjectDialogProps) {
  const sessionCount = project.sessions?.length ?? 0;
  const displayName = project.displayName || project.name;
  const { t } = useTranslation('common');
  return (
    <ConfirmDialog title={t('confirmDialog.deleteProjectTitle')} destructive busy={isDeleting} error={error} confirmLabel={t('confirmDialog.deleteProject')} onCancel={onCancel} onConfirm={onConfirm}>
      <p className="mb-3 break-all font-medium text-foreground">{displayName}</p>
      <p>{t('confirmDialog.deleteProjectBody')}</p>
      {sessionCount > 0 && <p className="mt-2">{t('confirmDialog.deleteSessions', { count: sessionCount })}</p>}
      <p className="mt-3 text-xs">{t('confirmDialog.keepFiles')}</p>
    </ConfirmDialog>
  );
}
type DeleteSessionDialogProps = {
  target: DeleteSessionTarget;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};
function DeleteSessionDialog({ target, isDeleting, error, onCancel, onConfirm }: DeleteSessionDialogProps) {
  const projectName = target.project.displayName || target.project.name;
  const sessionTitle = sessionDisplayTitle(target.session);
  const { t } = useTranslation('common');
  return (
    <ConfirmDialog title={t('confirmDialog.deleteSessionTitle')} destructive busy={isDeleting} error={error} confirmLabel={t('confirmDialog.deleteSession')} onCancel={onCancel} onConfirm={onConfirm}>
      <p className="mb-3 break-words font-medium text-foreground">{sessionTitle}</p>
      <p>{t('confirmDialog.deleteSessionBody', { project: projectName })}</p>
    </ConfirmDialog>
  );
}
