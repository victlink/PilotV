// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  fireEvent.click(screen.getByRole('button', { name: 'Default agent' }));
  return screen.findByRole('menu');
}

it('does not expose an execution Agent selector even with a previously selected agent', () => {
  renderComposer(AGENTS, { selectedAgentId: 'agent-reviewer' });
  expect(screen.queryByRole('button', { name: 'Rob' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Default agent' })).toBeNull();
  expect(document.querySelector('.pd-composer-model-control')).not.toBeNull();
});

afterEach(cleanup);


