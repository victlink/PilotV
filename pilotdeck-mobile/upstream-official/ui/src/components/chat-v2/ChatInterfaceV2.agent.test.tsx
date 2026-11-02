// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatInterfaceV2 from './ChatInterfaceV2';

const chatMocks = vi.hoisted(() => ({
  useSessionInputQueue: vi.fn(),
  useChatSessionState: vi.fn(),
  fetchProjectTeam: vi.fn(),
  /**
   * Every `agentId` that `ChatInterfaceV2` handed to `useChatComposerState`.
   * The composer state copies it into a ref that the submit path reads, so
   * every entry here is a value that could reach the real turn payload.
   */
  composerAgentIds: [] as Array<string | undefined>,
  /** The `onRegenerate` handler of every rendered message pane. */
  regenerateHandlers: [] as Array<
    ((message: unknown, editedText: string) => Promise<void>) | undefined
  >,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

vi.mock('../../contexts/TasksSettingsContext', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: vi.fn(() => vi.fn()) }),
}));

vi.mock('../../stores/useSessionStore', () => ({
  useSessionStore: () => ({ refreshFromServer: vi.fn() }),
}));

vi.mock('../../hooks/useSessionWatch', () => ({ useSessionWatch: vi.fn() }));
vi.mock('../chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: vi.fn() }));

vi.mock('../chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    model: 'openai/gpt-test',
    modelCatalog: [],
    modelSelection: { mode: 'auto', provider: 'pilotdeck', model: 'openai/gpt-test' },
    setModelSelection: vi.fn(async () => undefined),
    isModelCatalogLoading: false,
    isModelSelectionReady: true,
    isPermissionModeReady: true,
    permissionModeError: null,
    reloadPermissionMode: vi.fn(),
    modelCatalogError: null,
    thinkingModelContext: null,
    permissionMode: 'default',
    setPermissionMode: vi.fn(),
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
  }),
}));

vi.mock('../chat/hooks/useChatSessionState', () => ({
  useChatSessionState: chatMocks.useChatSessionState,
}));

vi.mock('../chat/hooks/useSessionInputQueue', () => ({
  useSessionInputQueue: chatMocks.useSessionInputQueue,
}));

vi.mock('../chat/hooks/useChatComposerState', () => ({
  useChatComposerState: (args: { agentId?: string }) => {
    chatMocks.composerAgentIds.push(args.agentId);
    return {
      input: '', setInput: vi.fn(), textareaRef: { current: null }, inputHighlightRef: { current: null },
      isTextareaExpanded: false, thinkingMode: 'default', slashCommandsCount: 0, filteredCommands: [],
      frequentCommands: [], commandQuery: '', showCommandMenu: false, selectedCommandIndex: 0,
      resetCommandMenuState: vi.fn(), dismissCommandMenu: vi.fn(), handleCommandSelect: vi.fn(),
      handleToggleCommandMenu: vi.fn(), showFileDropdown: false, fileMentionQuery: '', filteredFiles: [],
      selectedFileIndex: 0, isLoadingFiles: false, fileListError: null, hasMoreFiles: false,
      loadMoreFiles: vi.fn(), selectedFileMentions: [], removeFileMention: vi.fn(), selectedSkills: [],
      selectSkill: vi.fn(), removeSkill: vi.fn(), selectedCommands: [], removeSelectedCommand: vi.fn(),
      renderInputWithMentions: () => null, selectFile: vi.fn(), attachedImages: [], removeAttachedImage: vi.fn(),
      retryAttachmentUpload: vi.fn(), documentReferences: [], removeDocumentReference: vi.fn(),
      uploadingImages: new Map(), imageErrors: new Map(), getRootProps: () => ({}), getInputProps: () => ({}),
      isDragActive: false, openImagePicker: vi.fn(), addAttachmentFiles: vi.fn(), handleSubmit: vi.fn(),
      handleInputChange: vi.fn(), insertAtCursor: vi.fn(), handleKeyDown: vi.fn(), handlePaste: vi.fn(),
      handleTextareaClick: vi.fn(), handleTextareaInput: vi.fn(), syncInputOverlayScroll: vi.fn(),
      handleAbortSession: vi.fn(), handlePermissionDecision: vi.fn(), handleGrantToolPermission: vi.fn(),
      handleGrantSessionToolPermission: vi.fn(), handleInputFocusChange: vi.fn(),
    };
  },
}));

vi.mock('../../lib/projectTeamApi', () => ({
  fetchProjectTeam: chatMocks.fetchProjectTeam,
}));

