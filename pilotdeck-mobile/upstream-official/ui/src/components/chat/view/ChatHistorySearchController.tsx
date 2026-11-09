/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type RegisteredSearchControls = {
  openSearch: () => void;
  closeSearch: () => void;
};

/**
 * 会话搜索面板的数据契约。搜索状态原本只活在消息区里，工作区选择条这类
 * 组件无法自己渲染输入框；这里把必要字段显式暴露出来，让它可以就地
 * （inline）渲染同一个搜索面板，而不是在页面角落再浮一层。
 */
export type ChatHistorySearchPresentation = {
  query: string;
  onQueryChange: (value: string) => void;
  matchCount: number;
  activeMatchIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  inputRef: { current: HTMLInputElement | null };
  historyError?: string | null;
  isLoadingHistory?: boolean;
  onRetryHistory?: () => void;
};

type RegisterChatHistorySearchControlsOptions = RegisteredSearchControls & {
  isOpen: boolean;
  query?: string;
  setQuery?: (value: string) => void;
  matches?: { length: number };
  activeMatchIndex?: number;
  goToPrevious?: () => void;
  goToNext?: () => void;
  inputRef?: { current: HTMLInputElement | null };
  historyError?: string | null;
  isLoadingHistory?: boolean;
  retryHistory?: () => void;
};

type ChatHistorySearchControllerValue = {
  available: boolean;
  isOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  registerControls: (controls: RegisteredSearchControls) => () => void;
  reportOpenState: (isOpen: boolean) => void;
  presentation: ChatHistorySearchPresentation | null;
  reportPresentation: (presentation: ChatHistorySearchPresentation | null) => void;
  inlineHostMounted: boolean;
  setInlineHostMounted: (mounted: boolean) => void;
};

const ChatHistorySearchControllerContext = createContext<ChatHistorySearchControllerValue | null>(null);

const EMPTY_INPUT_REF: { current: HTMLInputElement | null } = { current: null };

export function ChatHistorySearchControllerProvider({ children }: { children: ReactNode }) {
  const controlsRef = useRef<RegisteredSearchControls | null>(null);
  const [available, setAvailable] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [presentation, setPresentation] = useState<ChatHistorySearchPresentation | null>(null);
  const [inlineHostMounted, setInlineHostMounted] = useState(false);

  const registerControls = useCallback((controls: RegisteredSearchControls) => {
    controlsRef.current = controls;
    setAvailable(true);

    return () => {
      if (controlsRef.current !== controls) return;
      controlsRef.current = null;
      setAvailable(false);
      setIsOpen(false);
    };
  }, []);

  const reportOpenState = useCallback((nextIsOpen: boolean) => {
    setIsOpen(nextIsOpen);
  }, []);

  const reportPresentation = useCallback((next: ChatHistorySearchPresentation | null) => {
    setPresentation(next);
  }, []);

  const openSearch = useCallback(() => {
    if (!controlsRef.current) return;
    setIsOpen(true);
    controlsRef.current.openSearch();
  }, []);

  const closeSearch = useCallback(() => {
    setIsOpen(false);
    controlsRef.current?.closeSearch();
  }, []);

  const value = useMemo<ChatHistorySearchControllerValue>(() => ({
    available,
    isOpen,
    openSearch,
    closeSearch,
    registerControls,
    reportOpenState,
    presentation,
    reportPresentation,
    inlineHostMounted,
    setInlineHostMounted,
  }), [
    available,
    closeSearch,
    inlineHostMounted,
    isOpen,
    openSearch,
    presentation,
    registerControls,
    reportOpenState,
    reportPresentation,
  ]);

  return (
    <ChatHistorySearchControllerContext.Provider value={value}>
      {children}
    </ChatHistorySearchControllerContext.Provider>
  );
}

export function useChatHistorySearchController(): ChatHistorySearchControllerValue {
  const controller = useContext(ChatHistorySearchControllerContext);
  if (!controller) {
    throw new Error('useChatHistorySearchController must be used within ChatHistorySearchControllerProvider');
  }
  return controller;
}

/**
 * 没有 provider 时返回 null，而不是抛错。项目选择条这类组件本身可以被
 * 单独渲染和测试，不能因为外面少了一层 provider 就整个挂掉。
 */
export function useOptionalChatHistorySearchController(): ChatHistorySearchControllerValue | null {
  return useContext(ChatHistorySearchControllerContext);
}

export function useRegisterChatHistorySearchControls({
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
  historyError,
  isLoadingHistory,
  retryHistory,
}: RegisterChatHistorySearchControlsOptions): void {
  const controller = useContext(ChatHistorySearchControllerContext);
  const registerControls = controller?.registerControls;
  const reportOpenState = controller?.reportOpenState;
  const reportPresentation = controller?.reportPresentation;

  // 只依赖标量与稳定引用。matches 每次渲染都会换新数组，若把它放进依赖里，
  // presentation 会不停重建 -> effect 反复触发 -> setState -> 再渲染，死循环。
  const matchCount = matches?.length ?? 0;

  // 回调一律走 ref 转发，保证 presentation 的引用在整段会话里保持稳定。
  const actionsRef = useRef({ setQuery, goToPrevious, goToNext, retryHistory });
  useEffect(() => {
    actionsRef.current = { setQuery, goToPrevious, goToNext, retryHistory };
  }, [goToNext, goToPrevious, retryHistory, setQuery]);

  const presentation = useMemo<ChatHistorySearchPresentation | null>(() => {
    if (typeof query !== 'string') return null;
    return {
      query,
      onQueryChange: (value: string) => actionsRef.current.setQuery?.(value),
      matchCount,
      activeMatchIndex: activeMatchIndex ?? 0,
      onPrevious: () => actionsRef.current.goToPrevious?.(),
      onNext: () => actionsRef.current.goToNext?.(),
      inputRef: inputRef ?? EMPTY_INPUT_REF,
      historyError: historyError ?? null,
      isLoadingHistory: isLoadingHistory ?? false,
      onRetryHistory: () => actionsRef.current.retryHistory?.(),
    };
  }, [activeMatchIndex, historyError, inputRef, isLoadingHistory, matchCount, query]);

  useEffect(() => {
    if (!registerControls) return undefined;
    return registerControls({ openSearch, closeSearch });
  }, [closeSearch, openSearch, registerControls]);

  useEffect(() => {
    reportOpenState?.(isOpen);
  }, [isOpen, reportOpenState]);

  useEffect(() => {
    reportPresentation?.(presentation);
    return () => {
      reportPresentation?.(null);
    };
  }, [presentation, reportPresentation]);
}
