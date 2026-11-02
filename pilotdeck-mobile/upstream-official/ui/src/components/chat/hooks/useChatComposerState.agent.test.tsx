import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatComposerState } from './useChatComposerState';

const fetchMock = vi.hoisted(() => vi.fn());
const config = { name: '/config', namespace: 'pinned', type: 'builtin', metadata: { type: 'builtin' } };
const help = { name: '/help', namespace: 'builtin' };
const custom = { name: '/summarize', namespace: 'user', type: 'command', path: '/tmp/demo/.pilotdeck/commands/summarize.md' };
// `t` must be referentially stable, exactly like react-i18next in the real app.
// An unstable `t` would silently recreate the submit callback on every render
// and hide the stale-agent regression this file guards against.
const { stableT } = vi.hoisted(() => ({ stableT: (key: string) => key }));

vi.mock('../../../utils/api', () => ({ authenticatedFetch: fetchMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }));

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ pinned: [config], custom: [custom], builtIn: [help] }),
  }));
});

afterEach(cleanup);

function setup(initialAgentId?: string) {
  const sendMessage = vi.fn(() => true);
  const addMessage = vi.fn();
  // Every dependency that feeds the `performSubmit` callback must stay
  // referentially stable across renders. The real application passes a stable
  // `useRef` object and stable callbacks, so an agent change alone must not
  // recreate the submit closure.
  const baseArgs = {
    selectedProject: { name: 'demo', displayName: 'Demo', fullPath: '/tmp/demo' },
    selectedSession: null,
    currentSessionId: null,
    model: 'pilotdeck/model-x',
    modelSelection: { mode: 'model' as const, provider: 'pilotdeck', model: 'model-x' },
    isModelSelectionReady: true,
    isPermissionModeReady: true,
    permissionMode: 'default',
    runMode: 'agent',
    cycleRunMode: vi.fn(),
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    pendingViewSessionRef: { current: null },
    scrollToBottom: vi.fn(),
    addMessage,
    clearMessages: vi.fn(),
    rewindMessages: vi.fn(),
    setIsLoading: vi.fn(),
    setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(),
    setClaudeStatus: vi.fn(),
    setPilotDeckStatus: vi.fn(),
    setIsUserScrolledUp: vi.fn(),
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
  };

  const view = renderHook(
    ({ agentId }: { agentId?: string }) => useChatComposerState({ ...baseArgs, agentId }),
    { initialProps: { agentId: initialAgentId } },
  );

  return { ...view, sendMessage, addMessage };
}

/**
 * Types the message first, exactly like a user does, and only then switches
 * the project agent. Typing is what refreshes the memoized submit closure,
 * so switching the agent afterwards must not fall back to the earlier agent.
 */
async function typeThenSwitchAgent(
  view: ReturnType<typeof setup>,
  nextAgentId?: string,
) {
  await waitFor(() => expect(view.result.current.slashCommandsCount).toBe(3));
  act(() => view.result.current.setInput('run my task'));
  await waitFor(() => expect(view.result.current.input).toBe('run my task'));
  view.rerender({ agentId: nextAgentId });
  await act(() => view.result.current.handleSubmit({ preventDefault: vi.fn() } as never));
}

describe('useChatComposerState project agent selection', () => {
  it('sends the latest selected project agent after the user switches agents', async () => {
    const view = setup('agent-a');

    await typeThenSwitchAgent(view, 'agent-b');

    expect(view.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pilotdeck-command',
      options: expect.objectContaining({ agentId: 'agent-b' }),
    }));
  });

  it('keeps the first selected project agent when the selection does not change', async () => {
    const view = setup('agent-a');

    await typeThenSwitchAgent(view, 'agent-a');

    expect(view.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pilotdeck-command',
      options: expect.objectContaining({ agentId: 'agent-a' }),
    }));
  });

  it('omits the project agent entirely when no agent is selected', async () => {
    const view = setup(undefined);

    await typeThenSwitchAgent(view, undefined);

    expect(view.sendMessage).toHaveBeenCalledTimes(1);
    const [frame] = view.sendMessage.mock.calls[0] as unknown as [{ options: Record<string, unknown> }];
    expect(frame.options).not.toHaveProperty('agentId');
  });

  it('drops a cleared project agent selection before the next submission', async () => {
    const view = setup('agent-a');

    await typeThenSwitchAgent(view, undefined);

    const [frame] = view.sendMessage.mock.calls[0] as unknown as [{ options: Record<string, unknown> }];
    expect(frame.options).not.toHaveProperty('agentId');
  });
});
