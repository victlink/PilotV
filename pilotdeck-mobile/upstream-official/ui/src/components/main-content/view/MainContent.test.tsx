// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppTab, Project } from '../../../types/app';
import MainContentView from './MainContent';
import { useWorkspaceUpload } from '../../main-content-v2/useWorkspaceUpload';
import AppShellV2 from '../../app-shell/AppShellV2';
import { MemoryRouter, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  handleFileOpen: vi.fn(),
  onMisroutedFileUrlHandled: vi.fn(),
  getFiles: vi.fn(),
  upload: vi.fn(),
  check: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  // 文件页现在是「目录整窗 / 编辑器整窗」二选一。editingFile 决定哪一个出现：
  // null = 目录占满整窗，非 null = 编辑器占满整窗。单测靠它切换两种状态。
  editingFile: null as unknown,
}));

vi.mock('../../../utils/api', () => ({
  api: {
    getFiles: mocks.getFiles,
    uploadLimits: async () => ({ ok: true, json: async () => ({ maxFiles: 500, maxFileBytes: 1024 ** 3, maxTaskBytes: 2 * 1024 ** 3 }) }),
    checkWorkspaceUpload: mocks.check,
    uploadFiles: mocks.upload,
    alwaysOnDashboardEvents: async () => ({ ok: true, json: async () => ({ events: [] }) }),
  },
}));

