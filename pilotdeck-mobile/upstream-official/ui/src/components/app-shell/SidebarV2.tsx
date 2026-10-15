import DeviceSwitcher from './DeviceSwitcher';
import DeviceUrlSync from './DeviceUrlSync';
import PilotVLogo from './PilotVLogo';
import { createFrameBatcher } from '../../utils/frameBatcher';
import {
  pinnedProjectSet,
  pinnedSessionSet,
  sessionPinKey,
  toggleProjectPin,
  toggleSessionPin,
  usePinnedItems,
} from '../../lib/pinnedItems';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Loader2,
  Folder,
  MessageSquarePlus,
  Plus,
  Pencil,
  GitBranch,
  Pin,
  Trash2,
  LayoutDashboard,
  Brain,
  Zap,
  BookOpen,
  Sparkles,
  CalendarClock,
} from 'lucide-react';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { isImeEnterEvent } from '../../utils/ime';
import {
  projectDisplayName,
  sessionDisplayTitle,
  setProjectCustomName,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../lib/customNames';
import { compareProjectsBySidebarOrder } from './appShellSelection';
import { artifactCountFor, loadArtifactCounts } from './artifactsMedia';

const asTimestamp = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

// "Most recent activity" for a project = the project summary timestamp when
// available, or the newest timestamp across previewed sessions. The summary
// matters because the sidebar only keeps a capped session preview.
const projectLastActivity = (project: Project): number => {
  let latest = Math.max(
    asTimestamp(project.lastActivity),
    asTimestamp(project.updated_at),
    asTimestamp(project.createdAt),
    asTimestamp(project.created_at),
  );
  const buckets: ProjectSession[][] = [
    Array.isArray(project.sessions) ? project.sessions : [],
  ];
  for (const list of buckets) {
    for (const session of list) {
      const ts = Math.max(
        asTimestamp(session.lastActivity),
        asTimestamp(session.updated_at),
        asTimestamp(session.createdAt),
        asTimestamp(session.created_at),
      );
      if (ts > latest) latest = ts;
    }
  }
  return latest;
};

type FlatSession = {
  session: ProjectSession;
  sessionId: string;
  lastActivity: number;
};

type CompactRecentItem =
  | { kind: 'project'; project: Project; lastActivity: number }
  | { kind: 'session'; project: Project; flat: FlatSession; lastActivity: number };

type SessionTreeNode = {
  flat: FlatSession;
  children: SessionTreeNode[];
};

const isForkChildSession = (session: ProjectSession, knownSessionIds: Set<string>): boolean =>
  Boolean(
    session.parentSessionId &&
    session.sessionKind !== 'background_task' &&
    knownSessionIds.has(session.parentSessionId),
  );

// 树的根节点和子节点都要按同一套顺序排，所以置顶必须在这里生效：
// 上游 collectSessionsForProject 刚排好的顺序在这里会被重新按活动时间覆盖掉。
const compareSessionRows = (
  isPinned: (sessionId: string) => boolean,
) => (left: FlatSession, right: FlatSession) =>
  Number(isPinned(right.sessionId)) - Number(isPinned(left.sessionId))
  || right.lastActivity - left.lastActivity;

const buildSessionTree = (
  flatSessions: FlatSession[],
  isPinned: (sessionId: string) => boolean = () => false,
): SessionTreeNode[] => {
  const byPinThenActivity = compareSessionRows(isPinned);
  const knownSessionIds = new Set(flatSessions.map((item) => item.sessionId));
  const childrenByParent = new Map<string, FlatSession[]>();
  const roots: FlatSession[] = [];

  for (const item of flatSessions) {
    if (isForkChildSession(item.session, knownSessionIds)) {
      const parentId = item.session.parentSessionId as string;
      const list = childrenByParent.get(parentId) ?? [];
      list.push(item);
      childrenByParent.set(parentId, list);
    } else {
      roots.push(item);
    }
  }

  const toNode = (flat: FlatSession): SessionTreeNode => ({
    flat,
    children: (childrenByParent.get(flat.sessionId) ?? [])
      .sort(byPinThenActivity)
      .map(toNode),
  });

  return roots.sort(byPinThenActivity).map(toNode);
};

const collectSessionsForProject = (project: Project): FlatSession[] => {
  const sessions = Array.isArray(project.sessions) ? project.sessions : [];
  return sessions
    .map((session) => ({
      session,
      sessionId: session.id,
      lastActivity: Math.max(
        asTimestamp(session.lastActivity),
        asTimestamp(session.updated_at),
        asTimestamp(session.createdAt),
        asTimestamp(session.created_at),
      ),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity);
};

type SessionIndicatorStatus = 'processing' | 'unread' | 'idle';

export type SidebarV2Props = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isLoading: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
  isMobile?: boolean;
  processingSessions?: Set<string>;
  unreadSessionIds?: Set<string>;
  onSelectProject: (project: Project) => void;
  onSelectSession: (project: Project, sessionId: string) => void;
  onStartNewSession: (project: Project) => void;
  onCreateProject: () => void;
  pendingDraftProjectName?: string | null;
  onRequestDeleteProject: (project: Project) => void;
  onRequestDeleteSession: (project: Project, session: ProjectSession) => void;
  onSelectTab?: (tab: AppTab) => void;
  onShowSettings: () => void;
  onDeselectProject?: () => void;
  onResetProjectSessionPreview?: (projectName: string) => void;
  onCollapse?: () => void;
  onLoadMoreSessions?: (projectName: string) => void;
  loadingMoreProjectIds?: Set<string>;
};

type SidebarContextMenu =
  | {
      kind: 'project';
      project: Project;
      x: number;
      y: number;
    }
  | {
      kind: 'session';
      project: Project;
      session: ProjectSession;
      x: number;
      y: number;
    };

/**
 * 探索收进来的东西。顶栏只留「对话／文件／成果」三个页面切换，
 * 技能和定时任务原先各有一个入口，现在并到侧栏这一个分区里。
 * 「改动」和「资料」不是 tab：改动走对话里的评审面板，资料要带上当前项目，
 * 所以这两项通过事件或 props 交给上层处理。
 */
type ExploreEntry = {
  key: AppTab | 'changes' | 'weknora';
  labelKey: string;
  labelDefault: string;
  icon: ReactNode;
};

const EXPLORE_ENTRIES: ExploreEntry[] = [
  { key: 'dashboard', labelKey: 'tabs.dashboard', labelDefault: 'Dashboard', icon: <LayoutDashboard aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} /> },
  { key: 'memory', labelKey: 'tabs.memory', labelDefault: 'Memory', icon: <Brain aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} /> },
  { key: 'always-on', labelKey: 'tabs.alwaysOn', labelDefault: 'Always-on', icon: <Zap aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} /> },
  { key: 'weknora', labelKey: 'tabs.weknora', labelDefault: '资料', icon: <BookOpen aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} /> },
  { key: 'changes', labelKey: 'dashboardSwitcher.changes', labelDefault: 'Changes', icon: <GitBranch aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} /> },
  { key: 'skills', labelKey: 'sidebar:quickActions.skills', labelDefault: 'Skills', icon: <Sparkles aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} /> },
  // 侧栏这条特意走 explore.scheduledTasks：中文只写「定时」两个字，窄栏里不挤；
  // 主内容区的页面标题仍旧是 quickActions.scheduledTasks 的「定时任务」。
  { key: 'cron', labelKey: 'sidebar:explore.scheduledTasks', labelDefault: 'Scheduled Tasks', icon: <CalendarClock aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} /> },
];

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 132;
const CONTEXT_MENU_MARGIN = 8;