vi.mock('./MessagesPaneV2', () => ({
  default: ({
    onRegenerate,
  }: {
    onRegenerate?: (message: unknown, editedText: string) => Promise<void>;
  }) => {
    chatMocks.regenerateHandlers.push(onRegenerate);
    return (
      <button
        type="button"
        data-testid="regenerate"
        onClick={() => {
          const pending = onRegenerate?.(
            { id: 'message-1', role: 'user', content: 'original request', turnId: 'turn-1' },
            'edited request',
          );
          if (pending) void pending.catch(() => undefined);
        }}
      >
        regenerate
      </button>
    );
  },
}));

vi.mock('./ComposerV2', () => ({
  default: ({
    onAgentSelectionChange,
    selectedAgentId,
    agents,
  }: {
    onAgentSelectionChange?: (agentId: string | null) => void;
    selectedAgentId?: string | null;
    agents?: Array<{ id: string }>;
  }) => (
    <div data-testid="composer">
      <span data-testid="selected-agent">{selectedAgentId ?? 'none'}</span>
      <span data-testid="agent-ids">{(agents ?? []).map((agent) => agent.id).join(',')}</span>
      <button
        type="button"
        data-testid="select-agent-b"
        onClick={() => onAgentSelectionChange?.('agent-b')}
      >
        select agent b
      </button>
    </div>
  ),
}));

const createChatSessionState = (overrides: Record<string, unknown> = {}) => ({
  chatMessages: [], activityMessages: [], addMessage: vi.fn(), clearMessages: vi.fn(),
  rewindMessages: vi.fn(), isLoading: false, setIsLoading: vi.fn(), sessionRuntimeState: null,
  setSessionRuntimeState: vi.fn(), activeRunId: 'run-active', setActiveRunId: vi.fn(),
  currentSessionId: 'web:s_agent', setCurrentSessionId: vi.fn(), isLoadingSessionMessages: false,
  sessionLoadError: null, isLoadingMoreMessages: false, hasMoreFiles: false, totalMessages: 0,
  canAbortSession: false, setCanAbortSession: vi.fn(), isAborting: false, setIsAborting: vi.fn(),
  setIsUserScrolledUp: vi.fn(), tokenBudget: null, setTokenBudget: vi.fn(), visibleMessageCount: 0,
  visibleMessages: [], loadEarlierMessages: vi.fn(), loadAllMessages: vi.fn(), allMessagesLoaded: true,
  isLoadingAllMessages: false, claudeStatus: null, pilotDeckStatus: null, setClaudeStatus: vi.fn(),
  setPilotDeckStatus: vi.fn(), createDiff: vi.fn(), scrollContainerRef: { current: null },
  scrollToBottom: vi.fn(), handleScroll: vi.fn(),
  ...overrides,
});

const emptyQueue = () => ({
  queueState: { sessionId: null, revision: 0, paused: false, items: [] },
  enqueue: vi.fn(), remove: vi.fn(), moveToFront: vi.fn(), steer: vi.fn(), resume: vi.fn(),
});

const DEMO_PROJECT = { name: 'demo', path: '/workspace/demo', fullPath: '/workspace/demo' };
const OTHER_PROJECT = { name: 'other', path: '/workspace/other', fullPath: '/workspace/other' };
/**
 * The General workspace is a virtual conversation space rooted at PILOT_HOME.
 * The backend skips it when listing project team configs
 * (`ui/server/services/projectTeamConfig.js`), so the chat must not ask.
 */
const GENERAL_PROJECT = {
  name: 'general',
  displayName: 'general',
  kind: 'general' as const,
  path: '/home/tester/.pilotdeck',
  fullPath: '/home/tester/.pilotdeck',
};

function chatProps(project: Record<string, unknown>, sendMessage: ReturnType<typeof vi.fn>) {
  return {
    selectedProject: project,
    selectedSession: { id: 'web:s_agent' },
    ws: { readyState: WebSocket.OPEN },
    sendMessage,
    subscribe: vi.fn(() => vi.fn()),
    processingSessions: new Set<string>(),
  };
}

function renderChat(
  sendMessage: ReturnType<typeof vi.fn>,
  project: Record<string, unknown> = DEMO_PROJECT,
) {
  chatMocks.useChatSessionState.mockReturnValue(createChatSessionState());
  chatMocks.useSessionInputQueue.mockReturnValue(emptyQueue());
  chatMocks.fetchProjectTeam.mockImplementation(async (projectRoot: string) => ({
    version: 1,
    revision: '0',
    collaboration: { mode: 'manual' },
    agents: projectRoot === OTHER_PROJECT.fullPath
      ? [{ id: 'agent-c', name: 'Agent C', role: 'commander', enabled: true }]
      : [
        { id: 'agent-a', name: 'Agent A', role: 'executor', enabled: true },
        { id: 'agent-b', name: 'Agent B', role: 'reviewer', enabled: true },
      ],
  }));

  return render(<ChatInterfaceV2 {...(chatProps(project, sendMessage) as any)} />);
}