vi.mock('../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test' } }) }));
vi.mock('../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe, isConnected: false }) }));
vi.mock('../../../hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isMobile: false }) }));
vi.mock('../../../hooks/useSessionProtection', () => ({ useSessionProtection: () => ({ activeSessions: new Set(), processingSessions: new Set() }) }));
vi.mock('../../app-shell/useSessionIndicators', async () => {
  const { createContext } = await import('react');
  return { SessionViewReadyContext: createContext(null), useSessionIndicators: () => ({ processingSessions: new Set(), unreadSessionIds: new Set() }) };
});
vi.mock('../../../hooks/useProjectsState', async () => {
  const { useState } = await import('react');
  return { useProjectsState: () => {
    const [activeTab, setActiveTab] = useState('files');
    const [selectedProject, setSelectedProject] = useState(project);
    return {
      selectedProject, setSelectedProject, selectedSession: null, activeTab, setActiveTab,
      sidebarSharedProps: { projects: [project] },
      setSidebarOpen: vi.fn(), refreshProjectsSilently: vi.fn(),
    };
  } };
});
vi.mock('../../app-shell/SidebarV2', () => ({ default: ({ onSelectTab }: { onSelectTab: (tab: AppTab) => void }) => (
  <nav>
    <button onClick={() => onSelectTab('skills')}>Go to skills</button>
    <button onClick={() => onSelectTab('cron')}>Go to scheduled tasks</button>
    <button onClick={() => onSelectTab('files')}>Back to workspace</button>
  </nav>
) }));
vi.mock('../../ui/ConnectionBanner', () => ({ ConnectionBanner: () => null }));
vi.mock('../../settings/Settings', () => ({ default: () => null }));
vi.mock('../../onboarding/view/subcomponents/CreateWorkspaceModal', () => ({ default: () => null }));
vi.mock('../../main-content-v2/SkillsV2', () => ({ default: () => <div data-testid="skills-page" /> }));
vi.mock('../../main-content-v2/CronV2', () => ({ default: () => <div data-testid="cron-page" /> }));

vi.mock('../../../contexts/TaskMasterContext', () => ({
  useTaskMaster: () => ({
    currentProject: { name: 'pilotdeck' },
    setCurrentProject: vi.fn(),
  }),
}));

vi.mock('../../../contexts/TasksSettingsContext', () => ({
  useTasksSettings: () => ({
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    isTaskMasterReady: false,
  }),
}));

vi.mock('../../../hooks/useUiPreferences', () => ({
  useUiPreferences: () => ({
    preferences: {
      autoExpandTools: false,
      showThinking: false,
      inlineThinking: false,
      autoScrollToBottom: true,
      sendByCtrlEnter: false,
    },
  }),
}));

vi.mock('../../code-editor/hooks/useEditorSidebar', () => ({
  useEditorSidebar: () => ({
    editorTabs: [{
      id: 'editor-tab-0',
      fileStack: [{
        name: 'report.pdf',
        path: '/workspace/PilotDeck/report.pdf',
        projectName: 'pilotdeck',
        diffInfo: null,
      }],
      dirty: false,
    }],
    activeEditorTabId: 'editor-tab-0',
    activeFilePath: '/workspace/PilotDeck/report.pdf',
    editingFile: mocks.editingFile,
    editorWidth: 600,
    editorExpanded: false,
    hasManualWidth: false,
    resizeHandleRef: { current: null },
    handleFileOpen: mocks.handleFileOpen,
    handlePreviewFileOpen: vi.fn(),
    handleFileGoBack: vi.fn(),
    handleTabSelect: vi.fn(),
    handleTabClose: vi.fn(),
    handleTabDirtyChange: vi.fn(),
    handleFileRename: vi.fn(),
    handleFileDelete: vi.fn(),
    handleToggleEditorExpand: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('../../code-editor/view/EditorSidebar', () => ({
  default: () => <div data-testid="editor-sidebar" />,
}));

vi.mock('../../chat-v2/ChatInterfaceV2', () => ({
  default: ({ onFileOpen }: { onFileOpen: (filePath: string) => void }) => (
    <button type="button" onClick={() => onFileOpen('/workspace/PilotDeck/generated.pptx')}>
      Open workspace file
    </button>
  ),
}));

vi.mock('../../plugins/view/PluginTabContent', () => ({
  default: () => null,
}));

vi.mock('./ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

class ResizeObserverMock {
  observe() {}

  disconnect() {}
}

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

// Standalone layout tests use a persistent owner, as AppShellV2 does in the app.
function MainContent(props: Omit<ComponentProps<typeof MainContentView>, 'workspaceUpload'>) {
  const workspaceUpload = useWorkspaceUpload(props.selectedProject?.name);
  return <MainContentView {...props} workspaceUpload={workspaceUpload} />;
}

function propsFor(activeTab: AppTab, setActiveTab = vi.fn()) {
  return {
    projects: [project],
    selectedProject: project,
    selectedSession: null,
    activeTab,
    setActiveTab,
    ws: null,
    sendMessage: vi.fn(),
    latestMessage: null,
    isMobile: false,
    onMenuClick: vi.fn(),
    isLoading: false,
    onInputFocusChange: vi.fn(),
    onSessionActive: vi.fn(),
    onSessionInactive: vi.fn(),
    onSessionProcessing: vi.fn(),
    onSessionNotProcessing: vi.fn(),
    processingSessions: new Set<string>(),
    unreadSessionIds: new Set<string>(),
    onReplaceTemporarySession: vi.fn(),
    onNavigateToSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onShowSettings: vi.fn(),
    externalMessageUpdate: 0,
  } as unknown as ComponentProps<typeof MainContent>;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  localStorage.clear();
  mocks.handleFileOpen.mockReset();
  mocks.onMisroutedFileUrlHandled.mockReset();
  mocks.getFiles.mockReset().mockResolvedValue({ ok: true, json: async () => [] });
  mocks.upload.mockReset();
  mocks.check.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  mocks.editingFile = null;
});

function RouteLocation() {
  return <div data-testid="route-location">{useLocation().pathname}</div>;
}

describe('AppShell upload lifetime across dedicated routes', () => {
  // 文件页整窗显示：目录一直在主区里，不需要再点「文件目录」标签。
  async function startShellUpload(files = [new File(['upload contents'], 'large.txt')]) {
    const view = render(<MemoryRouter initialEntries={['/p/pilotdeck']}><AppShellV2 /><RouteLocation /></MemoryRouter>);
    await waitFor(() => expect(view.container.querySelector('input[type="file"]')).not.toBeNull());
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files } });
    await waitFor(() => expect(mocks.check).toHaveBeenCalledOnce());
    return { ...view, files };
  }

  it.each([
    ['skills', 'skills-page', 'preparing'],
    ['skills', 'skills-page', 'uploading'],
    ['scheduled tasks', 'cron-page', 'preparing'],
    ['scheduled tasks', 'cron-page', 'uploading'],
  ])('keeps uploads alive on %s (%s) during %s', async (route, page, phase) => {
    let finishCheck!: (value: unknown) => void;
    let finishUpload!: (value: unknown) => void;
    if (phase === 'preparing') mocks.check.mockImplementation(() => new Promise(resolve => { finishCheck = resolve; }));
    mocks.upload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    const { files, container } = await startShellUpload();
    if (phase === 'uploading') await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    const signal = mocks.check.mock.calls[0][2];
    fireEvent.click(screen.getByRole('button', { name: `Go to ${route}` }));
    expect(await screen.findByTestId(page)).toBeTruthy();
    expect(screen.getByTestId('route-location').textContent).not.toBe('/p/pilotdeck');
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(signal.aborted).toBe(false);
    if (phase === 'preparing') await act(async () => finishCheck({ ok: true, json: async () => ({ success: true }) }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    act(() => mocks.upload.mock.calls[0][2].onProgress(45));
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }));
    expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('45');
    expect(screen.getByTestId('route-location').textContent).toBe('/p/pilotdeck');
    await act(async () => finishUpload({ ok: true, body: { files: files.map(file => ({ name: file.name, size: file.size })), errors: [] } }));
    expect(screen.getByRole('status').textContent).toContain('fileTree.uploadStatus.completed');
  });

  it('preserves a failure and retry after visiting both dedicated routes', async () => {
    let fail!: (reason: unknown) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockImplementationOnce((_project, _form, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    await startShellUpload();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Go to skills' }));
    await screen.findByTestId('skills-page');
    await act(async () => fail(new Error('UPLOAD_NETWORK_ERROR')));
    fireEvent.click(screen.getByRole('button', { name: 'Go to scheduled tasks' }));
    await screen.findByTestId('cron-page');
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'fileTree.uploadStatus.retry' }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'fileTree.uploadStatus.cancel' }));
    await waitFor(() => expect(mocks.upload.mock.calls[1][2].signal.aborted).toBe(true));
  });

  it('shows saved and conflicted files separately when a collision happens after preflight', async () => {
    mocks.upload.mockImplementation(async (_project, form) => {
      const [saved] = form.getAll('files') as File[];
      return { ok: true, body: { files: [{ name: saved.name, size: saved.size }], errors: [{ name: 'b.txt', code: 'UPLOAD_FILE_EXISTS' }] } };
    });
    await startShellUpload([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'fileTree.uploadStatus.failed');
    expect(screen.getByRole('alert').textContent).toContain('fileTree.uploadStatus.partial');
    fireEvent.click(screen.getByText('fileTree.uploadStatus.details'));
    const rows = screen.getAllByRole('listitem');
    expect(rows.some(row => row.textContent === 'a.txtfileTree.uploadStatus.saved')).toBe(true);
    expect(rows.some(row => row.textContent === 'b.txtfileTree.uploadStatus.fileExists')).toBe(true);
    expect(screen.queryByRole('button', { name: 'fileTree.uploadStatus.retry' })).toBeNull();
  });
});

describe('workspace uploads across panel visibility changes', () => {
  // 文件页不再能折叠目录：它整窗显示，能被藏起来的只有整个「文件」标签。
  async function startUpload() {
    const view = render(<MainContent {...propsFor('files')} />);
    await waitFor(() => expect(view.container.querySelector('input[type="file"]')).not.toBeNull());
    const file = new File(['upload contents'], 'large.txt');
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    return { ...view, file, options: mocks.upload.mock.calls[0][2] };
  }

  it('continues uploading while the Files tab is closed and restores progress on return', async () => {
    let finish!: (value: unknown) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender, file, options } = await startUpload();
    rerender(<MainContent {...propsFor('chat')} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(options.signal.aborted).toBe(false);

    act(() => options.onProgress(45));
    rerender(<MainContent {...propsFor('files')} />);
    expect(await screen.findByRole('progressbar')).toHaveProperty('ariaValueNow', '45');
    expect(mocks.upload).toHaveBeenCalledOnce();

    const readsBeforeSave = mocks.getFiles.mock.calls.length;
    await act(async () => finish({ ok: true, body: { files: [{ name: file.name, size: file.size }], errors: [] } }));
    expect(screen.getByRole('status').textContent).toContain('fileTree.uploadStatus.completed');
    await waitFor(() => expect(mocks.getFiles.mock.calls.length).toBeGreaterThan(readsBeforeSave));
  });

  it('shows completion and refreshed files when the upload finishes outside Files', async () => {
    let finish!: (value: unknown) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender, file, options } = await startUpload();
    rerender(<MainContent {...propsFor('chat')} />);
    expect(options.signal.aborted).toBe(false);
    mocks.getFiles.mockResolvedValue({ ok: true, json: async () => [{ name: file.name, path: `/workspace/PilotDeck/${file.name}`, type: 'file' }] });
    await act(async () => finish({ ok: true, body: { files: [{ name: file.name, size: file.size }], errors: [] } }));
    rerender(<MainContent {...propsFor('files')} />);
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'fileTree.uploadStatus.completed');
    await waitFor(() => expect(screen.getAllByText(file.name).length).toBeGreaterThan(1));
  });

  it('keeps failures and retry available after returning to Files, and still supports explicit cancellation', async () => {
    let fail!: (reason: unknown) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockImplementationOnce((_project, _form, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    const { rerender } = await startUpload();
    await act(async () => fail(new Error('UPLOAD_NETWORK_ERROR')));
    fireEvent.click(await screen.findByRole('button', { name: 'fileTree.uploadStatus.retry' }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'fileTree.uploadStatus.cancel' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('fileTree.uploadStatus.cancelled'));
    expect(mocks.upload.mock.calls[1][2].signal.aborted).toBe(true);
    // 回到文件页重挂组件后，失败状态仍然读得回来。
    rerender(<MainContent {...propsFor('chat')} />);
    rerender(<MainContent {...propsFor('files')} />);
    expect(await screen.findByRole('button', { name: 'fileTree.uploadStatus.retry' })).toBeTruthy();
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('MainContent file workspace routing', () => {
  it('gives Files the whole window: no split separators, no docked chat, no panel tabs', async () => {
    const view = render(<MainContent {...propsFor('files')} />);
    await waitFor(() => expect(view.container.querySelector('input[type="file"]')).not.toBeNull());
    // 原来的「文件目录 / 智能对话」两块并排删掉了：目录占满整窗，
    // 中间没有分隔条，右边那两条悬浮标签也不在了。
    expect(screen.queryByRole('separator', { name: /filesWorkbench\.resize/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /filesWorkbench\.fileDirectory|^Files$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /filesWorkbench\.smartChat|Smart Chat/ })).toBeNull();
    const explorer = view.container.querySelector('[data-files-dock-panel="explorer"]');
    expect(explorer).not.toBeNull();
    expect(explorer?.className).toContain('flex-1');
    // 对话面保持挂载（切回对话不丢草稿和流式输出），但文件页里不再显示它。
    expect(view.container.querySelector('[data-files-dock-panel="assistant"]')?.className).toContain('invisible');
  });

  it('hands the whole window to the editor once a file is open — the tree steps aside', async () => {
    mocks.editingFile = {
      name: 'report.pdf',
      path: '/workspace/PilotDeck/report.pdf',
      projectName: 'pilotdeck',
      diffInfo: null,
    };
    const view = render(<MainContent {...propsFor('files')} />);
    await waitFor(() => expect(screen.getByTestId('editor-sidebar')).not.toBeNull());
    // 打开文件后不再左右分屏：目录整个收起，编辑器占满整窗。
    expect(view.container.querySelector('[data-files-dock-panel="explorer"]')).toBeNull();
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    expect(view.container.querySelector('[data-files-dock-panel="assistant"]')?.className).toContain('invisible');
    expect(screen.queryByRole('separator', { name: /filesWorkbench\.resize/ })).toBeNull();
  });

  it('routes every chat file open into the Files workbench', async () => {
    const setActiveTab = vi.fn();
    // 有文件开着：文件页整窗就是编辑器。
    mocks.editingFile = {
      name: 'report.pdf',
      path: '/workspace/PilotDeck/report.pdf',
      projectName: 'pilotdeck',
      diffInfo: null,
    };
    const { rerender } = render(<MainContent {...propsFor('files', setActiveTab)} />);

    expect(await screen.findByTestId('editor-sidebar')).not.toBeNull();

    rerender(<MainContent {...propsFor('chat', setActiveTab)} />);
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace file' }));
    expect(mocks.handleFileOpen).toHaveBeenCalledWith(
      '/workspace/PilotDeck/generated.pptx',
      null,
    );
    expect(setActiveTab).toHaveBeenCalledWith('files');
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();
  });

  it('routes a file-shaped session URL into Files instead of chat', async () => {
    const setActiveTab = vi.fn();
    render(
      <MainContent
        {...propsFor('chat', setActiveTab)}
        misroutedFileFromUrl="/workspace/PilotDeck/report.pdf"
        onMisroutedFileUrlHandled={mocks.onMisroutedFileUrlHandled}
      />,
    );

    await waitFor(() => {
      expect(mocks.handleFileOpen).toHaveBeenCalledWith(
        '/workspace/PilotDeck/report.pdf',
        null,
      );
    });
    expect(setActiveTab).toHaveBeenCalledWith('files');
    expect(setActiveTab).not.toHaveBeenCalledWith('chat');
    expect(mocks.onMisroutedFileUrlHandled).toHaveBeenCalledOnce();
  });

  it('shows the conversation switcher on the conversation tab only', async () => {
    const view = render(<MainContent {...propsFor('files')} />);
    await waitFor(() => expect(view.container.querySelector('input[type="file"]')).not.toBeNull());
    // 文件页里不再顶着一个会切会话的面板，会话切换跟着对话页走。
    expect(screen.queryByTestId('files-conversation-switcher-trigger')).toBeNull();
    expect(screen.queryByRole('separator', { name: 'filesWorkbench.resizeAssistant' })).toBeNull();

    view.rerender(<MainContent {...propsFor('chat')} />);
    expect(view.container.querySelector('[data-files-dock-panel="assistant"]')?.className).not.toContain('invisible');
  });
});