const contextMenuPosition = (event: MouseEvent, height = CONTEXT_MENU_HEIGHT) => {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - height - CONTEXT_MENU_MARGIN;
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientX, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientY, maxY)),
  };
};

function SectionHeading({
  title,
  expanded,
  expandLabel,
  collapseLabel,
  actionLabel,
  actionIcon,
  onAction,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  expandLabel: string;
  collapseLabel: string;
  actionLabel?: string;
  actionIcon?: ReactNode;
  onAction?: () => void;
  onToggle: () => void;
}) {
  const toggleLabel = expanded ? collapseLabel : expandLabel;
  return (
    <div className="tree-heading shrink-0">
      <span>{title}</span>
      <div className="tree-heading-actions">
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            aria-label={actionLabel}
            title={actionLabel}
          >
            {actionIcon ?? (
              <MessageSquarePlus aria-hidden="true" className="icon" size={15} strokeWidth={1.8} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <svg
            aria-hidden="true"
            className={cn('icon transition-transform', !expanded && '-rotate-90')}
            fill="none"
            height="15"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="15"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function SidebarV2({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  isLoading,
  loadError = null,
  onRetryLoad,
  isMobile = false,
  processingSessions,
  unreadSessionIds,
  onSelectProject,
  onSelectSession,
  onStartNewSession,
  onCreateProject,
  pendingDraftProjectName = null,
  onRequestDeleteProject,
  onRequestDeleteSession,
  onSelectTab,
  onShowSettings,
  onLoadMoreSessions,
  loadingMoreProjectIds,
}: SidebarV2Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useCustomNamesVersion();
  const safeProjects = useMemo(() => (Array.isArray(projects) ? projects : []), [projects]);

  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
  // 探索是侧栏底部的一个分区（原先是设置按钮位置上的弹出菜单）：
  // 顶栏只留对话／文件／成果，它和「项目」一样用同一个折叠标题展开收起。
  const [exploreExpanded, setExploreExpanded] = useState(false);
  const [collapsedSessionProjects, setCollapsedSessionProjects] = useState<Set<string>>(new Set());
  // 有成果的对话要标出来、且不能被 Show more 折起来，计数只取一次，之后走缓存。
  const [artifactCounts, setArtifactCounts] = useState<Map<string, number>>(() => new Map());
  // 首屏那份计数常常还没覆盖完所有会话（会话本身也在分页到齐），
  // 所以按「项目 + 会话条数」的签名重拉：签名没变就用缓存，别把接口打爆。
  const artifactCountsSignatureRef = useRef('');
  useEffect(() => {
    const signature = projects
      .map(item => `${item.name}:${Array.isArray(item.sessions) ? item.sessions.length : 0}`)
      .join('|');
    if (artifactCountsSignatureRef.current === signature) return;
    artifactCountsSignatureRef.current = signature;
    // 这里不能像别处那样用 alive 标记提前丢弃：StrictMode 会把 effect 跑两遍，
    // 第一遍的请求正是唯一一次真正要落地的，丢掉它计数就永远停在空表。
    void loadArtifactCounts(true).then(setArtifactCounts);
  }, [projects]);
  const [draftSessionProjectName, setDraftSessionProjectName] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarRootRef = useRef<HTMLElement | null>(null);

  // 只有一棵项目树，对话主目录和两块面板之间的分隔条一起没了，
  // 所以没有可拖的分割比例需要记了。
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  // Resizable sidebar width — clamped to a sensible range and persisted across
  // reloads. Drag-handle on the right edge mutates this on the fly.
  const SIDEBAR_MIN_WIDTH = 76;
  const SIDEBAR_COMPACT_THRESHOLD = 173;
  const SIDEBAR_MAX_WIDTH = 360;
  const SIDEBAR_DEFAULT_WIDTH = 220;
  const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-v2-width';
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    // 248 was the previous default; treat it as unset so the narrower start width applies.
    if (!Number.isFinite(parsed) || parsed === 248) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
  });
  const [isResizing, setIsResizing] = useState(false);
  const isCompact = !isMobile && sidebarWidth <= SIDEBAR_COMPACT_THRESHOLD;
  useEffect(() => {
    if (isMobile) return;
    const appShell = sidebarRootRef.current?.closest<HTMLElement>('.app-shell');
    if (!appShell) return;
    // Updating an inherited custom property invalidates styles throughout the
    // transcript. The grid width belongs only to the shell itself.
    appShell.style.gridTemplateColumns = `${sidebarWidth}px 1px minmax(0, 1fr)`;
    return () => { appShell.style.removeProperty('grid-template-columns'); };
  }, [isMobile, sidebarWidth]);

  const expandCompactSidebar = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_DEFAULT_WIDTH));
    } catch {
      // localStorage may be unavailable.
    }
  }, []);

  const widthDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => widthDragCleanupRef.current?.(), []);

  const handleResizeStart = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    widthDragCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    let dragStarted = false;
    const moveBatch = createFrameBatcher((e: globalThis.MouseEvent) => {
      // A click must reach the handle on mouseup so double-click can reset it.
      if (!dragStarted) {
        if (Math.abs(e.clientX - startX) < 3) return;
        dragStarted = true;
        setIsResizing(true);
      }
      latestWidth = Math.min(SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + (e.clientX - startX)));
      setSidebarWidth(latestWidth);
    });
    const onMove = moveBatch.schedule;
    const cleanup = () => {
      moveBatch.cancel();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      widthDragCleanupRef.current = null;
    };
    const onUp = () => {
      moveBatch.flush();
      cleanup();
      setIsResizing(false);
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(latestWidth)));
      } catch { /* The width remains usable without persistent storage. */ }
    };
    widthDragCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  useEffect(() => {
    if ((renamingProject || renamingSession) && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingProject, renamingSession]);

  useEffect(() => {
    if (!contextMenu) return undefined;

    const closeContextMenu = () => setContextMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };

    window.addEventListener('click', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!selectedProject?.name) return;
    setExpandedGroups((previous) => {
      if (previous.has(selectedProject.name)) return previous;
      const next = new Set(previous);
      next.add(selectedProject.name);
      return next;
    });
  }, [selectedProject?.name]);

  useEffect(() => {
    if (!draftSessionProjectName) return;
    if (!selectedProject || selectedSession || selectedProject.name !== draftSessionProjectName) {
      setDraftSessionProjectName(null);
    }
  }, [draftSessionProjectName, selectedProject, selectedSession]);

  const pinned = usePinnedItems();
  const pinnedProjects = useMemo(() => pinnedProjectSet(pinned), [pinned]);
  const pinnedSessions = useMemo(() => pinnedSessionSet(pinned), [pinned]);

  // general 曾经被单独抽出来放在「对话」主目录里；主目录删掉之后它就是一个
  // 普通文件夹，和其它项目一起按「最近活动 → 名字」排，置顶的排最前。
  const orderedProjects = useMemo(() => {
    const pinRank = (project: Project) => Number(pinnedProjects.has(project.name));
    return [...safeProjects].sort(
      (left, right) => pinRank(right) - pinRank(left) || compareProjectsBySidebarOrder(left, right),
    );
  }, [safeProjects, pinnedProjects]);

  const compactRecentItems = useMemo<CompactRecentItem[]>(() => {
    const items: CompactRecentItem[] = orderedProjects.map((project) => ({
      kind: 'project',
      project,
      lastActivity: projectLastActivity(project),
    }));

    let latestSession: CompactRecentItem | null = null;
    for (const project of safeProjects) {
      for (const flat of collectSessionsForProject(project)) {
        if (!latestSession || flat.lastActivity > latestSession.lastActivity) {
          latestSession = {
            kind: 'session',
            project,
            flat,
            lastActivity: flat.lastActivity,
          };
        }
      }
    }
    if (latestSession) items.push(latestSession);

    return items
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 12);
  }, [orderedProjects, safeProjects]);

  const navToProject = useCallback(
    (name: string) => navigate(`/p/${encodeURIComponent(name)}`),
    [navigate],
  );

  const toggleProjectExpanded = useCallback((project: Project) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(project.name)) {
        next.delete(project.name);
      } else {
        next.add(project.name);
      }
      return next;
    });
  }, []);

  const ensureExpanded = useCallback((project: Project) => {
    setExpandedGroups((previous) => {
      if (previous.has(project.name)) return previous;
      const next = new Set(previous);
      next.add(project.name);
      return next;
    });
  }, []);

  const handleProjectClick = useCallback(
    (project: Project) => {
      if (renamingProject === project.name) return;
      onSelectProject(project);
      toggleProjectExpanded(project);
    },
    [onSelectProject, renamingProject, toggleProjectExpanded],
  );

  const handleSessionClick = useCallback(
    (project: Project, sessionId: string) => {
      if (renamingSession === sessionId) return;
      setDraftSessionProjectName(null);
      onSelectSession(project, sessionId);
      ensureExpanded(project);
    },
    [ensureExpanded, onSelectSession, renamingSession],
  );

  const handleNewSession = useCallback(
    (event: MouseEvent | undefined, project: Project) => {
      event?.stopPropagation();
      setDraftSessionProjectName(project.name);
      ensureExpanded(project);
      onStartNewSession(project);
      navToProject(project.name);
    },
    [ensureExpanded, navToProject, onStartNewSession],
  );

  const openProjectContextMenu = useCallback(
    (event: MouseEvent, project: Project) => {
      if (renamingProject === project.name) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: 'project',
        project,
        x: position.x,
        y: position.y,
      });
    },
    [renamingProject],
  );

  // 触屏没有右键，置顶/改名/删除就全都没入口了，所以长按 0.5 秒补一个手势。
  // 长按触发时紧跟着的那次 click 要吞掉，否则菜单刚打开就被「选中这行」关掉。
  const longPressTimers = useRef(new Map<string, number>());
  const swallowedClickRef = useRef(false);
  const cancelLongPress = useCallback((key: string) => {
    const timer = longPressTimers.current.get(key);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    longPressTimers.current.delete(key);
  }, []);
  const startLongPress = useCallback((
    key: string,
    event: React.PointerEvent,
    open: (event: React.PointerEvent) => void,
  ) => {
    if (event.pointerType === 'mouse') return;
    cancelLongPress(key);
    longPressTimers.current.set(key, window.setTimeout(() => {
      longPressTimers.current.delete(key);
      swallowedClickRef.current = true;
      open(event);
    }, 500));
  }, [cancelLongPress]);

  const openSessionContextMenu = useCallback(
    (event: MouseEvent, project: Project, session: ProjectSession) => {
      if (renamingSession === session.id) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: 'session',
        project,
        session,
        x: position.x,
        y: position.y,
      });
    },
    [renamingSession],
  );

  const beginRenameProject = useCallback((project: Project) => {
    setContextMenu(null);
    setRenamingSession(null);
    setRenamingProject(project.name);
    setRenameDraft(projectDisplayName(project));
  }, []);

  const beginRenameSession = useCallback((session: ProjectSession) => {
    setContextMenu(null);
    setRenamingProject(null);
    setRenamingSession(session.id);
    setRenameDraft(sessionDisplayTitle(session));
  }, []);

  const requestDeleteProject = useCallback(
    (project: Project) => {
      setContextMenu(null);
      onRequestDeleteProject(project);
    },
    [onRequestDeleteProject],
  );

  const requestDeleteSession = useCallback(
    (project: Project, session: ProjectSession) => {
      setContextMenu(null);
      onRequestDeleteSession(project, session);
    },
    [onRequestDeleteSession],
  );

  const handleContextRename = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'project') {
      beginRenameProject(contextMenu.project);
    } else {
      beginRenameSession(contextMenu.session);
    }
  }, [beginRenameProject, beginRenameSession, contextMenu]);

  // 置顶只写本地：后端的项目/会话 id 和磁盘路径一个都不动，
  // 换台设备打开看到的还是原来的顺序。
  const handleContextPinToggle = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'project') {
      toggleProjectPin(contextMenu.project.name);
    } else {
      toggleSessionPin(contextMenu.project.name, contextMenu.session.id);
    }
    setContextMenu(null);
  }, [contextMenu]);

  const contextMenuProjectIsGeneral = contextMenu?.kind === 'project'
    && (contextMenu.project.name === 'general' || contextMenu.project.displayName === 'general');

  const contextMenuPinActive = contextMenu
    ? contextMenu.kind === 'project'
      ? pinnedProjects.has(contextMenu.project.name)
      : pinnedSessions.has(sessionPinKey(contextMenu.project.name, contextMenu.session.id))
    : false;

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'project') {
      requestDeleteProject(contextMenu.project);
    } else {
      requestDeleteSession(contextMenu.project, contextMenu.session);
    }
  }, [contextMenu, requestDeleteProject, requestDeleteSession]);

  // 看板和资料要项目级的探索能力；记忆、常驻、改动、技能、定时任务在
  // General 这类项目下也得留着入口，否则它们就完全没有入口了。
  const exploreEnabled = selectedProject?.capabilities?.explore !== false;
  const visibleExploreEntries = EXPLORE_ENTRIES.filter(
    entry => exploreEnabled || (entry.key !== 'dashboard' && entry.key !== 'weknora'),
  );

  const openExploreEntry = useCallback((key: ExploreEntry['key']) => {
    // 改动不是 tab：它打开当前对话里的评审面板，由主区监听这个事件。
    if (key === 'changes') {
      window.dispatchEvent(new Event('pilotdeck:open-changes'));
      return;
    }
    onSelectTab?.(key);
  }, [onSelectTab]);

  const commitProjectRename = useCallback(() => {
    if (!renamingProject) return;
    setProjectCustomName(renamingProject, renameDraft);
    setRenamingProject(null);
    setRenameDraft('');
  }, [renamingProject, renameDraft]);

  const commitSessionRename = useCallback(() => {
    if (!renamingSession) return;
    setSessionCustomTitle(renamingSession, renameDraft);
    setRenamingSession(null);
    setRenameDraft('');
  }, [renamingSession, renameDraft]);

  const cancelRename = useCallback(() => {
    setRenamingProject(null);
    setRenamingSession(null);
    setRenameDraft('');
  }, []);

  const handleRenameKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, kind: 'project' | 'session') => {
      if (event.key === 'Enter') {
        if (isImeEnterEvent(event)) {
          return;
        }
        event.preventDefault();
        if (kind === 'project') commitProjectRename();
        else commitSessionRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitProjectRename, commitSessionRename],
  );

  const renderSessionRows = (
    project: Project,
    options: { flat?: boolean } = {},
  ) => {
    const COLLAPSED_SESSION_LIMIT = 5;
    const allSessions = collectSessionsForProject(project).slice(0, 500);
    // 置顶的对话排在本项目最上面；同样是置顶/未置顶时保持最近活动顺序。
    const isPinnedSession = (sessionId: string) =>
      pinnedSessions.has(sessionPinKey(project.name, sessionId));
    const isCollapsed = collapsedSessionProjects.has(project.name);
    // 折叠时前 N 条之外的会被 "Show more" 藏起来，但有成果的对话不能跟着一起藏：
    // 成果全落在折叠区时，侧栏看起来就像成果丢了。置顶顺序保持不变，只按原顺序补位。
    const artifactSessions = allSessions.filter(({ sessionId }) => artifactCountFor(artifactCounts, sessionId) > 0);
    const sessions = isCollapsed
      ? Array.from(new Map(
        [...allSessions.slice(0, COLLAPSED_SESSION_LIMIT), ...artifactSessions]
          .map(item => [item.sessionId, item]),
      ).values())
      : allSessions;
    const hiddenLoadedCount = isCollapsed ? Math.max(0, allSessions.length - sessions.length) : 0;
    // If `useProjectsState.bumpSessionActivity` has prepended an optimistic
    // `new-session-*` placeholder for this project, suppress the legacy
    // "+ New Session — not saved yet" draft button so we don't show two
    // stacked rows for the same in-flight session.
    const hasOptimisticSession = allSessions.some(({ session }) =>
      typeof session.id === 'string' && session.id.startsWith('new-session-'),
    );
    const showDraftSession =
      (draftSessionProjectName === project.name || pendingDraftProjectName === project.name) &&
      selectedProject?.name === project.name &&
      activeTab === 'chat' &&
      !selectedSession &&
      !hasOptimisticSession;
    const hasMoreSessions = Boolean(project.sessionMeta?.hasMore);
    const isLoadingMore = Boolean(loadingMoreProjectIds?.has(project.name));
    const totalSessions =
      typeof project.sessionMeta?.total === 'number' ? project.sessionMeta.total : null;
    const remaining =
      totalSessions !== null ? Math.max(0, totalSessions - allSessions.length) : null;

    // `flat` mode is used by the General tab where sessions are rendered as a
    // top-level list (no folder ancestor), so the usual ml-6 indent would
    // leave a weird empty gutter on the left.
    const containerClass = options.flat ? 'tree-list chat-tree-list' : 'project-children';
    const sessionTree = buildSessionTree(sessions, isPinnedSession);
    const sessionTitleById = new Map(
      allSessions.map(({ sessionId, session }) => [sessionId, sessionDisplayTitle(session)]),
    );

    const renderSessionTreeNode = (
      node: SessionTreeNode,
      depth: number,
      isForkChild: boolean,
    ): ReactNode => {
      const { session, sessionId } = node.flat;
      const isSessionActive =
        selectedProject?.name === project.name &&
        selectedSession?.id === sessionId &&
        activeTab === 'chat';
      const isSessionRenaming = renamingSession === sessionId;
      const sessionArtifactCount = artifactCountFor(artifactCounts, sessionId);
      const isOptimisticRow =
        typeof sessionId === 'string' && sessionId.startsWith('new-session-');
      const indicatorStatus: SessionIndicatorStatus = isOptimisticRow
        ? 'processing'
        : processingSessions?.has(sessionId)
          ? 'processing'
          : unreadSessionIds?.has(sessionId)
            ? 'unread'
            : 'idle';
      const indicatorLabel =
        indicatorStatus === 'processing'
          ? t('sidebar:sessions.processing', { defaultValue: 'Agent is running' })
          : indicatorStatus === 'unread'
            ? t('sidebar:sessions.unread', { defaultValue: 'Unread messages' })
            : t('sidebar:sessions.idle', { defaultValue: 'No unread messages' });
      const parentTitle = session.parentSessionId
        ? sessionTitleById.get(session.parentSessionId)
        : undefined;

      return (
        <div
          key={sessionId}
          className={depth > 0 ? 'ml-4 border-l border-neutral-200 pl-2 dark:border-neutral-800' : undefined}
        >
          <div
            onContextMenu={(event) =>
              isOptimisticRow ? undefined : openSessionContextMenu(event, project, session)
            }
            onPointerDown={(event) => {
              if (isOptimisticRow) return;
              const key = `session:${project.name}::${sessionId}`;
              startLongPress(key, event, (pressed) => openSessionContextMenu(pressed, project, session));
            }}
            onPointerUp={() => cancelLongPress(`session:${project.name}::${sessionId}`)}
            onPointerLeave={() => cancelLongPress(`session:${project.name}::${sessionId}`)}
            onPointerCancel={() => cancelLongPress(`session:${project.name}::${sessionId}`)}
            className="group/session relative w-full"
          >
            {isSessionRenaming ? (
              <div className="flex items-center px-2 py-1">
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={commitSessionRename}
                  onKeyDown={(event) => handleRenameKey(event, 'session')}
                  onClick={(event) => event.stopPropagation()}
                  placeholder={t('sidebar:renamePlaceholder', { defaultValue: 'Rename - empty to reset' }) as string}
                  className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={
                  isOptimisticRow
                    ? undefined
                    : () => handleSessionClick(project, sessionId)
                }
                disabled={isOptimisticRow}
                className={cn(
                  options.flat
                    ? 'tree-row chat-row'
                    : 'project-conversation',
                  isSessionActive && 'active',
                  isOptimisticRow && 'cursor-default',
                )}
              >
                <span className={cn('session-indicator', options.flat && 'session-indicator-flat')}
                  data-session-indicator={sessionId} data-status={indicatorStatus} aria-label={indicatorLabel} title={indicatorLabel}>
                  {indicatorStatus === 'processing' ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                    : options.flat && indicatorStatus === 'idle' ? (
                      <svg aria-hidden="true" className="icon" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
                        <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
                      </svg>
                    ) : <span aria-hidden="true" className="conversation-dot" />}
                </span>
                <div className="min-w-0">
                  <div
                    className={cn(
                      'flex min-w-0 items-center gap-1 truncate font-normal',
                      isOptimisticRow && 'italic text-neutral-600 dark:text-neutral-300',
                    )}
                  >
                    {isForkChild ? (
                      <GitBranch className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={2} />
                    ) : null}
                    <span className="truncate">{sessionDisplayTitle(session)}</span>
                    {pinnedSessions.has(sessionPinKey(project.name, session.id)) && (
                      <Pin aria-hidden="true"
                        className="h-3 w-3 shrink-0 fill-current text-blue-600 dark:text-blue-400"
                        strokeWidth={1.75}
                        data-testid={`pinned-session-${session.id}`} />
                    )}
                    {sessionArtifactCount > 0 && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-600 px-1.5 text-[10px] font-semibold leading-4 text-white"
                        title={`${sessionArtifactCount} 个成果`}
                        data-testid={`artifact-count-${session.id}`}
                      >
                        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-2 w-2 fill-current">
                          <path d="M2.5 7.2 4.6 9.4 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {sessionArtifactCount}
                      </span>
                    )}
                  </div>
                  {isOptimisticRow || isForkChild ? (
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      {isOptimisticRow
                        ? t('sidebar:sessions.sending', { defaultValue: 'Sending…' })
                        : t('sidebar:sessions.forkedFrom', {
                            parent: parentTitle || session.parentSessionId || '',
                            defaultValue: `forked from ${parentTitle || session.parentSessionId || 'parent'}`,
                          })}
                    </div>
                  ) : null}
                </div>
              </button>
            )}
          </div>
          {node.children.length > 0 ? (
            <div className="mt-0.5 space-y-0.5">
              {node.children.map((child) => renderSessionTreeNode(child, depth + 1, true))}
            </div>
          ) : null}
        </div>
      );
    };

    return (
      <div className={containerClass}>
        {showDraftSession ? (
          <button
            type="button"
            onClick={(event) => handleNewSession(event, project)}
            className="block w-full rounded-md bg-neutral-200/70 px-2 py-1 text-left text-[14px] leading-5 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <div className="truncate font-normal">
              {t('sidebar:sessions.newSession', { defaultValue: 'New Session' })}
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('sidebar:sessions.unsaved', { defaultValue: 'Not saved yet' })}
            </div>
          </button>
        ) : null}

        {sessionTree.length > 0 ? (
          sessionTree.map((node) => renderSessionTreeNode(node, 0, false))
        ) : (
          <div className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('sidebar:sessions.noSessions', { defaultValue: 'No sessions yet' })}
          </div>
        )}

        {((isCollapsed && hiddenLoadedCount > 0) || (!isCollapsed && hasMoreSessions && onLoadMoreSessions)) ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (isLoadingMore) return;
              if (isCollapsed) {
                setCollapsedSessionProjects((prev) => {
                  const next = new Set(prev);
                  next.delete(project.name);
                  return next;
                });
              } else if (onLoadMoreSessions) {
                onLoadMoreSessions(project.name);
              }
            }}
            disabled={isLoadingMore}
            className={cn(
              'block w-full rounded-md px-2 py-1 text-left text-[11px] transition-colors',
              isLoadingMore
                ? 'text-neutral-400 dark:text-neutral-500'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
            )}
          >
            {isLoadingMore
              ? t('sidebar:sessions.loadingMore', { defaultValue: 'Loading more…' })
              : (() => {
                  const totalMore = hiddenLoadedCount + (remaining !== null && remaining > 0 ? remaining : 0);
                  return totalMore > 0
                    ? t('sidebar:sessions.showMoreCount', {
                        count: totalMore,
                        defaultValue: `Show more (${totalMore})`,
                      })
                    : t('sidebar:sessions.showMore', { defaultValue: 'Show more sessions' });
                })()}
          </button>
        ) : null}

        {!isCollapsed && allSessions.length > COLLAPSED_SESSION_LIMIT ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setCollapsedSessionProjects((prev) => {
                const next = new Set(prev);
                next.add(project.name);
                return next;
              });
            }}
            className="block w-full rounded-md px-2 py-1 text-left text-[11px] transition-colors text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            {t('sidebar:sessions.showLess', { defaultValue: 'Show less' })}
          </button>
        ) : null}
      </div>
    );
  };

  const renderProjectGroup = (project: Project) => {
    // general 现在和其它项目一样是树上的一个文件夹，只是名字仍然本地化显示。
    const isGeneral = project.name === 'general' || project.displayName === 'general';
    const isSelected = project.name === selectedProject?.name;
    const isExpanded = expandedGroups.has(project.name);
    const isRenaming = renamingProject === project.name;
    const label = isGeneral
      ? t('sidebar:general.name', { defaultValue: 'General' })
      : projectDisplayName(project);

    if (isCompact) {
      return (
        <button
          key={project.name}
          type="button"
          title={label as string}
          onClick={() => {
            onSelectProject(project);
            navToProject(project.name);
          }}
          onContextMenu={(event) => openProjectContextMenu(event, project)}
          className={cn('compact-project-entry', isSelected && 'active')}
        >
          <svg aria-hidden="true" className="icon" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
            <path d="m3.3 7 8.7 5 8.7-5" />
            <path d="M12 22V12" />
          </svg>
          <span>{label}</span>
        </button>
      );
    }

    return (
      <div key={project.name} className="project-tree-node">
        <div
          onContextMenu={(event) => openProjectContextMenu(event, project)}
          onPointerDown={(event) => {
            const key = `project:${project.name}`;
            startLongPress(key, event, (pressed) => openProjectContextMenu(pressed, project));
          }}
          onPointerUp={() => cancelLongPress(`project:${project.name}`)}
          onPointerLeave={() => cancelLongPress(`project:${project.name}`)}
          onPointerCancel={() => cancelLongPress(`project:${project.name}`)}
          className={cn(
            'tree-row project-row group/project',
            isSelected && 'active',
          )}
        >
          {isRenaming && !isGeneral ? (
            <div className="col-span-4 flex h-full min-w-0 items-center gap-1.5">
              <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={commitProjectRename}
                onKeyDown={(event) => handleRenameKey(event, 'project')}
                onClick={(event) => event.stopPropagation()}
                placeholder={t('sidebar:renamePlaceholder', { defaultValue: 'Rename - empty to reset' }) as string}
                className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => handleProjectClick(project)}
              aria-expanded={isExpanded}
              className="project-expand-button"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform dark:text-neutral-400',
                  isExpanded && 'rotate-90',
                )}
                strokeWidth={1.75}
              />
              <svg
                aria-hidden="true"
                className={cn(
                  'icon block shrink-0',
                  isSelected
                    ? 'text-neutral-900 dark:text-neutral-100'
                    : 'text-neutral-500 dark:text-neutral-400',
                )}
                fill="none"
                height="16"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
                width="16"
              >
                {isExpanded ? (
                  <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                ) : (
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                )}
              </svg>
              <span className="flex-1 truncate font-normal">{label}</span>
              {pinnedProjects.has(project.name) && (
                <Pin aria-hidden="true"
                  className="h-3 w-3 shrink-0 fill-current text-blue-600 dark:text-blue-400"
                  strokeWidth={1.75}
                  data-testid={`pinned-project-${project.name}`} />
              )}
            </button>
          )}

          {!isRenaming ? (
            <div
              className={cn(
                'project-chat-icon transition-opacity',
                '[@media(hover:none)]:opacity-100',
                isSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/project:opacity-100 focus-within:opacity-100',
              )}
            >
              <button
                type="button"
                onClick={(event) => handleNewSession(event, project)}
                aria-label={t('sidebar:tooltips.newChatForProject', {
                  project: label,
                  defaultValue: `Start a new conversation in ${label}`,
                }) as string}
                title={t('sidebar:tooltips.newChatForProject', {
                  project: label,
                  defaultValue: `Start a new conversation in ${label}`,
                }) as string}
              >
                <MessageSquarePlus aria-hidden="true" className="icon" size={15} strokeWidth={1.8} />
              </button>
            </div>
          ) : null}
        </div>

        {isExpanded ? renderSessionRows(project) : null}
      </div>
    );
  };

  // 「探索」现在就是侧栏底部的一个分区：标题行和「项目」共用 SectionHeading，
  // 点箭头展开收起。展开后条目一次全列出来，不在里面再套一层滚动条，
  // 侧栏不够高的话让「项目」那份列表先让位。
  const renderExploreSection = () => (
    <section className="explore-section tree-section">
      <SectionHeading
        title={t('sidebar:explore.title', { defaultValue: 'Explore' })}
        expanded={exploreExpanded}
        expandLabel={t('sidebar:explore.expand', { defaultValue: 'Expand explore' }) as string}
        collapseLabel={t('sidebar:explore.collapse', { defaultValue: 'Collapse explore' }) as string}
        onToggle={() => setExploreExpanded(previous => !previous)}
      />
      {exploreExpanded ? (
        <div className="tree-list">
          {visibleExploreEntries.map(entry => (
            <button
              key={entry.key}
              type="button"
              onClick={() => openExploreEntry(entry.key)}
              aria-current={activeTab === entry.key ? 'page' : undefined}
              className={cn('explore-row', activeTab === entry.key && 'active')}
            >
              <span className="explore-row-icon">{entry.icon}</span>
              <span className="truncate">{t(entry.labelKey, { defaultValue: entry.labelDefault })}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );

  return (
    <>
      <aside
      ref={sidebarRootRef}
      data-sidebar-v2-root
      onPointerDownCapture={() => { swallowedClickRef.current = false; }}
      onClickCapture={(event) => {
        // 长按已经把菜单打开了，这一下 click 只用来结束手势，别让它去选中并收起菜单。
        if (!swallowedClickRef.current) return;
        swallowedClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{ width: `${sidebarWidth}px` }}
      className={cn(
        // On mobile the parent wraps this aside in an overlay constrained
        // to 85vw, so force the inline width style off with !w-full there.
        'project-sidebar sidebar-shell relative h-full shrink-0 text-neutral-900 dark:text-neutral-100 max-md:!w-full',
        isCompact && 'compact',
      )}
    >
      {isCompact ? (
        <button type="button" aria-label="展开设备选择" className="compact-brand" onClick={expandCompactSidebar}>设备</button>
      ) : (
        <div className="min-h-[62px] shrink-0 border-b border-neutral-200/80 dark:border-neutral-800">
          {/* logo 变成设置入口：侧栏底部原来那个独立设置按钮的位置让给「探索」，
              三块内容（探索／项目／设置）就这样固定下来。 */}
          <div className="flex min-h-[61px] items-center gap-2 pl-3"><button type="button" onClick={onShowSettings}
            aria-label={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
            title={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
            className="shrink-0 rounded text-left"><PilotVLogo height={17} aria-hidden /><span className="sr-only">PilotV</span></button><div className="min-w-0 flex-1"><DeviceSwitcher compact={false} /></div><DeviceUrlSync /></div>
        </div>
      )}
      <nav
        className={isCompact ? 'compact-actions' : 'primary-actions'}
        aria-label={t('sidebar:quickActions.label', { defaultValue: 'Primary actions' }) as string}
      >
        {/* 新对话按钮撤掉了：没有选中对话时，在输入框写第一条就会建对话，
            项目行右侧的「＋」也还在，这里再摆一个只是重复入口。
            定时任务也撤掉了：它并进了底部的「探索」菜单。 */}
      </nav>
      {isCompact ? <span className="compact-divider" /> : null}

      {isCompact ? (
        <>
        <nav
          className="recent-list"
          aria-label={t('sidebar:projects.recent', { defaultValue: 'Recently opened' }) as string}
        >
          {compactRecentItems.map((item) => {
            if (item.kind === 'project') return renderProjectGroup(item.project);

            const { project, flat } = item;
            const isActive =
              selectedProject?.name === project.name &&
              selectedSession?.id === flat.sessionId &&
              activeTab === 'chat';
            const title = sessionDisplayTitle(flat.session);
            return (
              <button
                key={`session-${flat.sessionId}`}
                type="button"
                title={title}
                onClick={() => handleSessionClick(project, flat.sessionId)}
                onContextMenu={(event) => openSessionContextMenu(event, project, flat.session)}
                className={cn('compact-project-entry compact-recent-conversation', isActive && 'active')}
              >
                <svg aria-hidden="true" className="icon" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
                  <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
                </svg>
                <span>{title}</span>
              </button>
            );
          })}
        </nav>
        {renderExploreSection()}
        </>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <section
          className="tree-section flex min-h-0 flex-col"
          style={projectsExpanded ? { minHeight: 0, flex: '1 1 0%' } : { minHeight: 0, flex: '0 0 auto' }}
        >
          <SectionHeading
            title={t('sidebar:projects.title', { defaultValue: 'Projects' })}
            expanded={projectsExpanded}
            expandLabel={t('sidebar:projects.expand', { defaultValue: 'Expand projects' }) as string}
            collapseLabel={t('sidebar:projects.collapse', { defaultValue: 'Collapse projects' }) as string}
            actionLabel={t('sidebar:tooltips.createProject', { defaultValue: 'Create new project' }) as string}
            actionIcon={<Plus aria-hidden="true" className="icon" size={16} strokeWidth={1.8} />}
            onAction={onCreateProject}
            onToggle={() => setProjectsExpanded((previous) => !previous)}
          />

          {projectsExpanded ? (
          <div className="tree-list project-tree-list dock-panel-scrollbar min-h-0 flex-1 overflow-y-auto">
            {isLoading && safeProjects.length === 0 ? (
              <div className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">
                {t('sidebar:sessions.loading', { defaultValue: 'Loading...' })}
              </div>
            ) : loadError && safeProjects.length === 0 ? (
              <div
                role="status"
                className="space-y-2 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
              >
                <p>
                  {t('sidebar:projects.loadError', {
                    defaultValue: 'Projects are temporarily unavailable. Your data has not been removed.',
                  })}
                </p>
                {onRetryLoad ? (
                  <button
                    type="button"
                    className="rounded border border-amber-300/80 px-2 py-1 font-medium hover:bg-amber-50 dark:border-amber-700 dark:hover:bg-amber-950/40"
                    onClick={onRetryLoad}
                  >
                    {t('sidebar:projects.retry', { defaultValue: 'Retry' })}
                  </button>
                ) : null}
              </div>
            ) : orderedProjects.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('sidebar:projects.noProjects', { defaultValue: 'No projects found' })}
              </div>
            ) : (
              <div className="contents">
                {orderedProjects.map((project) => renderProjectGroup(project))}
              </div>
            )}
          </div>
          ) : null}
        </section>
        {renderExploreSection()}
      </div>
      )}

      {/* 设置不再常驻一块：正常宽度下点顶栏 logo 进设置，侧栏底部留给
          「探索」分区；只有收起成图标栏时才补回这个入口。 */}
      {isCompact ? (
      <div className="settings-actions compact">
        <button
          type="button"
          onClick={onShowSettings}
          aria-label={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
          data-tooltip={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
          className="primary-action settings-entry tooltip tooltip-right compact-settings"
        >
          <span className="primary-action-icon">
            <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </span>
          {/* 收成图标栏时这一行字由 CSS 藏掉；少了它，最后一个子元素就变成图标，
              反而被 .compact-settings > span:last-child 一起藏掉。 */}
          <span className="truncate">{t('sidebar:actions.settings', { defaultValue: 'Settings' })}</span>
        </button>
      </div>
      ) : null}

      {contextMenu ? (
        <div
          role="menu"
          aria-label={t('sidebar:contextMenu.label', { defaultValue: 'Context menu' }) as string}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            'fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg',
            'dark:border-neutral-700 dark:bg-neutral-900',
          )}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleContextPinToggle}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
              'text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            <Pin className={cn('h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400', contextMenuPinActive && 'fill-current text-blue-600 dark:text-blue-400')} strokeWidth={1.75} />
            <span>{contextMenuPinActive
              ? t('sidebar:actions.unpin', { defaultValue: 'Unpin' })
              : t('sidebar:actions.pin', { defaultValue: 'Pin' })}</span>
          </button>
          {!contextMenuProjectIsGeneral ? <>
            <button
              type="button"
              role="menuitem"
              onClick={handleContextRename}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
                'text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800',
              )}
            >
              <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
              <span>{t('sidebar:actions.rename', { defaultValue: 'Rename' })}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleContextDelete}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
                'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40',
              )}
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              <span>{t('sidebar:actions.delete', { defaultValue: 'Delete' })}</span>
            </button>
          </> : null}
        </div>
      ) : null}
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar:tooltips.resize', { defaultValue: 'Resize sidebar' }) as string}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
          try {
            window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_DEFAULT_WIDTH));
          } catch {
            // ignore
          }
        }}
        className={cn('sidebar-resizer', isResizing && 'active')}
      >
        <span />
      </div>

      {/* While dragging, paint a fullscreen overlay so the cursor stays
          consistent and we don't accidentally select text in the main pane. */}
      {isResizing ? (
        <div
          className="fixed inset-0 z-[60] cursor-col-resize"
          style={{ userSelect: 'none' }}
        />
      ) : null}
    </>
  );
}
