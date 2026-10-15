// @vitest-environment jsdom
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import MainAreaV2 from './MainAreaV2';
import type { ReviewOpenRequest } from '../chat-review/ChatReviewContext';

vi.mock('../main-content/view/MainContent', async () => {
  const React = await import('react');
  const { useRegisterChatHistorySearchControls } = await import(
    '../chat-v2/ChatHistorySearchController'
  );

  function RegisteredSearchMock({ activeTab, reviewOpenRequest }: { activeTab: AppTab; reviewOpenRequest?: ReviewOpenRequest }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [activeMatchIndex, setActiveMatchIndex] = React.useState(0);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const openSearch = React.useCallback(() => setIsOpen(true), []);
    const closeSearch = React.useCallback(() => {
      setIsOpen(false);
      setQuery('');
    }, []);
    const matches = query ? [{}, {}] : [];
    useRegisterChatHistorySearchControls({
      isOpen,
      openSearch,
      closeSearch,
      query,
      setQuery,
      matches,
      activeMatchIndex,
      goToPrevious: () => setActiveMatchIndex((index) => Math.max(0, index - 1)),
      goToNext: () => setActiveMatchIndex((index) => Math.min(matches.length - 1, index + 1)),
      inputRef,
    });

    return (
      <div
        data-testid="main-content"
        data-active-tab={activeTab}
        data-review-tab={reviewOpenRequest?.tab}
        data-review-request={reviewOpenRequest?.sequence}
        data-search-open={isOpen ? 'true' : 'false'}
        data-search-query={query}
        data-search-index={activeMatchIndex}
      >
        <button type="button" onClick={openSearch}>Open registered chat search</button>
      </div>
    );
  }

  return {
    default: ({
      activeTab,
      selectedSession,
      reviewOpenRequest,
    }: {
      activeTab: AppTab;
      selectedSession: ProjectSession | null;
      reviewOpenRequest?: ReviewOpenRequest;
    }) => selectedSession
      ? <RegisteredSearchMock activeTab={activeTab} reviewOpenRequest={reviewOpenRequest} />
      : <div data-testid="main-content" data-active-tab={activeTab} />,
  };
});

// 成果页的手绘画布要测自己有多大；jsdom 没有 ResizeObserver。
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

vi.mock('../../utils/api', () => ({
  api: {
    alwaysOnDashboardEvents: vi.fn(async () => new Response(JSON.stringify({ events: [] }))),
  },
}));

vi.mock('../main-content-v2/CronV2', () => ({
  default: () => <div data-testid="cron-page" />,
}));

vi.mock('../main-content-v2/SkillsV2', () => ({
  default: () => <div data-testid="skills-page" />,
}));

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

