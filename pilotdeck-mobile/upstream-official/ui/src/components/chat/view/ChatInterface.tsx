import ProjectTeamStrip from './ProjectTeamStrip';
import { collectSpeakers, speakerDisplayLabel } from './agentIdentity';
import ErrorBoundary from '../../main-content/view/ErrorBoundary';
import { useContext } from 'react';
import { SessionViewReadyContext } from '../../app-shell/useSessionIndicators';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useToast } from '../../../contexts/ToastContext';
import { api } from '../../../utils/api';
import type { ChatInterfaceProps, ChatMessage, ChatRunMode, PermissionMode, Provider } from '../types/types';
import { fetchProjectTeam, sessionAgentBinding, sessionExecutionMode, type ExecutionMode, ProjectTeamConflictError, saveProjectTeam } from '../../../lib/projectTeamApi';
import type { ProjectAgentModel, ProjectTeamAgent, ProjectTeamConfig } from '../../../lib/projectTeam';
import { withAgentModel } from './agentModelScope';
import {
  getSessionRequestParams,
  isReadOnlySession,
} from '../../../types/app';
import { chooseDefaultProject, isGeneralProject } from '../../app-shell/appShellSelection';
import { projectDisplayName, useCustomNamesVersion } from '../../../lib/customNames';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionInputQueue } from '../hooks/useSessionInputQueue';
import { isSendingInput } from '../types/queuedInput';
import {
  getEffectiveThinkingMode,
  getThinkingModeAvailability,
} from '../constants/thinkingModeAvailability';
import { thinkingModeToConfig } from '../constants/thinkingModes';
import { useSessionStore } from '../../../stores/useSessionStore';
import { getDraftInputStorageKey, getPilotDeckSettings, safeLocalStorage } from '../utils/chatStorage';
import { buildAttachmentPathNote } from '../utils/attachmentNotes';
import {
  createUserTurnRunId,
  getNotificationSessionSummary,
  regenerateLastSessionCommand,
} from '../utils/sessionLauncher';

/** localStorage key for the composer's auto-drive switch. */
const AUTO_DRIVE_STORAGE_KEY = 'pilotdeck.autoDrive';
import {
  formatContentReferencePromptBlock,
  normalizeContentReference,
  type ContentReference,
} from '../../../types/contentReference';
import { useSessionWatch } from '../../../hooks/useSessionWatch';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import MessagesPane from './MessagesPane';
import { REVIEW_RESTORED_EVENT, useChatReview } from '../../chat-review/ChatReviewContext';
import Composer from './Composer';
import QueuedMessagesTray from './QueuedMessagesTray';
import { buildReconnectStatusMessage, refreshSessionAfterReconnect, shouldRefreshSessionOnReconnect } from '../utils/reconnectRecovery';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

/**
 * Stable empty agent list. It keeps the derived agent list referentially
 * stable while no team configuration is loaded, so the selectors and the
 * composer state are not rebuilt on every render.
 */
const EMPTY_TEAM_AGENTS: ProjectTeamAgent[] = [];

const EDIT_RECONCILIATION_HINT = [
  'The user message immediately before this note is the complete edited request. Follow that request, including its limits on tools and file changes; this note is context only.',
  'The conversation transcript no longer contains the replaced turn, but its tool actions may already have changed the current workspace.',
  'If the edited request calls for workspace changes, inspect existing files as needed and reconcile them with that request rather than assuming earlier work is correct.',
].join(' ');

