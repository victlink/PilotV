// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTeamAgent } from '../../../lib/projectTeam';
import ComposerV2 from './Composer';

// 弹出的下拉靠 ResizeObserver 盯着锚点位置；jsdom 没有它。
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

/**
 * The chat locale does not carry the project team role names, so the mock
 * resolves the `projectTeam` namespace explicitly. A missing key must fall
 * back to the empty string so the option label stays readable.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; [key: string]: unknown }) => {
      let value: string;
      if (key === 'projectTeam:roles.commander') value = 'Commander';
      else if (key === 'projectTeam:roles.reviewer') value = 'Reviewer';
      else if (key === 'projectTeam:roles.executor') value = 'Executor';
      else if (key === 'projectTeam:roles.supervisor') value = 'Supervisor';
      else value = options?.defaultValue ?? '';
      // 简单插值，够用来断言「为 <成员名> 选择模型」这类带变量的文案。
      return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(options?.[name] ?? ''),
      );
    },
  }),
}));

const AGENTS: ProjectTeamAgent[] = [
  {
    id: 'agent-commander',
    name: 'Ada',
    role: 'commander',
    enabled: true,
  } as unknown as ProjectTeamAgent,
  {
    id: 'agent-reviewer',
    name: 'Rob',
    role: 'reviewer',
    enabled: true,
  } as unknown as ProjectTeamAgent,
];

const MODEL_CATALOG = [
  {
    id: 'anthropic/claude-review',
    provider: 'anthropic',
    model: 'claude-review',
    displayName: 'Claude Review',
    available: true,
    capabilities: {},
  },
  {
    id: 'openai/gpt-main',
    provider: 'openai',
    model: 'gpt-main',
    displayName: 'GPT Main',
    available: true,
    capabilities: {},
  },
  {
    id: 'router/auto',
    provider: 'pilotdeck',
    model: 'router/auto',
    displayName: 'Auto',
    available: true,
    capabilities: {},
  },
];

function renderComposer(
  agents: ProjectTeamAgent[],
  overrides: {
    selectedAgentId?: string | null;
    onAgentSelectionChange?: (id: string | null) => void;
    onAgentModelChange?: (agentId: string, model: { provider: string; model: string } | null) => void;
    onModelSelectionChange?: (selection: unknown) => void;
    modelCatalog?: unknown[];
    reviewRequestTarget?: { reviewerId: string; reviewerName: string } | null;
    onRequestReview?: () => void;
    isReviewPending?: boolean;
  } = {},
) {
  return render(
    <ComposerV2
      {...({
        input: '',
        placeholder: 'Ask something',
        textareaRef: { current: null },
        inputHighlightRef: { current: null },
        renderInputWithMentions: () => null,
        onInputChange: vi.fn(),
        onTextareaClick: vi.fn(),
        onTextareaKeyDown: vi.fn(),
        onTextareaPaste: vi.fn(),
        onTextareaScrollSync: vi.fn(),
        onTextareaInput: vi.fn(),
        onSubmit: vi.fn(),
        onAbortSession: vi.fn(),
        openImagePicker: vi.fn(),
        onAddAttachmentFiles: vi.fn(),
        attachedImages: [],
        onRemoveImage: vi.fn(),
        onRetryImage: vi.fn(),
        documentReferences: [],
        onRemoveDocumentReference: vi.fn(),
        uploadingImages: new Map(),
        imageErrors: new Map(),
        showFileDropdown: false,
        fileMentionQuery: '',
        filteredFiles: [],
        selectedFileIndex: 0,
        isLoadingFiles: false,
        fileListError: null,
        hasMoreFiles: false,
        onLoadMoreFiles: vi.fn(),
        onSelectFile: vi.fn(),
        selectedFileMentions: [],
        onRemoveFileMention: vi.fn(),
        selectedSkills: [],
        onSelectSkill: vi.fn(),
        onRemoveSkill: vi.fn(),
        selectedCommands: [],
        onRemoveCommand: vi.fn(),
        filteredCommands: [],
        commandQuery: '',
        selectedCommandIndex: 0,
        onCommandSelect: vi.fn(),
        onCloseCommandMenu: vi.fn(),
        isCommandMenuOpen: false,
        frequentCommands: [],
        onToggleCommandMenu: vi.fn(),
        getRootProps: () => ({}),
        getInputProps: () => ({}),
        isDragActive: false,
        isLoading: false,
        canAbortSession: false,
        tokenBudget: null,
        modelCatalog: overrides.modelCatalog ?? [],
        modelSelection: { mode: 'auto', provider: 'pilotdeck', model: 'openai/gpt-test' },
        onModelSelectionChange: overrides.onModelSelectionChange ?? vi.fn(),
        pendingPermissionRequests: [],
        handlePermissionDecision: vi.fn(),
        handleGrantToolPermission: vi.fn(() => ({ success: true })),
        permissionMode: 'default',
        onPermissionModeChange: vi.fn(),
        runMode: 'agent',
        onRunModeChange: vi.fn(),
        projectKey: '/workspace/demo',
        agents,
        selectedAgentId: overrides.selectedAgentId ?? null,
        onAgentSelectionChange: overrides.onAgentSelectionChange ?? vi.fn(),
        onAgentModelChange: overrides.onAgentModelChange ?? vi.fn(),
        reviewRequestTarget: overrides.reviewRequestTarget ?? null,
        onRequestReview: overrides.onRequestReview,
        isReviewPending: overrides.isReviewPending ?? false,
      } as any)}
    />,
  );
}

async function openAgentMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Select agent/ }));
  return screen.findByRole('menu');
}

it('offers the agent dropdown beside the model picker', async () => {
  renderComposer(AGENTS);
  const trigger = screen.getByRole('button', { name: /Select agent/ });
  expect(trigger.textContent).toContain('Default agent');
  // The native <select> is gone for good: the picker is a floating menu now.
  expect(document.querySelector('.pd-composer-agent-control select')).toBeNull();
  expect(document.querySelector('.pd-composer-model-control')).not.toBeNull();

  const menu = await openAgentMenu();
  const items = within(menu).getAllByRole('menuitemradio');
  expect(items).toHaveLength(3);
  expect(items[0].textContent).toContain('Default agent');
  expect(items[1].textContent).toContain('Ada');
  expect(items[2].textContent).toContain('Rob');
  // The role of a team member is shown next to the name.
  expect(items[1].textContent).toContain('Commander');
});

it('marks the current pick and reports the next one', async () => {
  const onAgentSelectionChange = vi.fn();
  renderComposer(AGENTS, {
    selectedAgentId: 'agent-reviewer',
    onAgentSelectionChange,
  });
  const trigger = screen.getByRole('button', { name: /Select agent/ });
  expect(trigger.textContent).toContain('Rob');

  const menu = await openAgentMenu();
  const items = within(menu).getAllByRole('menuitemradio');
  expect(items[0].getAttribute('aria-checked')).toBe('false');
  expect(items[2].getAttribute('aria-checked')).toBe('true');

  fireEvent.click(items[1]);
  expect(onAgentSelectionChange).toHaveBeenCalledWith('agent-commander');
  // Picking closes the menu again.
  expect(screen.queryByRole('menu')).toBeNull();
});

it('hides the agent dropdown when no agent is configured', () => {
  renderComposer([]);
  expect(document.querySelector('.pd-composer-agent-control')).toBeNull();
  expect(screen.queryByRole('button', { name: /Select agent/ })).toBeNull();
});

/**
 * 模型作用域：选中项目成员后，模型菜单改的是「这个成员自己的模型」，
 * 而不是会话默认模型。否则给一个成员换了模型，其它成员看起来也被一起换了。
 */
