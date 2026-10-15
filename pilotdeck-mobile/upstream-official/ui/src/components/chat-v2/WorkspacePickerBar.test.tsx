// @vitest-environment jsdom
import { useCallback, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import WorkspacePickerBar from './WorkspacePickerBar';
import {
  ChatHistorySearchControllerProvider,
  useRegisterChatHistorySearchControls,
} from './ChatHistorySearchController';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('lucide-react', () => ({
  Check: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  Folder: () => null,
  MessageSquare: () => null,
  Plus: () => null,
  Search: () => null,
  X: () => null,
}));

const general: Project = {
  name: 'general',
  displayName: 'general',
  fullPath: '/workspace/general',
  sessions: [],
};

const office: Project = {
  name: 'office',
  displayName: 'office',
  fullPath: '/workspace/office',
  sessions: [],
};

afterEach(() => {
  cleanup();
});

/** 模拟消息区在真实页面里做的事：登记搜索控件并回传 presentation。 */
function SearchConversationMount() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matches = query ? [{}, {}] : [];
  // 身份必须稳定：控件每次注册都会先反注册上一次，反注册会把控制器里
  // 的 isOpen 和 presentation 清空，用内联函数就会自己把自己关掉。
  const openSearch = useCallback(() => setIsOpen(true), []);
  const closeSearch = useCallback(() => {
    setIsOpen(false);
    setQuery('');
  }, []);
  const goToPrevious = useCallback(() => setActiveMatchIndex(index => Math.max(0, index - 1)), []);
  const goToNext = useCallback(
    () => setActiveMatchIndex(index => Math.min(matches.length - 1, index + 1)),
    [matches.length],
  );
  useRegisterChatHistorySearchControls({
    isOpen,
    openSearch,
    closeSearch,
    query,
    setQuery,
    matches,
    activeMatchIndex,
    goToPrevious,
    goToNext,
    inputRef,
  });

  return (
    <>
      <span data-testid="search-query">{query}</span>
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={office}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />
    </>
  );
}

describe('WorkspacePickerBar', () => {
  it('presents a transient missing selection as General', () => {
    render(
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={null}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /通用对话|General conversation/ })).toBeTruthy();
  });

  it('lists existing projects, supports search, and exposes create/none actions', () => {
    const onSelectProject = vi.fn();
    const onSelectNone = vi.fn();
    const onCreateProject = vi.fn();

    render(
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={null}
        onSelectProject={onSelectProject}
        onSelectNone={onSelectNone}
        onCreateProject={onCreateProject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /通用对话|General conversation/ }));
    expect(screen.getByPlaceholderText(/搜索项目|Search projects/)).toBeTruthy();
    expect(screen.getByText('office')).toBeTruthy();
    expect(screen.queryByText('general')).toBeNull();

    fireEvent.click(screen.getByText('office'));
    expect(onSelectProject).toHaveBeenCalledWith(office);

    fireEvent.click(screen.getByRole('button', { name: /通用对话|General conversation/ }));
    fireEvent.click(screen.getByText(/新建项目|New project/));
    expect(onCreateProject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /通用对话|General conversation/ }));
    const generalActions = screen.getAllByText(/通用对话|General conversation/);
    fireEvent.click(generalActions[generalActions.length - 1]);
    expect(onSelectNone).toHaveBeenCalledTimes(1);
  });

  it('falls down the selected project name', () => {
    render(
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={office}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /office/ })).toBeTruthy();
  });

  it('lists projects in the same lastActivity order as the sidebar', () => {
    const older: Project = {
      name: 'Users-wukai-test0806',
      displayName: 'test0806',
      fullPath: '/tmp/test0806',
      lastActivity: 1787215786943,
      sessions: [],
    };
    const newer: Project = {
      name: 'Users-wukai-test0807',
      displayName: 'test0807',
      fullPath: '/tmp/test0807',
      lastActivity: 1787570906592,
      sessions: [],
    };
    const desktop: Project = {
      name: 'Desktop',
      displayName: 'Desktop',
      fullPath: '/tmp/Desktop',
      lastActivity: 1788000000000,
      sessions: [],
    };

    render(
      <WorkspacePickerBar
        projects={[general, older, newer, desktop]}
        selectedProject={null}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /通用对话|General conversation/ }));
    const labels = screen
      .getAllByRole('option')
      .map((node) => node.textContent?.trim());
    expect(labels).toEqual(['Desktop', 'test0807', 'test0806']);
  });
  it('keeps the search button next to the project directory when no conversation is mounted', () => {
    render(
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={office}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    // 没有对话就没有可搜的内容，按钮根本不画；没有 provider 也不能把选择条弄崩。
    expect(screen.queryByRole('button', { name: 'Search current conversation' })).toBeNull();
    expect(screen.getByRole('button', { name: /office/ })).toBeTruthy();
  });

  it('opens the search box in place of the project directory and closes it again', () => {
    render(
      <ChatHistorySearchControllerProvider>
        <SearchConversationMount />
      </ChatHistorySearchControllerProvider>,
    );

    const searchButton = screen.getByRole('button', { name: 'Search current conversation' });
    expect(searchButton.getAttribute('aria-pressed')).toBe('false');
    // 搜索框不在的时候，这一行还是项目目录。
    expect(screen.getByRole('button', { name: /office/ })).toBeTruthy();

    fireEvent.click(searchButton);

    const searchbox = screen.getByRole('searchbox');
    expect(searchbox).toBeTruthy();
    expect(searchButton.getAttribute('aria-pressed')).toBe('true');
    // 搜索框占住项目目录那个位置，不脱流飘到消息区里。
    expect(searchbox.closest('[class*="absolute"]')).toBeNull();
    expect(searchbox.className).not.toContain('absolute');

    fireEvent.click(searchButton);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('button', { name: /office/ })).toBeTruthy();
  });

  it('preserves Chinese IME composition while searching from the composer', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    render(
      <ChatHistorySearchControllerProvider>
        <SearchConversationMount />
      </ChatHistorySearchControllerProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Search current conversation' }));
    const input = screen.getByRole('searchbox') as HTMLInputElement;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'wos' } });
    expect(input.value).toBe('wos');
    expect(screen.getByTestId('search-query').textContent).toBe('');

    fireEvent.change(input, { target: { value: '我是' } });
    fireEvent.compositionEnd(input);

    await waitFor(() => {
      expect(input.value).toBe('我是');
      expect(screen.getByTestId('search-query').textContent).toBe('我是');
    });
  });
});
