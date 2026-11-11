// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatInterfaceV2 from './ChatInterface';

const chatMocks = vi.hoisted(() => ({
  realComposer: false,
  useSessionInputQueue: vi.fn(),
  useChatSessionState: vi.fn(),
  fetchProjectTeam: vi.fn(),
  sessionExecutionMode: vi.fn(async (_root: string, _session: string, mode?: 'solo' | 'autoSplit') => mode ?? 'autoSplit'),
  sessionAgentBinding: vi.fn(async (_root: string, _session: string, agentId?: string | null): Promise<string | null | undefined> => agentId),
  /**
   * Every `agentId` that `ChatInterfaceV2` handed to `useChatComposerState`.
   * The composer state copies it into a ref that the submit path reads, so
   * every entry here is a value that could reach the real turn payload.
   */
  composerAgentIds: [] as Array<string | null | undefined>,
  /** The `onRegenerate` handler of every rendered message pane. */
  regenerateHandlers: [] as Array<
    ((message: unknown, editedText: string) => Promise<void>) | undefined
  >,
  /**
   * The speaker-filter props of every rendered message pane.
   * `speakerFilterKey` is the filter the pane renders with, `onSelectSpeaker`
   * is the callback the pane raises when the reader clicks a speaker name in
   * the message body.
   */
  messagesPaneProps: [] as Array<{
    speakerFilterKey?: string | null;
    onSelectSpeaker?: (speakerKey: string | null) => void;
  }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

vi.mock('../../../contexts/TasksSettingsContext', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));

vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: vi.fn(() => vi.fn()) }),
}));

vi.mock('../../../stores/useSessionStore', () => ({
  useSessionStore: () => ({ refreshFromServer: vi.fn() }),
}));

vi.mock('../../../hooks/useSessionWatch', () => ({ useSessionWatch: vi.fn() }));
vi.mock('../hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: vi.fn() }));

vi.mock('../hooks/useChatProviderState', () => ({
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

vi.mock('../hooks/useChatSessionState', () => ({
  useChatSessionState: chatMocks.useChatSessionState,
}));

vi.mock('../hooks/useSessionInputQueue', () => ({
  useSessionInputQueue: chatMocks.useSessionInputQueue,
}));

vi.mock('../../../utils/api', () => ({
  api: {},
  authenticatedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ pinned: [], custom: [], builtIn: [] }) })),
}));

vi.mock('../hooks/useChatComposerState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useChatComposerState')>();
  return {
  useChatComposerState: (args: any) => {
    if (chatMocks.realComposer) return actual.useChatComposerState(args);
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
};
});

vi.mock('../../../lib/projectTeamApi', () => ({
  fetchProjectTeam: chatMocks.fetchProjectTeam,
  sessionAgentBinding: chatMocks.sessionAgentBinding,
  sessionExecutionMode: chatMocks.sessionExecutionMode,
}));