describe('member scoped model selection', () => {
  it('keeps the session model untouched when a member is picked', async () => {
    const onAgentModelChange = vi.fn();
    const onModelSelectionChange = vi.fn();
    renderComposer(AGENTS, {
      selectedAgentId: 'agent-reviewer',
      onAgentModelChange,
      onModelSelectionChange,
      modelCatalog: MODEL_CATALOG,
    });

    fireEvent.click(screen.getByTitle('Choose a model for Rob'));
    fireEvent.click(await screen.findByRole('button', { name: 'GPT Main' }));

    expect(onAgentModelChange).toHaveBeenCalledWith('agent-reviewer', {
      provider: 'openai',
      model: 'gpt-main',
    });
    expect(onModelSelectionChange).not.toHaveBeenCalled();
  });

  it('changes the session model when no member is picked', async () => {
    const onAgentModelChange = vi.fn();
    const onModelSelectionChange = vi.fn();
    renderComposer(AGENTS, {
      onAgentModelChange,
      onModelSelectionChange,
      modelCatalog: MODEL_CATALOG,
    });

    fireEvent.click(screen.getByTitle('Select model'));
    fireEvent.click(await screen.findByRole('button', { name: 'GPT Main' }));

    expect(onModelSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'model', provider: 'openai', model: 'gpt-main' }),
    );
    expect(onAgentModelChange).not.toHaveBeenCalled();
  });

  it('lets a member go back to the session model', async () => {
    const onAgentModelChange = vi.fn();
    renderComposer(AGENTS, {
      selectedAgentId: 'agent-reviewer',
      onAgentModelChange,
      modelCatalog: MODEL_CATALOG,
    });

    fireEvent.click(screen.getByTitle('Choose a model for Rob'));
    fireEvent.click(await screen.findByRole('button', { name: 'Follow session' }));

    expect(onAgentModelChange).toHaveBeenCalledWith('agent-reviewer', null);
  });

  it('hides the auto entry in the member scope', async () => {
    renderComposer(AGENTS, {
      selectedAgentId: 'agent-reviewer',
      modelCatalog: MODEL_CATALOG,
    });

    fireEvent.click(screen.getByTitle('Choose a model for Rob'));
    const list = await screen.findByText('Claude Review');
    const modelList = list.closest('[data-model-list]');
    expect(modelList?.textContent).not.toContain('Auto');
    // 会话作用域里「自动」仍然可选。
    expect(modelList?.textContent).toContain('Claude Review');
  });

  it('shows the member name in the model picker', () => {
    renderComposer(AGENTS, {
      selectedAgentId: 'agent-reviewer',
      modelCatalog: MODEL_CATALOG,
    });
    expect(screen.getByTitle('Choose a model for Rob')).not.toBeNull();
    // 未选中成员时，标题仍然是会话级的。
    renderComposer(AGENTS, { modelCatalog: MODEL_CATALOG });
    expect(screen.getByTitle('Select model')).not.toBeNull();
  });
});