beforeEach(() => {
  chatMocks.composerAgentIds.length = 0;
  chatMocks.regenerateHandlers.length = 0;
  chatMocks.fetchProjectTeam.mockReset();
});

afterEach(cleanup);

describe('ChatInterfaceV2 project agents', () => {
  it('carries the selected project agent into the turn payload', async () => {
    const sendMessage = vi.fn();
    renderChat(sendMessage);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-b'));

    fireEvent.click(screen.getByTestId('regenerate'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [frame] = sendMessage.mock.calls[0] as [{ type: string; options: Record<string, unknown> }];
    expect(frame.type).toBe('regenerate-last-message');
    expect(frame.options.agentId).toBe('agent-b');
  });

  it('omits the project agent on the edit/resubmit path when no agent is selected', async () => {
    const sendMessage = vi.fn();
    renderChat(sendMessage);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('regenerate'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [frame] = sendMessage.mock.calls[0] as [{ type: string; options: Record<string, unknown> }];
    expect(frame.type).toBe('regenerate-last-message');
    expect(frame.options).not.toHaveProperty('agentId');
  });

  it('does not query the project team for the general workspace', async () => {
    renderChat(vi.fn(), GENERAL_PROJECT);

    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    expect(chatMocks.fetchProjectTeam).not.toHaveBeenCalled();
  });

  it('offers no project agents in the general workspace', async () => {
    renderChat(vi.fn(), GENERAL_PROJECT);

    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    expect(screen.getByTestId('agent-ids').textContent).toBe('');
    expect(screen.getByTestId('selected-agent').textContent).toBe('none');
  });

  it('drops the previous workspace agent before the new workspace is used', async () => {
    const sendMessage = vi.fn();
    const view = renderChat(sendMessage, DEMO_PROJECT);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-b'));

    const rendersBeforeSwitch = chatMocks.composerAgentIds.length;
    view.rerender(<ChatInterfaceV2 {...(chatProps(OTHER_PROJECT, sendMessage) as any)} />);

    // Every render after the switch must not carry the previous workspace's
    // agent: the composer state copies this value into the ref that the
    // submit path reads, so a stale entry here is a stale payload.
    const agentIdsAfterSwitch = chatMocks.composerAgentIds.slice(rendersBeforeSwitch);
    expect(agentIdsAfterSwitch.length).toBeGreaterThan(0);
    expect(agentIdsAfterSwitch.every((agentId) => agentId === undefined)).toBe(true);
    expect(screen.getByTestId('selected-agent').textContent).toBe('none');
  });

  it('does not send the previous workspace agent after the workspace changed', async () => {
    const sendMessage = vi.fn();
    const view = renderChat(sendMessage, DEMO_PROJECT);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-b'));

    view.rerender(<ChatInterfaceV2 {...(chatProps(OTHER_PROJECT, sendMessage) as any)} />);
    fireEvent.click(screen.getByTestId('regenerate'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [frame] = sendMessage.mock.calls[0] as [{ type: string; options: Record<string, unknown> }];
    expect(frame.options).not.toHaveProperty('agentId');
  });

  it('does not send the previous workspace agent from the render that switches workspaces', async () => {
    const sendMessage = vi.fn();
    const view = renderChat(sendMessage, DEMO_PROJECT);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-b'));

    const handlersBeforeSwitch = chatMocks.regenerateHandlers.length;
    view.rerender(<ChatInterfaceV2 {...(chatProps(OTHER_PROJECT, sendMessage) as any)} />);

    /**
     * The first render after the switch still holds the previous selection in
     * the component state. The handler of that render must already refuse to
     * send it, because a user can act before the effects that clear the state
     * have run.
     */
    const staleRenderHandler = chatMocks.regenerateHandlers[handlersBeforeSwitch];
    expect(staleRenderHandler).toBeTypeOf('function');
    // The edit acknowledgement never arrives in this test, so the pending
    // promise is dropped on purpose.
    void staleRenderHandler?.(
      { id: 'message-1', role: 'user', content: 'original request', turnId: 'turn-1' },
      'edited request',
    )?.catch(() => undefined);

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [frame] = sendMessage.mock.calls[0] as [{ type: string; options: Record<string, unknown> }];
    expect(frame.options).not.toHaveProperty('agentId');
  });
});