vi.mock('./MessagesPane', () => ({
  default: ({
    onRegenerate,
    speakerFilterKey,
    onSelectSpeaker,
  }: {
    onRegenerate?: (message: unknown, editedText: string) => Promise<void>;
    speakerFilterKey?: string | null;
    onSelectSpeaker?: (speakerKey: string | null) => void;
  }) => {
    chatMocks.regenerateHandlers.push(onRegenerate);
    chatMocks.messagesPaneProps.push({ speakerFilterKey, onSelectSpeaker });
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

vi.mock('./Composer', () => ({
  default: ({
    input,
    onInputChange,
    onSubmit,
    onAgentSelectionChange,
    selectedAgentId,
    agents,
    reviewRequestTarget,
    onRequestReview,
  }: {
    input?: string;
    onInputChange?: (event: any) => void;
    onSubmit?: (event: any) => void;
    onAgentSelectionChange?: (agentId: string | null) => void;
    selectedAgentId?: string | null;
    agents?: Array<{ id: string }>;
    reviewRequestTarget?: { reviewerId: string; reviewerName: string } | null;
    onRequestReview?: () => void;
  }) => (
    <div data-testid="composer">
      <input data-testid="message-input" value={input ?? ""} onChange={event => onInputChange?.(event)} />
      <button data-testid="send-input" onClick={() => onSubmit?.({ preventDefault() {} })}>send</button>
      <span data-testid="selected-agent">{selectedAgentId ?? 'none'}</span>
      <span data-testid="agent-ids">{(agents ?? []).map((agent) => agent.id).join(',')}</span>
      <span data-testid="review-target">{reviewRequestTarget?.reviewerId ?? 'none'}</span>
      <button
        type="button"
        data-testid="select-agent-b"
        onClick={() => onAgentSelectionChange?.('agent-b')}
      >
        select agent b
      </button>
      <button data-testid="clear-agent" onClick={() => onAgentSelectionChange?.(null)}>clear</button>
      {reviewRequestTarget ? (
        <button type="button" data-testid="request-review" onClick={() => onRequestReview?.()}>
          request review
        </button>
      ) : null}
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

function chatProps(
  project: Record<string, unknown>,
  sendMessage: ReturnType<typeof vi.fn>,
  sessionId = 'web:s_agent',
) {
  return {
    selectedProject: project,
    selectedSession: { id: sessionId },
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
  chatMocks.realComposer = false;
  chatMocks.sessionAgentBinding.mockReset();
  chatMocks.sessionAgentBinding.mockImplementation(async (_root, _session, agentId) => agentId);
  chatMocks.composerAgentIds.length = 0;
  chatMocks.regenerateHandlers.length = 0;
  chatMocks.messagesPaneProps.length = 0;
  chatMocks.fetchProjectTeam.mockReset();
});

afterEach(cleanup);

/**
 * The speaker keys the top strip renders for the demo project team.
 * `agentIdentity.speakerKeyOfName` keys a team member by its name, so the
 * reviewer of the mocked project team is `name:Agent B`.
 */
const REVIEWER_SPEAKER_KEY = 'name:Agent B';
const EXECUTOR_SPEAKER_KEY = 'name:Agent A';

/** The props the last rendered message pane received. */
function latestMessagesPaneProps() {
  const props = chatMocks.messagesPaneProps[chatMocks.messagesPaneProps.length - 1];
  if (!props) throw new Error('the message pane was not rendered');
  return props;
}

/** A speaker button of the top strip, found by its stable speaker key. */
function speakerStripButton(speakerKey: string): HTMLElement {
  const button = document.querySelector<HTMLElement>(`[data-speaker-key="${speakerKey}"]`);
  if (!button) throw new Error(`speaker button not found: ${speakerKey}`);
  return button;
}

/** The "团队" button of the top strip, which clears the speaker filter. */
function teamStripButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>('[data-testid="speaker-filter-team"]');
  if (!button) throw new Error('team button not found');
  return button;
}

it('restores the session execution mode, saves the choice, and hides background review in solo', async () => {
  chatMocks.sessionExecutionMode.mockResolvedValueOnce('solo');
  renderChat(vi.fn());
  const picker = await screen.findByRole('combobox', { name: 'Execution mode' }) as HTMLSelectElement;
  await waitFor(() => expect(picker.value).toBe('solo'));
  expect(screen.queryByTestId('request-review')).toBeNull();
  fireEvent.change(picker, { target: { value: 'autoSplit' } });
  await waitFor(() => expect(chatMocks.sessionExecutionMode).toHaveBeenCalledWith(DEMO_PROJECT.fullPath, 'web:s_agent', 'autoSplit'));
  await waitFor(() => expect(picker.value).toBe('autoSplit'));
});

describe('ChatInterfaceV2 project agents', () => {
  it('offers an explicit retry after GET failure and blocks sending until recovery', async () => {
    chatMocks.sessionAgentBinding.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce('agent-a');
    const sendMessage = vi.fn();
    renderChat(sendMessage);
    await waitFor(() => expect(screen.getByRole('button', { name: '重试会话角色' })).toBeTruthy());
    fireEvent.click(screen.getByTestId('regenerate'));
    expect(sendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试会话角色' }));
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-a'));
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0].options.agentId).toBe('agent-a');
    expect(screen.queryByRole('button', { name: '重试会话角色' })).toBeNull();
  });

  it('retries the failed save explicitly without silently discarding the selected agent', async () => {
    let fail = true;
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, _session, agentId) => {
      if (agentId !== undefined && fail) throw new Error('save failed');
      return agentId;
    });
    const sendMessage = vi.fn();
    renderChat(sendMessage);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await waitFor(() => expect(screen.getByRole('button', { name: '重试会话角色' })).toBeTruthy());
    fireEvent.click(screen.getByTestId('regenerate'));
    expect(sendMessage).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试会话角色' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试会话角色' })).toBeNull());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0].options.agentId).toBe('agent-b');
  });

  it('rereads after a rejected save on revisit and blocks sends until the read completes', async () => {
    let finishRead!: (value: string) => void;
    const reread = new Promise<string>(resolve => { finishRead = resolve; });
    let reads = 0;
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, session, agentId) => {
      if (agentId !== undefined) throw new Error('save failed');
      if (session !== 'web:s_agent') return undefined;
      return ++reads === 1 ? 'agent-a' : reread;
    });
    const sendMessage = vi.fn();
    const view = renderChat(sendMessage);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    expect(sendMessage).not.toHaveBeenCalled();
    view.rerender(<ChatInterfaceV2 {...(chatProps(DEMO_PROJECT, sendMessage, 'web:other') as any)} />);
    await act(async () => {});
    view.rerender(<ChatInterfaceV2 {...(chatProps(DEMO_PROJECT, sendMessage) as any)} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(reads).toBe(2);
    await act(async () => { finishRead('agent-a'); });
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0].options.agentId).toBe('agent-a');
  });

  it('allows retrying the same selection after a rejected save', async () => {
    let fail = true;
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, _session, agentId) => {
      if (agentId !== undefined && fail) throw new Error('save failed');
      return agentId;
    });
    const sendMessage = vi.fn();
    renderChat(sendMessage);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    expect(sendMessage).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0].options.agentId).toBe('agent-b');
  });

  it.each([null, undefined])('preserves persisted binding %s through remount into real send and queue payloads', async (binding) => {
    const bindings = new Map<string, string | null>();
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, session, agentId) => {
      if (agentId !== undefined) bindings.set(session, agentId);
      return bindings.get(session);
    });
    const view = renderChat(vi.fn());
    await act(async () => {});
    if (binding === null) {
      fireEvent.click(screen.getByTestId('clear-agent'));
      await act(async () => {});
    }
    view.unmount();
    chatMocks.realComposer = true;
    const sendMessage = vi.fn((_message: any) => true);
    const remount = renderChat(sendMessage);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0].options.agentId).toBe(binding);
    sendMessage.mockClear();
    const enqueue = vi.fn(async (_item: any) => ({ ok: true }));
    chatMocks.useSessionInputQueue.mockReturnValue({ ...emptyQueue(), enqueue });
    chatMocks.useChatSessionState.mockReturnValue(createChatSessionState({ isLoading: true }));
    remount.rerender(<ChatInterfaceV2 {...(chatProps(DEMO_PROJECT, sendMessage) as any)} />);
    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'queue task' } });
    fireEvent.click(screen.getByTestId('send-input'));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect(enqueue.mock.calls[0][0].options.agentId).toBe(binding);
  });

  it('preserves an explicit draft clear through the real composer into the wire payload', async () => {
    chatMocks.realComposer = true;
    const sendMessage = vi.fn((_message: unknown) => true);
    const view = renderChat(sendMessage);
    chatMocks.useChatSessionState.mockReturnValue(createChatSessionState({ currentSessionId: null }));
    view.rerender(<ChatInterfaceV2 {...({ ...chatProps(DEMO_PROJECT, sendMessage), selectedSession: null } as any)} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution mode' }), { target: { value: 'solo' } });
    fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'draft task' } });
    fireEvent.click(screen.getByTestId('clear-agent'));
    fireEvent.click(screen.getByTestId('send-input'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ type: 'pilotdeck-command', options: { agentId: null, executionMode: 'solo' } });
  });

  it('preserves an explicit clear in the real regenerate payload', async () => {
    const sendMessage = vi.fn();
    renderChat(sendMessage);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('clear-agent'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0].options.agentId).toBeNull();
  });

  it('waits for a pending A save before rereading after A to B to A', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let saved: string | null = null;
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, session, agentId) => {
      if (agentId !== undefined) { await pending; saved = agentId; return agentId; }
      return session === 'web:s_agent' ? saved : null;
    });
    const sendMessage = vi.fn();
    const view = renderChat(sendMessage);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await act(async () => {});
    view.rerender(<ChatInterfaceV2 {...(chatProps(DEMO_PROJECT, sendMessage, 'web:other') as any)} />);
    await act(async () => {});
    view.rerender(<ChatInterfaceV2 {...(chatProps(DEMO_PROJECT, sendMessage) as any)} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('regenerate'));
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => { finish(); await pending; });
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-b'));
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0].options.agentId).toBe('agent-b');
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, _session, agentId) => agentId ?? null);
  });

  it('restores the session binding and isolates same-project session switches', async () => {
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, session, agentId) => agentId === undefined ? (session === 'web:s_agent' ? 'agent-b' : null) : agentId);
    const sendMessage = vi.fn();
    const view = renderChat(sendMessage);
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-b'));
    const before = chatMocks.composerAgentIds.length;
    view.rerender(<ChatInterfaceV2 {...(chatProps(DEMO_PROJECT, sendMessage, 'web:other') as any)} />);
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('none'));
    expect(chatMocks.composerAgentIds.slice(before)).not.toContain('agent-b');
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, _session, agentId) => agentId ?? null);
  });
  it('saves clear and restores a selection after remount without a prompt change', async () => {
    const bindings = new Map<string, string | null>();
    chatMocks.sessionAgentBinding.mockImplementation(async (root, session, agentId) => {
      const key = `${root}:${session}`;
      if (agentId !== undefined) bindings.set(key, agentId);
      return bindings.get(key) ?? null;
    });
    const view = renderChat(vi.fn());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('select-agent-b'));
    await waitFor(() => expect(chatMocks.sessionAgentBinding).toHaveBeenCalledWith(DEMO_PROJECT.fullPath, 'web:s_agent', 'agent-b'));
    view.unmount();
    renderChat(vi.fn());
    await waitFor(() => expect(screen.getByTestId('selected-agent').textContent).toBe('agent-b'));
    fireEvent.click(screen.getByTestId('clear-agent'));
    await waitFor(() => expect(chatMocks.sessionAgentBinding).toHaveBeenCalledWith(DEMO_PROJECT.fullPath, 'web:s_agent', null));
    expect(screen.getByTestId('selected-agent').textContent).toBe('none');
    chatMocks.sessionAgentBinding.mockImplementation(async (_root, _session, agentId) => agentId ?? null);
  });

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
    await waitFor(() => expect(screen.getByTestId('agent-ids').textContent).toBe('agent-c'));
    await act(async () => {});
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
    await expect(staleRenderHandler?.(
      { id: 'message-1', role: 'user', content: 'original request', turnId: 'turn-1' },
      'edited request',
    )).rejects.toThrow('会话角色尚未加载或保存完成');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('ChatInterfaceV2 explicit project review', () => {
  it('asks the workspace reviewer to review the current turn', async () => {
    const sendMessage = vi.fn();
    renderChat(sendMessage);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('review-target').textContent).toBe('agent-b'));

    fireEvent.click(screen.getByTestId('request-review'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [frame] = sendMessage.mock.calls[0] as [{ type: string; options: Record<string, unknown> }];
    expect(frame.type).toBe('project-review-request');
    // The stable agent id is what the backend resolves the reviewer from.
    expect(frame.options.agentId).toBe('agent-b');
    expect(frame.options.sessionId).toBe('web:s_agent');
    expect(frame.options.projectPath).toBe(DEMO_PROJECT.fullPath);
  });

  it('offers no review target when the workspace has no reviewer', async () => {
    renderChat(vi.fn(), OTHER_PROJECT);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    expect(screen.getByTestId('review-target').textContent).toBe('none');
    expect(screen.queryByTestId('request-review')).toBeNull();
  });

  it('sends a single review request while one is pending', async () => {
    const sendMessage = vi.fn();
    renderChat(sendMessage);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('review-target').textContent).toBe('agent-b'));

    fireEvent.click(screen.getByTestId('request-review'));
    fireEvent.click(screen.getByTestId('request-review'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });
});