/**
 * 显式审查入口：manual 协作模式下自动审查不会跑，用户需要一个能主动把
 * 上一轮交给审查员的按钮。按钮只在「确实存在审查员」时出现。
 */
describe('explicit review request', () => {
  const REVIEW_TARGET = { reviewerId: 'agent-reviewer', reviewerName: 'Rob' };

  it('offers the review button for the workspace reviewer', () => {
    renderComposer(AGENTS, { reviewRequestTarget: REVIEW_TARGET, onRequestReview: vi.fn() });
    expect(screen.getByRole('button', { name: 'Ask Rob to review' })).not.toBeNull();
  });

  it('reports the request to the parent instead of deciding who reviews', () => {
    const onRequestReview = vi.fn();
    renderComposer(AGENTS, { reviewRequestTarget: REVIEW_TARGET, onRequestReview });

    fireEvent.click(screen.getByRole('button', { name: 'Ask Rob to review' }));

    expect(onRequestReview).toHaveBeenCalledTimes(1);
  });

  it('hides the review button when no reviewer is known', () => {
    renderComposer(AGENTS, { onRequestReview: vi.fn() });
    expect(screen.queryByRole('button', { name: /to review/ })).toBeNull();
  });

  it('locks the review button while a request is pending', () => {
    renderComposer(AGENTS, {
      reviewRequestTarget: REVIEW_TARGET,
      onRequestReview: vi.fn(),
      isReviewPending: true,
    });

    const button = screen.getByRole('button', { name: 'Ask Rob to review' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

afterEach(cleanup);