// Active chat surface. Shared session, streaming, composer and permission logic
// lives in chat/hooks; this module owns how that state is presented.
function ChatInterface({
  selectedProject: selectedProjectFromShell,
  selectedSession,
  ws,
  sendMessage,
  subscribe,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onSessionActivityBump,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showThinking,
  inlineThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  externalMessageUpdateTarget,
  forceWelcome,
  onExitWelcome,
  compact = false,
  projects = [],
  onStartNewSession: _onStartNewSession,
  onSelectWorkspace,
  workspaceBinding = null,
  onCreateProject,
}: ChatInterfaceProps) {
  useCustomNamesVersion();
  const defaultProject = React.useMemo(() => chooseDefaultProject(projects), [projects]);
  const selectedProject = selectedSession
    ? selectedProjectFromShell
    : (workspaceBinding ?? selectedProjectFromShell ?? defaultProject);
  const { t } = useTranslation('chat');
  /**
   * 项目团队配置的整体状态。
   *
   * 除了成员列表，还要留着 `revision` 与协作模式：改某个成员的专属模型要走
   * `PUT /api/project-team` 的乐观锁，缺少 revision 会被后端判成冲突。
   */
  const [teamState, setTeamState] = useState<{ root: string; config: ProjectTeamConfig | null }>({
    root: '',
    config: null,
  });
  const [agentBinding, setAgentBinding] = useState<{ scope: string; agentId: string | null | undefined; ready: boolean }>({ scope: "", agentId: undefined, ready: false });
  /**
   * The General workspace is a virtual conversation space rooted at PILOT_HOME,
   * not a project that owns a team configuration. The backend skips it when it
   * lists the registered project roots (`ui/server/services/projectTeamConfig.js`),
   * so the chat must not ask for a team config there either.
   */
  const isGeneralWorkspace = !selectedProject || isGeneralProject(selectedProject);
  const projectRoot = isGeneralWorkspace
    ? ''
    : selectedProject?.fullPath || selectedProject?.path || '';
  /**
   * The agent list belongs to the workspace it was loaded for. Deriving it from
   * the loaded root keeps the previous workspace's agents out of the selector
   * in the very render that switches workspaces, instead of only clearing them
   * in a later effect.
   */
  const teamAgents = teamState.root === projectRoot
    ? (teamState.config?.agents ?? EMPTY_TEAM_AGENTS).filter((agent) => agent.enabled)
    : EMPTY_TEAM_AGENTS;
  useEffect(() => {
    const controller = new AbortController();
    if (!projectRoot) {
      setTeamState({ root: '', config: null });
      return () => controller.abort();
    }
    void fetchProjectTeam(projectRoot, { signal: controller.signal }).then((config) => {
      if (!controller.signal.aborted) {
        setTeamState({ root: projectRoot, config });
      }
    }).catch(() => {
      if (!controller.signal.aborted) setTeamState({ root: projectRoot, config: null });
    });
    return () => controller.abort();
  }, [projectRoot]);
  const [participantsState, setParticipantsState] = useState<{sessionId: string; participants: Array<{agentId: string; name: string; role: string}>}>({sessionId: '', participants: []});
  const setViewReady = useContext(SessionViewReadyContext);
  const { subscribe: contextSubscribe } = useWebSocket();
  const { tasksEnabled: _tasksEnabled, isTaskMasterInstalled: _isTaskMasterInstalled } =
    useTasksSettings();
  const sessionIsReadOnly = isReadOnlySession(selectedSession);
  const sessionRequestParams = React.useMemo(
    () => getSessionRequestParams(selectedSession),
    [selectedSession],
  );

  const sessionStore = useSessionStore();
  const review = useChatReview();
  const streamBufferRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  const [isAbortPending, setIsAbortPending] = useState(false);
  const [runMode, setRunMode] = useState<ChatRunMode>('agent');
  /**
   * 自动推进开关：每轮结束后由指挥（没有指挥时由当前 Agent）检查最初目标，
   * 未达成继续推进。跟着浏览器走，发消息时随 options.autoDrive 传给后端。
   */
  const [autoDrive, setAutoDriveState] = useState<boolean>(
    () => safeLocalStorage.getItem(AUTO_DRIVE_STORAGE_KEY) === '1',
  );
  const setAutoDrive = useCallback((next: boolean) => {
    setAutoDriveState(next);
    safeLocalStorage.setItem(AUTO_DRIVE_STORAGE_KEY, next ? '1' : '0');
  }, []);
  const [isForkPending, setIsForkPending] = useState(false);
  const regenerateRequestsRef = useRef(new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>());
  const { addToast } = useToast();

  /**
   * 改某个项目成员的专属模型。
   *
   * 走 `PUT /api/project-team`，带上当前 revision 做乐观锁；成功后用后端返回的
   * 配置覆盖本地状态（revision 会随之改变）。返回 409 说明配置在别处被改过，
   * 这里重新拉一次最新配置，不静默覆盖别人的修改。
   */
  const handleAgentModelChange = useCallback(
    async (agentId: string, model: ProjectAgentModel | null) => {
      const config = teamState.root === projectRoot ? teamState.config : null;
      if (!config || !projectRoot) return;
      const agentName = config.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
      const nextAgents = withAgentModel(config.agents, agentId, model);
      try {
        const saved = await saveProjectTeam({
          projectRoot,
          revision: config.revision,
          agents: nextAgents,
          collaboration: config.collaboration,
        });
        setTeamState({ root: projectRoot, config: saved });
        addToast(
          'success',
          model
            ? t('input.models.agentModelSaved', {
                defaultValue: '已为 {{name}} 设置专属模型',
                name: agentName,
              })
            : t('input.models.agentModelCleared', {
                defaultValue: '{{name}} 已恢复跟随会话模型',
                name: agentName,
              }),
        );
      } catch (error) {
        if (error instanceof ProjectTeamConflictError) {
          addToast(
            'error',
            t('input.models.agentModelConflict', {
              defaultValue: '项目团队配置已被其它改动更新，请重试',
            }),
          );
          void fetchProjectTeam(projectRoot)
            .then((fresh) => {
              setTeamState({ root: projectRoot, config: fresh });
            })
            .catch(() => undefined);
          return;
        }
        addToast(
          'error',
          t('input.models.agentModelSaveFailed', {
            defaultValue: '保存 {{name}} 的专属模型失败',
            name: agentName,
          }),
        );
      }
    },
    [teamState, projectRoot, addToast, t],
  );

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = '';
    accumulatedStreamRef.current = '';
  }, []);

  const {
    model,
    modelCatalog,
    modelSelection,
    setModelSelection,
    isModelCatalogLoading,
    isModelSelectionReady,
    modelCatalogError,
    thinkingModelContext,
    permissionMode,
    isPermissionModeReady,
    permissionModeError,
    reloadPermissionMode,
    setPermissionMode: setPermissionModeRaw,
    pendingPermissionRequests,
    setPendingPermissionRequests,
  } = useChatProviderState({ selectedProject, selectedSession });

  const thinkingModeAvailability = React.useMemo(
    () => getThinkingModeAvailability(thinkingModelContext),
    [thinkingModelContext],
  );

  const cycleRunMode = useCallback(() => {
    setRunMode((currentMode) => {
      if (currentMode === 'agent') return 'plan';
      if (currentMode === 'plan') return 'ask';
      return 'agent';
    });
  }, []);

  const selectPermissionMode = useCallback((mode: PermissionMode) => {
    void setPermissionModeRaw(mode).catch(() => {});
  }, [setPermissionModeRaw]);

  const effectivePermissionMode =
    runMode === 'plan' ? 'plan' : permissionMode;

  const {
    chatMessages,
    activityMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    sessionRuntimeState,
    setSessionRuntimeState,
    activeRunId,
    setActiveRunId,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadError,
    retrySessionMessages,
    refreshSessionMessages,
    isLoadingMoreMessages,
    historyLoadError,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting: _isAborting,
    setIsAborting,
    canReturnToLatest,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    claudeStatus,
    pilotDeckStatus,
    setClaudeStatus,
    setPilotDeckStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scheduleScrollToBottom,
    pauseScrollFollowing,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    externalMessageUpdateTarget,
    processingSessions,
    resetStreamingState,
    pendingViewSessionRef,
    sessionStore,
  });

  const bindingSessionId = selectedSession?.id || currentSessionId || '';
  const bindingScope = JSON.stringify([projectRoot, !bindingSessionId || bindingSessionId.startsWith('new-session-') ? 'draft' : bindingSessionId]);
  const [bindingReload, setBindingReload] = useState(0);
  const [bindingError, setBindingError] = useState<{ scope: string; operation: 'load' | 'save'; message: string } | null>(null);
  const bindingRequestRef = useRef(0);
  const bindingSavesRef = useRef(new Map<string, Promise<unknown>>());
  const bindingReady = !projectRoot || (agentBinding.scope === bindingScope && agentBinding.ready);
  const activeAgentId = agentBinding.scope === bindingScope ? agentBinding.agentId : undefined;
  useEffect(() => {
    let cancelled = false;
    const request = ++bindingRequestRef.current;
    setBindingError(null);
    if (!projectRoot || !bindingSessionId || bindingSessionId.startsWith('new-session-')) {
      setAgentBinding(current => current.scope === bindingScope ? current : { scope: bindingScope, agentId: undefined, ready: true });
      return;
    }
    setAgentBinding(current => ({ ...current, ready: false }));
    // Wait for this scope's PUT to settle, then read authoritative state even
    // when it failed. A rejected save must not poison every future revisit.
    void (bindingSavesRef.current.get(bindingScope) ?? Promise.resolve()).catch(() => undefined)
      .then(() => sessionAgentBinding(projectRoot, bindingSessionId)).then((agentId) => {
      if (!cancelled && request === bindingRequestRef.current) setAgentBinding({ scope: bindingScope, agentId, ready: true });
    }).catch((error) => {
      if (!cancelled && request === bindingRequestRef.current) {
        setAgentBinding({ scope: bindingScope, agentId: undefined, ready: false });
        setBindingError({ scope: bindingScope, operation: 'load', message: error.message });
        addToast('error', error.message);
      }
    });
    return () => { cancelled = true; };
  }, [projectRoot, bindingSessionId, bindingScope, bindingReload]);
  const selectSessionAgent = useCallback((agentId: string | null) => {
    const request = ++bindingRequestRef.current;
    setBindingError(null);
    setAgentBinding({ scope: bindingScope, agentId, ready: false });
    if (!bindingSessionId || bindingSessionId.startsWith('new-session-')) {
      setAgentBinding({ scope: bindingScope, agentId, ready: true });
      return;
    }
    const save = (bindingSavesRef.current.get(bindingScope) ?? Promise.resolve()).catch(() => undefined).then(() => sessionAgentBinding(projectRoot, bindingSessionId, agentId));
    bindingSavesRef.current.set(bindingScope, save);
    void save.then(() => {
      if (request === bindingRequestRef.current) setAgentBinding(current => current.scope === bindingScope && current.agentId === agentId ? { ...current, ready: true } : current);
    }).catch(error => {
      if (request === bindingRequestRef.current) {
        setBindingError({ scope: bindingScope, operation: 'save', message: error.message });
        addToast('error', error.message);
      }
    });
  }, [bindingScope, projectRoot, bindingSessionId, addToast]);

  const isDraftExecution = !bindingSessionId || bindingSessionId.startsWith('new-session-');
  const [execution, setExecution] = useState<{ scope: string; mode: ExecutionMode; status: 'ready' | 'saving' | 'error' }>({ scope: '', mode: 'autoSplit', status: 'ready' });
  const [executionReload, setExecutionReload] = useState(0);
  const executionMode = execution.scope === bindingScope ? execution.mode : 'autoSplit';
  const executionReady = !projectRoot || isDraftExecution || (execution.scope === bindingScope && execution.status === 'ready');

  useEffect(() => {
    if (!projectRoot || isDraftExecution || sessionIsReadOnly) return;
    let cancelled = false;
    void sessionExecutionMode(projectRoot, bindingSessionId)
      .then(mode => { if (!cancelled) setExecution({ scope: bindingScope, mode, status: 'ready' }); })
      .catch(() => { if (!cancelled) setExecution({ scope: bindingScope, mode: 'autoSplit', status: 'error' }); });
    return () => { cancelled = true; };
  }, [projectRoot, isDraftExecution, sessionIsReadOnly, bindingSessionId, bindingScope, executionReload]);

  const bindReview = review?.bind;
  useEffect(() => {
    bindReview?.(selectedProject && !isGeneralProject(selectedProject) ? selectedProject : null, selectedSession?.id ?? currentSessionId ?? null, isLoading, sessionIsReadOnly);
  }, [bindReview, selectedProject, selectedSession?.id, currentSessionId, isLoading, sessionIsReadOnly]);
  useEffect(() => {
    const restored = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (!id || id !== (selectedSession?.id ?? currentSessionId) || !selectedProject) return;
      resetStreamingState();
      sessionStore.clearRealtime(id);
      void refreshSessionMessages({ afterRestore: true });
    };
    window.addEventListener(REVIEW_RESTORED_EVENT, restored);
    return () => window.removeEventListener(REVIEW_RESTORED_EVENT, restored);
  }, [selectedSession?.id, currentSessionId, selectedProject, sessionStore.clearRealtime, refreshSessionMessages, resetStreamingState]);

  useEffect(() => {
    const ready = !isLoadingSessionMessages && !sessionLoadError && currentSessionId && currentSessionId === selectedSession?.id && chatMessages.length > 0;
    setViewReady(ready ? currentSessionId : null);
    return () => setViewReady(null);
  }, [currentSessionId, selectedSession?.id, isLoadingSessionMessages, sessionLoadError, chatMessages.length > 0, setViewReady]);

  const watchedSessionId = selectedSession?.id || currentSessionId || null;
  useSessionWatch({ sessionId: watchedSessionId, ws, sendMessage });
  /**
   * 显式请求审查员审查上一轮。
   *
   * `manual` 协作模式下「自动」审查是关闭的，但用户可以主动点名让审查员看一遍。
   * 前端只负责发出请求并带上有稳定 `agentId` 的审查员身份；真正挑人、跑一轮、
   * 给回复挂上发言人身份的都是后端（`pilotdeck-bridge.js` 的
   * `requestProjectReview`），前端不自己推导执行结果。
   */
  const [isReviewRequestPending, setIsReviewRequestPending] = useState(false);
  const reviewRequestTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (reviewRequestTimerRef.current) {
      window.clearTimeout(reviewRequestTimerRef.current);
      reviewRequestTimerRef.current = null;
    }
  }, []);
  const handleRequestProjectReview = useCallback(() => {
    const reviewer = teamAgents.find((agent) => agent.role === 'reviewer');
    const sessionId = selectedSession?.id || currentSessionId;
    if (!reviewer || !sessionId || isReviewRequestPending || !executionReady || executionMode === 'solo') return;
    setIsReviewRequestPending(true);
    if (reviewRequestTimerRef.current) window.clearTimeout(reviewRequestTimerRef.current);
    // 后端在会话忙碌时会直接拒绝第二次请求，这里只是避免连点把错误消息刷出来。
    reviewRequestTimerRef.current = window.setTimeout(() => {
      reviewRequestTimerRef.current = null;
      setIsReviewRequestPending(false);
    }, 15_000);
    sendMessage({
      type: 'project-review-request',
      options: {
        sessionId,
        sessionKey: sessionId,
        projectPath: projectRoot,
        agentId: reviewer.id,
      },
    });
  }, [teamAgents, selectedSession?.id, currentSessionId, projectRoot, sendMessage, isReviewRequestPending, executionReady, executionMode]);
  const inputQueue = useSessionInputQueue({
    sessionId: watchedSessionId,
    projectPath: selectedProject?.fullPath || selectedProject?.path,
    ws,
    sendMessage,
    subscribe: subscribe || contextSubscribe,
  });
  const sendingInputs = React.useMemo(() => inputQueue.queueState.sessionId === watchedSessionId
    ? inputQueue.queueState.items.filter(isSendingInput)
    : [], [inputQueue.queueState, watchedSessionId]);
  const sendingInputIds = sendingInputs.map((item) => item.id).join(',');
  useEffect(() => {
    if (sendingInputIds) scheduleScrollToBottom();
  }, [sendingInputIds, scheduleScrollToBottom]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded: _isTextareaExpanded,
    thinkingMode,
    slashCommandsCount: _slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState: _resetCommandMenuState,
    dismissCommandMenu,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    fileMentionQuery,
    filteredFiles,
    selectedFileIndex,
    isLoadingFiles,
    fileListError,
    hasMoreFiles,
    loadMoreFiles,
    selectedFileMentions,
    removeFileMention,
    selectedSkills,
    selectSkill,
    removeSkill,
    selectedCommands,
    removeSelectedCommand,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    removeAttachedImage,
    retryAttachmentUpload,
    documentReferences,
    removeDocumentReference,
    uploadingImages,
    hasPendingAttachments,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    addAttachmentFiles,
    handleSubmit,
    canSubmitWithoutModel,
    handleInputChange,
    insertAtCursor,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleGrantSessionToolPermission,
    handleInputFocusChange,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    model,
    modelSelection,
    agentId: activeAgentId,
    draftExecutionMode: projectRoot && isDraftExecution ? executionMode : undefined,
    isModelSelectionReady: isModelSelectionReady && bindingReady && executionReady,
    isPermissionModeReady,
    runMode,
    autoDrive,
    permissionMode: effectivePermissionMode,
    basePermissionMode: permissionMode,
    cycleRunMode,
    isLoading,
    canAbortSession,
    inputQueuePaused: inputQueue.queueState.paused,
    enqueuePreparedInput: inputQueue.enqueue,
    tokenBudget,
    sendMessage,
    subscribe,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onSessionActivityBump,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    clearMessages,
    rewindMessages,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setPilotDeckStatus,
    setIsUserScrolledUp,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    referenceOnlyPrompt: t('documentReferences.defaultPrompt', {
      defaultValue: 'Please answer based on the document selection I quoted.',
    }) as string,
  });

  const handlePlanExecutionApproved = useCallback(() => {
    setRunMode('agent');
  }, []);

  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;

    // Reset streaming refs so stale accumulated text from the previous
    // connection doesn't merge with freshly-fetched server messages.
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
    streamBufferRef.current = '';

    if (shouldRefreshSessionOnReconnect({ isLoading, processingSessions, sessionId: selectedSession.id })) {
      await refreshSessionAfterReconnect(refreshSessionMessages);
    }

    // Ask the backend whether the session is still processing so the
    // loading indicator, Stop button, and active turn replay reflect reality
    // after reconnect. The session-status handler consumes activeTurnMessages
    // and dedupes replay chunks against existing realtime state.
    const statusMessage = buildReconnectStatusMessage(selectedSession.id, activeRunId);
    if (statusMessage) sendMessage(statusMessage);
  }, [
    activeRunId,
    isLoading,
    processingSessions,
    selectedProject,
    selectedSession,
    sessionRequestParams,
    refreshSessionMessages,
    streamTimerRef,
    accumulatedStreamRef,
    streamBufferRef,
    sendMessage,
  ]);

  useChatRealtimeHandlers({
    provider: 'pilotdeck',
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setSessionRuntimeState,
    activeRunId,
    setActiveRunId,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setPilotDeckStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      setIsAbortPending(false);
    }
  }, [canAbortSession, isLoading]);

  useEffect(() => {
    setIsAbortPending(false);
  }, [currentSessionId, selectedSession?.id]);

  const handleAbortWithPending = useCallback(() => {
    if (!isLoading || !canAbortSession || isAbortPending) return;
    handleAbortSession();
    setIsAbortPending(true);
  }, [canAbortSession, handleAbortSession, isAbortPending, isLoading]);

  /** "返回" on a sent user message: stop the running task (if any), put the
   *  original instruction back into the composer, and focus it for editing. */
  const handleReturnToComposer = useCallback((message: ChatMessage) => {
    if (isLoading && canAbortSession) handleAbortWithPending();
    const text = typeof message.content === 'string' ? message.content : String(message.content ?? '');
    if (!text) return;
    setInput(text);
    const sessionId = selectedSession?.id || currentSessionId;
    if (selectedProject && sessionId) {
      safeLocalStorage.setItem(getDraftInputStorageKey(selectedProject.name, sessionId), text);
    }
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      scheduleScrollToBottom?.();
    });
  }, [canAbortSession, currentSessionId, handleAbortWithPending, isLoading, scheduleScrollToBottom, selectedProject, selectedSession?.id, setInput, textareaRef]);

  const handleResumeInputQueue = useCallback(() => {
    void inputQueue.resume().then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.resumeFailed', { defaultValue: 'Failed to resume the queue.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleSteerQueuedInput = useCallback((itemId: string) => {
    void inputQueue.steer(itemId).then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.steerFailed', { defaultValue: 'The message remains queued.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleDeleteQueuedInput = useCallback((itemId: string) => {
    void inputQueue.remove(itemId).then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.deleteFailed', { defaultValue: 'Failed to delete the queued message.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleMoveQueuedInputToFront = useCallback((itemId: string) => {
    void inputQueue.moveToFront(itemId).then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.moveFailed', { defaultValue: 'Failed to reorder the queue.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleFork = useCallback(async (message: ChatMessage, _carriedPreview: number) => {
    if (isForkPending || isLoading || sessionIsReadOnly) return;
    const sessionId = selectedSession?.id || currentSessionId;
    const fromEntryId = message.entryId;
    if (!sessionId || !fromEntryId || !selectedProject) {
      addToast('error', t('fork.missingTarget', { defaultValue: 'Cannot fork this message.' }));
      return;
    }

    const projectPath = selectedProject.fullPath || selectedProject.path || '';
    setIsForkPending(true);
    try {
      const response = await api.forkSession(sessionId, { projectPath, fromEntryId });
      let result: { newSessionId?: string; prefillText?: string; runMode?: string; mode?: string; error?: string } = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }
      if (!response.ok) {
        throw new Error(result?.error || `Fork failed (${response.status})`);
      }
      const newSessionId = result?.newSessionId;
      if (!newSessionId) {
        throw new Error('Fork did not return a new session id');
      }
      setRunMode(result.runMode === 'ask' ? 'ask' : result.mode === 'plan' || result.runMode === 'plan' ? 'plan' : 'agent');

      if (typeof window.refreshProjects === 'function') {
        // A completed fork is usable immediately; a slow full sidebar scan
        // must not block navigation or leave every fork button disabled.
        void Promise.resolve().then(() => window.refreshProjects?.()).catch(() => {});
      }

      const forkDraft = typeof result.prefillText === 'string'
        ? result.prefillText
        : message.type === 'user'
          ? message.content || ''
          : '';
      const forkDraftStorageKey = getDraftInputStorageKey(selectedProject.name, newSessionId);
      if (forkDraft) {
        safeLocalStorage.setItem(forkDraftStorageKey, forkDraft);
      } else {
        safeLocalStorage.removeItem(forkDraftStorageKey);
      }

      onNavigateToSession?.(newSessionId);
      setInput(forkDraft);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        scheduleScrollToBottom?.();
      });
      // The scroll controller follows when the carried history finishes loading.
      addToast(
        'success',
        t('fork.ready', {
          defaultValue: 'Fork created — edit the prompt and send when ready.',
        }),
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      addToast('error', messageText || t('fork.failed', { defaultValue: 'Fork failed.' }));
    } finally {
      setIsForkPending(false);
    }
  }, [
    addToast,
    currentSessionId,
    isForkPending,
    isLoading,
    sessionIsReadOnly,
    onNavigateToSession,
    scheduleScrollToBottom,
    selectedProject,
    selectedSession?.id,
    setInput,
    t,
    textareaRef,
  ]);

  useEffect(() => {
    if (!subscribe) return undefined;
    const unsubscribe = subscribe((message: any) => {
      if (message?.type !== 'regenerate-last-message-result') return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const pending = regenerateRequestsRef.current.get(requestId);
      if (!pending) return;
      regenerateRequestsRef.current.delete(requestId);
      window.clearTimeout(pending.timeoutId);
      if (message.success) pending.resolve();
      else pending.reject(new Error(message.error || t('edit.failed', { defaultValue: 'Could not edit this message.' })));
    });
    return () => unsubscribe();
  }, [subscribe, t]);

  useEffect(() => () => {
    for (const pending of regenerateRequestsRef.current.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error(t('edit.cancelled', { defaultValue: 'Message edit was cancelled.' })));
    }
    regenerateRequestsRef.current.clear();
  }, [t]);

  const handleRegenerate = useCallback(async (message: ChatMessage, editedText: string) => {
    const sessionId = selectedSession?.id || currentSessionId;
    const expectedTurnId = String(message.turnId || message.runId || '').trim();
    if (!sessionId || !expectedTurnId || !selectedProject || sessionIsReadOnly) {
      throw new Error(t('edit.missingTarget', { defaultValue: 'The last message can no longer be edited.' }));
    }

    if (!bindingReady) throw new Error("会话角色尚未加载或保存完成。");
    if (!executionReady) throw new Error(t("executionMode.unavailable", { defaultValue: "Execution mode has not loaded or saved yet." }));
    if (!isPermissionModeReady) throw new Error(permissionModeError || "Permission preference is still loading.");
    if (!isModelSelectionReady || !modelSelection) throw new Error(modelCatalogError || "Model selection is still loading.");
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const references = attachments
      .map((attachment) => normalizeContentReference(attachment.contentReference ?? attachment))
      .filter((reference): reference is ContentReference => Boolean(reference));
    const browserUploads = attachments.filter((attachment) => (
      typeof attachment.uploadId === 'string' && typeof attachment.attachmentId === 'string'
    ));
    const uploadedAttachments = [...browserUploads.reduce((groups, attachment) => {
      const uploadId = attachment.uploadId as string;
      const attachmentIds = groups.get(uploadId) ?? [];
      attachmentIds.push(attachment.attachmentId as string);
      groups.set(uploadId, attachmentIds);
      return groups;
    }, new Map<string, string[]>())].map(([uploadId, attachmentIds]) => ({
      uploadId,
      attachmentIds,
    }));
    const modelAttachments = attachments.filter((attachment) => !(
      typeof attachment.uploadId === 'string' && typeof attachment.attachmentId === 'string'
    ));
    const regularFiles = modelAttachments
      .filter((attachment) => !attachment.kind || attachment.kind === 'file')
      .flatMap((attachment) => {
        const path = attachment.path || attachment.filePath;
        return path ? [{ name: attachment.name, path }] : [];
      });
    const command = `${editedText}${buildAttachmentPathNote(regularFiles)}${formatContentReferencePromptBlock(references)}`;
    const requestId = createUserTurnRunId();
    const runId = createUserTurnRunId();
    const result = new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        regenerateRequestsRef.current.delete(requestId);
        reject(new Error(t('edit.timeout', { defaultValue: 'Editing timed out. Please try again.' })));
      }, 120_000);
      regenerateRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });

    const effectiveThinkingMode = getEffectiveThinkingMode(thinkingMode, thinkingModeAvailability);
    regenerateLastSessionCommand({
      sendMessage,
      selectedProject,
      requestId,
      sessionId,
      expectedTurnId,
      command,
      runId,
      userVisibleInput: editedText,
      modelSelection: { ...modelSelection },
      agentId: activeAgentId,
      toolsSettings: getPilotDeckSettings(),
      runMode,
      autoDrive,
      permissionMode: effectivePermissionMode,
      basePermissionMode: permissionMode,
      model,
      thinking: thinkingModeToConfig(effectiveThinkingMode),
      sessionSummary: getNotificationSessionSummary(selectedSession, editedText),
      images: Array.isArray(message.images) ? message.images : [],
      attachments: modelAttachments,
      uploadedAttachments,
      displayAttachments: attachments,
      syntheticMessages: [{
        text: EDIT_RECONCILIATION_HINT,
        purpose: 'edited_turn_workspace_reconciliation',
      }],
    });

    return result;
  }, [
    currentSessionId,
    bindingReady,
    executionReady,
    isModelSelectionReady,
    isPermissionModeReady,
    permissionModeError,
    modelSelection,
    modelCatalogError,
    effectivePermissionMode,
    model,
    permissionMode,
    runMode,
    autoDrive,
    activeAgentId,
    selectedProject,
    selectedSession,
    sendMessage,
    sessionIsReadOnly,
    t,
    thinkingMode,
    thinkingModeAvailability,
  ]);

  useEffect(() => {
    if (!isLoading || !canAbortSession) return;
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
      if (
        event.target instanceof Element
        && event.target.closest('[data-file-search-input]')
      ) {
        return;
      }
      if (document.querySelector('[data-modal-overlay]')) return;
      event.preventDefault();
      handleAbortWithPending();
    };
    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortWithPending, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  // ChatGPT-style empty state. Triggered explicitly via `forceWelcome` and
  // implicitly when nothing has been started yet (no session, no
  // messages, not in the middle of loading). The composer floats in the
  // middle with a welcome headline above it; once the user sends, we drop
  // into the normal layout (composer at bottom, messages on top) on the
  // next render.
  const isWelcomeMode =
    !!forceWelcome ||
    (!selectedSession && !currentSessionId && !isLoadingSessionMessages && chatMessages.length === 0);

  // Fire onExitWelcome the moment the user submits from welcome mode. Wraps
  // handleSubmit so we don't have to thread state through useChatComposerState.
  const wrappedSubmit = useCallback(
    (...args: unknown[]) => {
      if (isWelcomeMode && onExitWelcome) onExitWelcome();
      return (handleSubmit as (...a: unknown[]) => unknown)(...args);
    },
    [handleSubmit, isWelcomeMode, onExitWelcome],
  );

  // The composer is identical in welcome / normal mode — just rendered in a
  // different parent container. Pulled out so we don't drift between the two.
  /**
   * The reviewer the explicit "request review" action would dispatch to.
   * `teamAgents` only contains enabled members, so a disabled reviewer never
   * shows up as a button. The backend resolves the same agent again from the
   * stable `agentId` we send; the front-end never decides who reviews.
   */
  const teamReviewer = teamAgents.find((agent) => agent.role === 'reviewer') ?? null;
  const composer = sessionIsReadOnly ? (
    <div className="mx-auto w-full max-w-[860px] px-6 pb-6 pt-3">
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-[13px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        {t('session.readonlyTranscript', {
          defaultValue: 'This transcript is read-only.',
        })}
      </div>
    </div>
  ) : (
    <Composer
      queueTray={(
        <QueuedMessagesTray
          state={inputQueue.queueState}
          isLoading={isLoading}
          onResume={handleResumeInputQueue}
          onSteer={handleSteerQueuedInput}
          onDelete={handleDeleteQueuedInput}
          onMoveToFront={handleMoveQueuedInputToFront}
        />
      )}
      input={input}
      placeholder={t('composer.placeholder', { defaultValue: 'Tell PilotV what you want to get done…' })}
      textareaRef={textareaRef}
      inputHighlightRef={inputHighlightRef}
      renderInputWithMentions={renderInputWithMentions}
      onInputChange={handleInputChange}
      onTextareaClick={handleTextareaClick}
      onTextareaKeyDown={handleKeyDown}
      onTextareaPaste={handlePaste}
      onTextareaScrollSync={syncInputOverlayScroll}
      onTextareaInput={handleTextareaInput}
      onInputFocusChange={handleInputFocusChange}
      onSubmit={wrappedSubmit as typeof handleSubmit}
      onAbortSession={handleAbortWithPending}
      openImagePicker={openImagePicker}
      onAddAttachmentFiles={addAttachmentFiles}
      attachedImages={attachedImages}
      onRemoveImage={removeAttachedImage}
      onRetryImage={retryAttachmentUpload}
      documentReferences={documentReferences}
      onRemoveDocumentReference={removeDocumentReference}
      onOpenDocumentReference={onFileOpen ? (filePath) => onFileOpen(filePath) : undefined}
      uploadingImages={uploadingImages}
      hasPendingAttachments={hasPendingAttachments}
      imageErrors={imageErrors}
      showFileDropdown={showFileDropdown}
      fileMentionQuery={fileMentionQuery}
      filteredFiles={filteredFiles}
      selectedFileIndex={selectedFileIndex}
      isLoadingFiles={isLoadingFiles}
      fileListError={fileListError}
      hasMoreFiles={hasMoreFiles}
      onLoadMoreFiles={loadMoreFiles}
      onSelectFile={selectFile}
      selectedFileMentions={selectedFileMentions}
      onRemoveFileMention={removeFileMention}
      selectedSkills={selectedSkills}
      onSelectSkill={selectSkill}
      onRemoveSkill={removeSkill}
      selectedCommands={selectedCommands}
      onRemoveCommand={removeSelectedCommand}
      filteredCommands={filteredCommands}
      commandQuery={commandQuery}
      selectedCommandIndex={selectedCommandIndex}
      onCommandSelect={handleCommandSelect}
      onCloseCommandMenu={dismissCommandMenu}
      isCommandMenuOpen={showCommandMenu}
      frequentCommands={commandQuery ? [] : frequentCommands}
      onToggleCommandMenu={handleToggleCommandMenu}
      onInsertSlash={() => insertAtCursor('/')}
      getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
      getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
      isDragActive={isDragActive}
      isLoading={isLoading}
      canAbortSession={canAbortSession}
      isAbortPending={isAbortPending}
      isInputQueuePaused={inputQueue.queueState.paused}
      onResumeInputQueue={handleResumeInputQueue}
      tokenBudget={tokenBudget}
      contextTarget={(selectedSession?.id || currentSessionId) && selectedProject ? {
        sessionId: selectedSession?.id || currentSessionId!,
        projectPath: selectedProject.fullPath || selectedProject.path || selectedProject.name,
        ...sessionRequestParams,
      } : undefined}
      modelCatalog={modelCatalog}
      modelSelection={modelSelection}
      isModelCatalogLoading={isModelCatalogLoading}
      isModelSelectionReady={isModelSelectionReady && bindingReady && executionReady}
      isPermissionModeReady={isPermissionModeReady}
      permissionModeError={permissionModeError}
      onRetryPermissionMode={reloadPermissionMode}
      canSubmitWithoutModel={canSubmitWithoutModel}
      modelCatalogError={modelCatalogError}
      projectKey={selectedProject?.fullPath || selectedProject?.path || ''}
      agents={teamAgents}
      selectedAgentId={activeAgentId}
      onAgentSelectionChange={selectSessionAgent}
      onAgentModelChange={handleAgentModelChange}
      reviewRequestTarget={executionReady && executionMode !== 'solo' && teamReviewer ? { reviewerId: teamReviewer.id, reviewerName: teamReviewer.name } : null}
      onRequestReview={handleRequestProjectReview}
      isReviewPending={isReviewRequestPending || isLoading}
      onModelSelectionChange={setModelSelection}
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={handleGrantToolPermission}
      permissionMode={permissionMode}
      onPermissionModeChange={selectPermissionMode}
      runMode={runMode}
      onRunModeChange={setRunMode}
      autoDrive={autoDrive}
      onAutoDriveChange={setAutoDrive}
      onPlanExecutionApproved={handlePlanExecutionApproved}
      sendByCtrlEnter={sendByCtrlEnter}
      chromeless={isWelcomeMode && !compact}
      compact={compact}
      showWorkspacePicker={isWelcomeMode && !compact}
      workspaceProjects={projects}
      workspaceSelectedProject={!selectedSession ? selectedProject : null}
      onSelectWorkspaceProject={(project) => {
        onSelectWorkspace?.(project);
      }}
      onSelectWorkspaceNone={() => {
        const generalProject = projects.find(isGeneralProject);
        if (generalProject) onSelectWorkspace?.(generalProject);
      }}
      onCreateWorkspaceProject={onCreateProject}
    />
  );
  const composerSlot = (
    <div data-chat-composer-slot className="min-h-0 shrink-0">
      {bindingError?.scope === bindingScope && (
        <div role="alert" className="flex items-center gap-2 px-3 py-2 text-sm text-red-600">
          <span>{bindingError.message}</span>
          <button type="button" className="underline" onClick={() => {
            if (bindingError.operation === 'save' && activeAgentId !== undefined) selectSessionAgent(activeAgentId);
            else setBindingReload(value => value + 1);
          }}>重试会话角色</button>
        </div>
      )}
      {projectRoot && !sessionIsReadOnly && (
        <div className="flex items-center gap-2 px-3 py-1 text-xs">
          {execution.scope === bindingScope && execution.status === 'error' && (
            <button type="button" className="underline" onClick={() => setExecutionReload(value => value + 1)}>
              {t('executionMode.retry', { defaultValue: 'Execution mode unavailable — retry' })}
            </button>
          )}
        </div>
      )}
      {composer}
    </div>
  );

  useEffect(() => contextSubscribe((message: any) => {
    if ((message?.type === 'project-participants' || message?.type === 'session-status') && message.sessionId === (selectedSession?.id || currentSessionId)) {
      const participants = message.type === 'project-participants' ? message.participants : message.projectParticipants;
      if (Array.isArray(participants)) setParticipantsState({sessionId: message.sessionId, participants});
    }
  }), [contextSubscribe, selectedSession?.id, currentSessionId]);

  const speakerScope = `${projectRoot}:${selectedSession?.id || currentSessionId || ''}`;
  const [speakerSelection, setSpeakerSelection] = useState<{ scope: string; key: string | null }>({ scope: '', key: null });
  const speakerFilterKey = speakerSelection.scope === speakerScope ? speakerSelection.key : null;
  const selectSpeaker = useCallback((key: string | null) => {
    setSpeakerSelection({ scope: speakerScope, key });
  }, [speakerScope]);
  const speakers = React.useMemo(() => collectSpeakers({
    agents: teamAgents,
    participants: participantsState.sessionId === (selectedSession?.id || currentSessionId) ? participantsState.participants : [],
    messages: chatMessages.filter((message) => message.type === 'assistant'),
  }), [teamAgents, participantsState, selectedSession?.id, currentSessionId, chatMessages]);
  // 正在生效的筛选：条带上的 chip 之外，正文里也挂一条提示，
  // 让「已经过滤了」这件事看得见（不然用户会以为筛选没生效）。
  const speakerFilterLabel = React.useMemo(() => {
    if (!speakerFilterKey) return null;
    const speaker = speakers.find((entry) => entry.identity.key === speakerFilterKey);
    if (!speaker) return null;
    return speakerDisplayLabel(
      speaker,
      (key) => String(t(key, { defaultValue: '' })),
      String(t('speaker.mainAgent', { defaultValue: '主agent' })),
    );
  }, [speakerFilterKey, speakers, t]);
  const teamStrip = <ProjectTeamStrip speakers={speakers} activeSpeakerKey={speakerFilterKey} onSelectSpeaker={selectSpeaker} />;

  if (isWelcomeMode) {
    const projectName = selectedProject && !isGeneralProject(selectedProject)
      ? projectDisplayName(selectedProject)
      : '';
    if (compact) {
      return (
        <div className="pd-chat-canvas flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950">
          {teamStrip}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 text-center">
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
              <MessageSquare className="h-4 w-4" strokeWidth={1.8} />
            </div>
            <p className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
              {t('workspace.emptyTitle', { defaultValue: 'Ask PilotV about this project' })}
            </p>
            <p className="mt-1 max-w-56 text-[12px] leading-5 text-neutral-400 dark:text-neutral-500">
              {t('workspace.emptyDescription', {
                defaultValue: 'Reference a workspace file with @ when you want it included.',
              })}
            </p>
          </div>
          {composerSlot}
        </div>
      );
    }
    return (
      <div className="pd-chat-canvas flex h-full flex-col bg-white dark:bg-neutral-950">
        {teamStrip}
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-[860px]">
            <h1 className="mb-8 text-center text-[26px] font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
              {projectName
                ? t('welcome.greetingWithProject', {
                  project: projectName,
                  defaultValue: `What do you want us to build in ${projectName}?`,
                })
                : t('welcome.noProject', {
                  defaultValue: `What's on the plan today?`,
                })}
            </h1>
            {composerSlot}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pd-chat-canvas grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-white dark:bg-neutral-950">
      {teamStrip}
      <ErrorBoundary showDetails resetKeys={[selectedSession?.id, selectedProject?.name]}>
        <MessagesPane
          scrollContainerRef={scrollContainerRef}
          showReturnToLatest={canReturnToLatest}
          onResumeScroll={scrollToBottom}
          onPauseScroll={pauseScrollFollowing}
          isLoadingSessionMessages={isLoadingSessionMessages}
          sessionLoadError={sessionLoadError}
          onRetrySessionLoad={retrySessionMessages}
          speakerFilterKey={speakerFilterKey}
          speakerFilterLabel={speakerFilterLabel}
          onSelectSpeaker={selectSpeaker}
          chatMessages={chatMessages}
          sendingInputs={sendingInputs}
          activityMessages={activityMessages}
          visibleMessages={visibleMessages}
          visibleMessageCount={visibleMessageCount}
          isLoadingMoreMessages={isLoadingMoreMessages}
          historyLoadError={historyLoadError}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          provider={'pilotdeck' as Provider}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantSessionToolPermission={handleGrantSessionToolPermission}
          autoExpandTools={autoExpandTools}
          showThinking={showThinking}
          inlineThinking={inlineThinking}
          setInput={setInput}
          isAssistantWorking={isLoading}
          pendingPermissionRequests={pendingPermissionRequests}
          sessionRuntimeState={sessionRuntimeState}
          activeRunId={activeRunId}
          workingStatus={claudeStatus || pilotDeckStatus}
          runMode={runMode}
          planModeActive={effectivePermissionMode === 'plan'}
          sessionStore={sessionStore}
          onFork={sessionIsReadOnly ? undefined : handleFork}
          onRegenerate={sessionIsReadOnly ? undefined : handleRegenerate}
          onReturnToComposer={sessionIsReadOnly ? undefined : handleReturnToComposer}
          forkDisabled={isForkPending}
        />
      </ErrorBoundary>
      {composerSlot}
    </div>
  );
}

export default React.memo(ChatInterface);