describe('ChatInterfaceV2 speaker filter wiring', () => {
  it('renders the message pane without a speaker filter by default', async () => {
    renderChat(vi.fn());

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(latestMessagesPaneProps().onSelectSpeaker).toBeTypeOf('function'));

    expect(latestMessagesPaneProps().speakerFilterKey).toBeNull();
    expect(teamStripButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('applies the speaker picked in the top strip to the message pane', async () => {
    renderChat(vi.fn());

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(speakerStripButton(REVIEWER_SPEAKER_KEY)).toBeTruthy());

    fireEvent.click(speakerStripButton(REVIEWER_SPEAKER_KEY));

    await waitFor(() => expect(latestMessagesPaneProps().speakerFilterKey).toBe(REVIEWER_SPEAKER_KEY));
    expect(speakerStripButton(REVIEWER_SPEAKER_KEY).getAttribute('aria-pressed')).toBe('true');
    expect(teamStripButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('shares one filter state between the top strip and the message body', async () => {
    renderChat(vi.fn());

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(speakerStripButton(REVIEWER_SPEAKER_KEY)).toBeTruthy());

    fireEvent.click(speakerStripButton(REVIEWER_SPEAKER_KEY));
    await waitFor(() => expect(latestMessagesPaneProps().speakerFilterKey).toBe(REVIEWER_SPEAKER_KEY));

    /**
     * The body callback has to move the very same filter the top strip owns.
     * A second, independent filter would leave the strip showing the
     * reviewer while the pane already shows the executor.
     */
    const onSelectSpeaker = latestMessagesPaneProps().onSelectSpeaker;
    expect(onSelectSpeaker).toBeTypeOf('function');
    act(() => {
      onSelectSpeaker?.(EXECUTOR_SPEAKER_KEY);
    });

    await waitFor(() => expect(latestMessagesPaneProps().speakerFilterKey).toBe(EXECUTOR_SPEAKER_KEY));
    expect(speakerStripButton(EXECUTOR_SPEAKER_KEY).getAttribute('aria-pressed')).toBe('true');
    expect(speakerStripButton(REVIEWER_SPEAKER_KEY).getAttribute('aria-pressed')).toBe('false');
  });

  it('clears the speaker filter when 团队 is clicked', async () => {
    renderChat(vi.fn());

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(speakerStripButton(REVIEWER_SPEAKER_KEY)).toBeTruthy());

    fireEvent.click(speakerStripButton(REVIEWER_SPEAKER_KEY));
    await waitFor(() => expect(latestMessagesPaneProps().speakerFilterKey).toBe(REVIEWER_SPEAKER_KEY));

    fireEvent.click(teamStripButton());

    await waitFor(() => expect(latestMessagesPaneProps().speakerFilterKey).toBeNull());
    expect(teamStripButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('drops the speaker filter when the session changes', async () => {
    const sendMessage = vi.fn();
    const view = renderChat(sendMessage);

    await waitFor(() => expect(chatMocks.fetchProjectTeam).toHaveBeenCalled());
    await waitFor(() => expect(speakerStripButton(REVIEWER_SPEAKER_KEY)).toBeTruthy());

    fireEvent.click(speakerStripButton(REVIEWER_SPEAKER_KEY));
    await waitFor(() => expect(latestMessagesPaneProps().speakerFilterKey).toBe(REVIEWER_SPEAKER_KEY));

    view.rerender(<ChatInterfaceV2 {...(chatProps(DEMO_PROJECT, sendMessage, 'web:s_other') as any)} />);

    await waitFor(() => expect(latestMessagesPaneProps().speakerFilterKey).toBeNull());
    expect(teamStripButton().getAttribute('aria-pressed')).toBe('true');
  });
});
