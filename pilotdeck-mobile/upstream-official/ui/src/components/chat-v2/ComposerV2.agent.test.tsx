// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTeamAgent } from '../../lib/projectTeam';
import ComposerV2 from './ComposerV2';

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
    t: (key: string, options?: { defaultValue?: string }) => {
      if (key === 'projectTeam:roles.commander') return 'Commander';
      if (key === 'projectTeam:roles.reviewer') return 'Reviewer';
      if (key === 'projectTeam:roles.executor') return 'Executor';
      if (key === 'projectTeam:roles.supervisor') return 'Supervisor';
      return options?.defaultValue ?? '';
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

function renderComposer(
  agents: ProjectTeamAgent[],
  overrides: { selectedAgentId?: string | null; onAgentSelectionChange?: (id: string | null) => void } = {},
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
        modelCatalog: [],
        modelSelection: { mode: 'auto', provider: 'pilotdeck', model: 'openai/gpt-test' },
        onModelSelectionChange: vi.fn(),
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

afterEach(cleanup);