function Harness({
  initialTab = 'chat',
  withSession = false,
  selectedProject = project,
}: {
  initialTab?: AppTab;
  withSession?: boolean;
  selectedProject?: Project;
}) {
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const props = {
    projects: [project],
    selectedProject,
    selectedSession: withSession ? { id: 'session-1', title: 'Searchable chat' } : null,
    activeTab,
    setActiveTab,
  } as unknown as ComponentProps<typeof MainAreaV2>;

  return <MainAreaV2 {...props} />;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('MainAreaV2 dashboard switcher', () => {
  it('keeps General on chat and hides the project-scoped Files page', async () => {
    const generalProject: Project = {
      name: 'general',
      displayName: 'general',
      kind: 'general',
      fullPath: '/state/pilot-home',
      workspaceCwd: '/workspaces/general',
      capabilities: { files: false, explore: false, projectFileMentions: false },
    };

    render(<Harness initialTab="files" selectedProject={generalProject} />);

    // general 没有文件工作台，顶栏那一页整个不出现，而不是灰着点不动。
    expect(screen.queryByRole('button', { name: '文件' })).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
    });
    expect(screen.getByRole('button', { name: '对话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '成果' })).toBeTruthy();
  });

  it('switches chat, files and artifacts from one three-page header', () => {
    render(<Harness />);

    const pages = within(screen.getByRole('navigation', { name: '页面切换' }));
    const chatButton = pages.getByRole('button', { name: '对话' });
    const filesButton = pages.getByRole('button', { name: '文件' });
    const artifactsButton = pages.getByRole('button', { name: '成果' });

    expect(chatButton.getAttribute('aria-pressed')).toBe('true');
    expect(filesButton.getAttribute('aria-pressed')).toBe('false');
    expect(artifactsButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(filesButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(filesButton.getAttribute('aria-pressed')).toBe('true');
    expect(chatButton.getAttribute('aria-pressed')).toBe('false');

    // 成果页盖住主内容，但不该把底层 tab 改掉：再点对话才切回去。
    fireEvent.click(artifactsButton);
    expect(artifactsButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');

    fireEvent.click(chatButton);
    expect(chatButton.getAttribute('aria-pressed')).toBe('true');
    expect(artifactsButton.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
  });

  it('renames the selected session inline after double-clicking the header title', () => {
    render(<Harness withSession />);

    const title = screen.getByTitle('Searchable chat');
    expect(title.hasAttribute('data-desktop-no-drag')).toBe(true);
    fireEvent.doubleClick(title);
    const input = screen.getByRole('textbox', { name: 'Rename Session' });
    expect((input as HTMLInputElement).value).toBe('Searchable chat');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'Renamed conversation' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTitle('Renamed conversation').textContent).toBe('Renamed conversation');
    expect(JSON.parse(localStorage.getItem('pilotdeck:customSessionTitles') || '{}')).toEqual({
      'session-1': 'Renamed conversation',
    });
  });

  it('cancels an inline session rename when Escape is pressed', () => {
    render(<Harness withSession />);

    fireEvent.doubleClick(screen.getByTitle('Searchable chat'));
    const input = screen.getByRole('textbox', { name: 'Rename Session' });
    fireEvent.change(input, { target: { value: 'Discarded title' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByTitle('Searchable chat').textContent).toBe('Searchable chat');
    expect(localStorage.getItem('pilotdeck:customSessionTitles')).toBeNull();
  });

  it('leaves chat search to the composer instead of the header', () => {
    render(<Harness initialTab="files" withSession />);

    // 搜索按钮搬到了对话框左下角的项目目录旁边，顶栏不再有它。
    expect(screen.queryByRole('button', { name: 'Search current conversation' })).toBeNull();
    expect(screen.queryByLabelText('common:uiText.tools')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('does not leave Files when an embedded chat search opens', () => {
    render(<Harness initialTab="files" withSession />);

    fireEvent.click(screen.getByRole('button', { name: 'Open registered chat search' }));

    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(screen.getByTestId('main-content').getAttribute('data-search-open')).toBe('true');
  });

  it('keeps the page switch available while a dashboard panel is open', () => {
    render(<Harness initialTab="memory" />);

    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('memory');
    const pages = within(screen.getByRole('navigation', { name: '页面切换' }));
    expect(pages.getByRole('button', { name: '对话' })).toBeTruthy();
    expect(pages.getByRole('button', { name: '文件' })).toBeTruthy();
    expect(pages.getByRole('button', { name: '成果' })).toBeTruthy();
    // 看板这类面板有自己的 tab，切回来时对话不用重挂，输入框不会丢草稿。
    expect(screen.getByTestId('main-content')).toBeTruthy();
  });

  it('opens the changes review when the sidebar asks for it', () => {
    render(<Harness withSession />);
    expect(screen.getByTestId('main-content').getAttribute('data-review-tab')).toBeNull();

    fireEvent(window, new Event('pilotdeck:open-changes'));
    expect(screen.getByTestId('main-content').getAttribute('data-review-tab')).toBe('changes');
    expect(screen.getByTestId('main-content').getAttribute('data-review-request')).toBe('1');

    // 再点一次「改动」要能重新弹一次，所以序号必须继续涨。
    fireEvent(window, new Event('pilotdeck:open-changes'));
    expect(screen.getByTestId('main-content').getAttribute('data-review-request')).toBe('2');
  });

  it('leaves artifacts when the sidebar asks for the changes review', () => {
    render(<Harness withSession />);

    fireEvent.click(screen.getByRole('button', { name: '成果' }));
    expect(screen.getByRole('button', { name: '成果' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent(window, new Event('pilotdeck:open-changes'));
    expect(screen.getByRole('button', { name: '成果' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '对话' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('main-content').getAttribute('data-review-tab')).toBe('changes');
  });

  it('replaces the workspace header with only the scheduled tasks title', async () => {
    render(<Harness initialTab="cron" withSession />);

    expect(await screen.findByRole('heading', { name: 'Scheduled Tasks' })).toBeTruthy();
    expect(screen.getByTestId('cron-page')).toBeTruthy();
    expect(screen.queryByTitle('Searchable chat')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search current conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: '文件' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: '页面切换' })).toBeNull();
  });

  it('replaces the workspace header with only the skills title', async () => {
    render(<Harness initialTab="skills" withSession />);

    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByTestId('skills-page')).toBeTruthy();
    expect(screen.queryByTitle('Searchable chat')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search current conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: '文件' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: '页面切换' })).toBeNull();
  });
});
