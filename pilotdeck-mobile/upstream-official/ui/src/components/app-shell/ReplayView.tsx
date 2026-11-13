/**
 * 任务复现（ReplayView）
 *
 * 把一条对话（或整个项目的全部对话）从「提需求」到「完成交付」的整个过程，按时间线
 * 重放出来：用户输入、各 agent 的回复、执行过程（思考 / 工具调用 / 工具返回（含
 * read_file 读出的内联图片）/ 子代理进度 / 任务通知 / 状态），以及成果台里的交付物，
 * 都在各自发生的时间点出现。播放速度可在「正常流式输出速度（1×）」到「快进 10×」
 * 之间无级调节，便于用户用外部硬件录屏把整个过程录下来。
 *
 * 这是纯前端的只读重放：数据来自聊天自身的历史接口（/api/sessions/:id/messages，
 * 需要 projectName/projectPath 定位 transcript）和成果台按会话列举接口，不触发
 * 后台重新执行。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, History, Loader2, Monitor, Package, Pause, Play, RotateCcw, SkipBack, SkipForward, X } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import {
  artifactRawUrl,
  artifactViewerUrl,
  loadSessionArtifacts,
  mediaType,
  type Artifact,
} from './artifactsMedia';
import ArtifactStage from './ArtifactStage';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { cn } from '../../lib/utils.js';
import { projectDisplayName } from '../../lib/customNames';
import type { Project } from '../../types/app';

// ── 播放节奏常量 ──────────────────────────────────────────────────────────────
// 1× 时，文本按「正常流式输出」的节奏逐字出现；10× 时快进 10 倍。
const CHARS_PER_SEC = 55; // 1× 下的流式打字速度（字符/秒）
const MIN_MSG_DUR = 600; // 单条消息最短呈现时间（毫秒，1×）
const MAX_MSG_DUR = 18000; // 单条消息最长呈现时间（毫秒，1×）
const GAP_MS = 220; // 两条事件之间的停顿
const ARTIFACT_DEMO_MS = 3500; // 每份成果在「成果展示台」上的自动演示时长（毫秒，1×）
const SESSION_START_DUR = 600; // 「开始复现某对话」标题的呈现时间
const MIN_SPEED = 1;
const MAX_SPEED = 10;
// 导出 HTML 时内嵌的图片上限：太大了文件打不开。
const EXPORT_EMBED_MAX_BYTES = 6 * 1024 * 1024;

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

const parseTs = (value?: string | null): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const fmtClock = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const fmtWall = (ms: number): string => {
  if (!ms) return '';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
};

const toStr = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

// ── 数据形状（与 ui/server/routes/messages.js 的归一化输出一一对应）────────────
type ReplayImage = { data: string; mimeType?: string };

type ReplayArtifactInfo = { name?: string; path?: string; operation?: string; mimeType?: string };

// ── 代码成果：写代码 / 改代码也是成果 ─────────────────────────────────────────
// 从 tool_use 消息里提取（write_file：全量内容；edit_file：old/new 片段，
// 有全量内容时按顺序累积应用，模拟文件演进）。不依赖成果台服务，纯消息派生。
type CodeArtifact = {
  path: string;
  operation: 'create' | 'modify';
  /** 该时点已知的文件全量内容（来自 write_file 或连续 edit 累积应用） */
  content?: string;
  /** 无全量内容时，本轮对该文件的编辑片段 */
  edits?: Array<{ oldString?: string; newString?: string }>;
};

const CODE_DEMO_MAX_CHARS = 120_000; // 代码成果演示的最大字符数（超出截断）

const CODE_WRITE_TOOLS = new Set(['write_file', 'file_write', 'write', 'create_file', 'save_file']);
const CODE_EDIT_TOOLS = new Set(['edit_file', 'edit', 'multiedit', 'multi_edit', 'replace_code']);

type CodeEditEvent = {
  path: string;
  operation: 'create' | 'modify';
  content?: string;
  oldString?: string;
  newString?: string;
  ts: number;
};

function extractCodeEdit(m: ReplayMessage): CodeEditEvent | null {
  if (m.kind !== 'tool_use' || !m.toolName) return null;
  // 剥掉 MCP 前缀（如 mcp__xxx__write_file）；注意不能按单个下划线拆，
  // 否则 write_file 会变成 file。
  const tool = m.toolName.toLowerCase().includes('__')
    ? m.toolName.toLowerCase().split('__').pop() || ''
    : m.toolName.toLowerCase();
  const isWrite = CODE_WRITE_TOOLS.has(tool);
  const isEdit = CODE_EDIT_TOOLS.has(tool);
  if (!isWrite && !isEdit) return null;
  const input = (m.toolInput != null && typeof m.toolInput === 'object' ? m.toolInput : {}) as Record<string, unknown>;
  const path = toStr(input.file_path) ?? toStr(input.path) ?? toStr(input.filePath);
  if (!path) return null;
  const ts = parseTs(m.timestamp);
  if (isWrite) {
    const content = toStr(input.content) ?? toStr(input.text) ?? toStr(input.code);
    return { path, operation: 'create', content, ts };
  }
  const oldString = toStr(input.old_string) ?? toStr(input.oldString);
  const newString = toStr(input.new_string) ?? toStr(input.newString);
  if (oldString == null && newString == null) return null;
  return { path, operation: 'modify', oldString, newString, ts };
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function codeLanguage(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift',
    c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', sh: 'Shell', bash: 'Shell',
    html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yml: 'YAML', yaml: 'YAML',
    toml: 'TOML', md: 'Markdown', sql: 'SQL', vue: 'Vue', svelte: 'Svelte',
  };
  return map[ext] || (ext ? ext.toUpperCase() : '文本');
}

type ReplayMessage = {
  id: string;
  seq: number;
  kind?: string;
  role?: 'user' | 'assistant';
  content?: string;
  text?: string;
  images?: string[];
  toolResultImages?: ReplayImage[];
  agentName?: string;
  agentRole?: string;
  model?: string;
  toolName?: string;
  toolInput?: unknown;
  isError?: boolean;
  artifacts?: ReplayArtifactInfo[];
  timestamp?: string;
};

type ReplaySessionInfo = {
  id: string;
  title: string;
  sessionKind?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
  createdAt?: string;
  lastActivity?: string;
};

type ReplaySessionData = {
  id: string;
  title: string;
  messages: ReplayMessage[];
  artifacts: Artifact[];
};

type ReplayItem = {
  id: string;
  type: 'message' | 'artifact' | 'session-start';
  sessionId: string;
  sessionTitle: string;
  role?: 'user' | 'assistant';
  messageKind?: string;
  content?: string;
  images?: string[];
  toolResultImages?: ReplayImage[];
  agentName?: string;
  agentRole?: string;
  model?: string;
  toolName?: string;
  toolInput?: unknown;
  isError?: boolean;
  messageArtifacts?: ReplayArtifactInfo[];
  artifact?: Artifact;
  /** 代码成果（写/改代码）：type === 'artifact' 且无 artifact 时有效 */
  codeArtifact?: CodeArtifact;
  /** 成果演示序号：本轮第几份 / 共几份（type === 'artifact' 时有效） */
  demoIndex?: number;
  demoTotal?: number;
  timestamp: number;
  startMs: number;
  durationMs: number;
};

// ── 取数 ──────────────────────────────────────────────────────────────────────
// 历史消息接口按 projectName / projectPath 定位 transcript（projectPath 优先）。
// projectPath 是项目完整路径（Project.fullPath），projectName 是项目名（Project.name）。
async function fetchSessionMessages(
  session: ReplaySessionInfo,
  projectName: string | undefined,
  projectPath: string | undefined,
  signal: AbortSignal,
): Promise<ReplayMessage[]> {
  const out: ReplayMessage[] = [];
  let seq = 0;
  let offset = 0;
  // 最多翻 25 页（每页 500 条），防异常循环。
  for (let page = 0; page < 25; page++) {
    const params = new URLSearchParams();
    if (projectName) params.append('projectName', projectName);
    if (projectPath) params.append('projectPath', projectPath);
    if (session.sessionKind) params.append('sessionKind', session.sessionKind);
    if (session.parentSessionId) params.append('parentSessionId', session.parentSessionId);
    if (session.relativeTranscriptPath) params.append('relativeTranscriptPath', session.relativeTranscriptPath);
    params.append('limit', '500');
    params.append('offset', String(offset));
    const response = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(session.id)}/messages?${params.toString()}`,
      { signal, suppressServerErrorToast: true } as RequestInit,
    );
    if (!response.ok) throw new Error(`对话加载失败（HTTP ${response.status}）`);
    const data = (await response.json()) as { messages?: unknown[]; hasMore?: boolean };
    const batch = Array.isArray(data.messages) ? data.messages : [];
    for (const raw of batch) {
      const m = raw as Record<string, unknown>;
      out.push({
        id: String(m.id ?? `${session.id}-${seq}`),
        seq: seq++,
        kind: toStr(m.kind),
        role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : undefined,
        content: toStr(m.content),
        text: toStr(m.text),
        images: Array.isArray(m.images)
          ? (m.images as unknown[]).filter((v): v is string => typeof v === 'string')
          : undefined,
        toolResultImages: Array.isArray(m.toolResultImages)
          ? (m.toolResultImages as unknown[])
              .map((v): ReplayImage | null => {
                const img = v as { data?: unknown; mimeType?: unknown };
                return typeof img.data === 'string'
                  ? { data: img.data, mimeType: toStr(img.mimeType) }
                  : null;
              })
              .filter((v): v is ReplayImage => v != null)
          : undefined,
        agentName: toStr(m.agentName),
        agentRole: toStr(m.agentRole),
        model: toStr(m.model),
        toolName: toStr(m.toolName),
        toolInput: m.toolInput ?? m.input ?? m.payload,
        isError: m.isError === true,
        artifacts: Array.isArray(m.artifacts) ? (m.artifacts as ReplayArtifactInfo[]) : undefined,
        timestamp: toStr(m.timestamp),
      });
    }
    if (!data.hasMore || batch.length === 0) break;
    offset += batch.length;
  }
  return out;
}

async function fetchProjectSessions(
  projectName: string,
  signal: AbortSignal,
): Promise<ReplaySessionInfo[]> {
  const response = await authenticatedFetch(
    `/api/projects/${encodeURIComponent(projectName)}/sessions?limit=1000&offset=0`,
    { signal, suppressServerErrorToast: true } as RequestInit,
  );
  if (!response.ok) throw new Error(`对话列表加载失败（HTTP ${response.status}）`);
  const data = (await response.json()) as { sessions?: unknown[] };
  const arr = Array.isArray(data.sessions) ? data.sessions : [];
  const sessions = arr.map((raw) => {
    const s = raw as Record<string, unknown>;
    const id = String(s.id ?? '');
    return {
      id,
      title:
        (typeof s.title === 'string' && s.title) ||
        (typeof s.summary === 'string' && s.summary) ||
        (typeof s.name === 'string' && s.name) ||
        id,
      sessionKind: toStr(s.sessionKind),
      parentSessionId: toStr(s.parentSessionId),
      relativeTranscriptPath: toStr(s.relativeTranscriptPath),
      createdAt: toStr(s.createdAt) ?? toStr(s.created_at),
      lastActivity: toStr(s.lastActivity) ?? toStr(s.updated_at),
    } satisfies ReplaySessionInfo;
  });
  // 接口按最近活跃在前返回；复现要按发生先后播，翻成时间正序。
  sessions.sort((a, b) => parseTs(a.createdAt || a.lastActivity) - parseTs(b.createdAt || b.lastActivity));
  return sessions;
}

// ── 把多段会话拼成一条时间线，并估算每条事件在 1× 下的呈现时长 ──────────────────────
function messageTextLength(m: ReplayMessage): number {
  const toolInputLen = m.toolInput != null ? JSON.stringify(m.toolInput).length : 0;
  return Math.max(
    (m.content || '').length,
    (m.text || '').length,
    toolInputLen,
    (m.artifacts || []).reduce((acc, a) => acc + (a.name || a.path || '').length + 8, 0),
    m.images?.length ? 400 * m.images.length : 0,
    m.toolResultImages?.length ? 400 * m.toolResultImages.length : 0,
  );
}

/**
 * 时间线结构：每个会话按「用户输入」切成轮；每轮先按发生顺序重放该轮的对话与
 * 执行过程（需求、回复、思考、工具调用与返回、状态等），**轮对话完成后**进入
 * 「成果演示阶段」——该轮产出的成果逐份上「成果展示台」演示，每份
 * ARTIFACT_DEMO_MS。成果＝成果台交付物 **＋本轮写/改的代码文件**（写代码、
 * 修改代码也是成果）。连续播放时演示节奏自动控制；用步进播放时会在每份成果
 * 出现处暂停，交给用户手动查看（三维可旋转缩放、网页可滚动缩放、代码可滚动）。
 * 没有用户输入的会话整体算一段，段末同样进入成果演示阶段。
 */
function buildTimeline(sessions: ReplaySessionData[]): ReplayItem[] {
  const out: ReplayItem[] = [];
  let cursor = 0;
  for (const sess of sessions) {
    out.push({
      id: `sess-start-${sess.id}`,
      type: 'session-start',
      sessionId: sess.id,
      sessionTitle: sess.title,
      timestamp: 0,
      startMs: cursor,
      durationMs: SESSION_START_DUR,
    });
    cursor += SESSION_START_DUR + GAP_MS;

    // 会话内消息按时间戳稳定排序（同刻按原序）。
    const msgs = [...sess.messages].sort(
      (a, b) => parseTs(a.timestamp) - parseTs(b.timestamp) || a.seq - b.seq,
    );
    const arts = [...sess.artifacts].sort((a, b) => parseTs(a.ts) - parseTs(b.ts));

    // 代码文件状态：跨轮累积每个文件的最新内容（模拟真实文件演进）。
    const codeState = new Map<string, { content?: string }>();

    // 轮边界＝用户文字输入；段边界用消息时间戳给成果归轮。
    const turnIdx: number[] = [];
    msgs.forEach((m, i) => {
      if (m.role === 'user' && m.kind === 'text') turnIdx.push(i);
    });
    type Segment = { from: number; to: number; startTs: number; endTs: number };
    const segments: Segment[] = [];
    if (turnIdx.length === 0) {
      segments.push({ from: 0, to: msgs.length, startTs: Number.NEGATIVE_INFINITY, endTs: Number.POSITIVE_INFINITY });
    } else {
      if (turnIdx[0] > 0) {
        segments.push({
          from: 0,
          to: turnIdx[0],
          startTs: Number.NEGATIVE_INFINITY,
          endTs: parseTs(msgs[turnIdx[0]].timestamp),
        });
      }
      for (let k = 0; k < turnIdx.length; k++) {
        const from = turnIdx[k];
        const to = k + 1 < turnIdx.length ? turnIdx[k + 1] : msgs.length;
        const endTs = k + 1 < turnIdx.length
          ? parseTs(msgs[turnIdx[k + 1]].timestamp)
          : Number.POSITIVE_INFINITY;
        segments.push({ from, to, startTs: parseTs(msgs[from].timestamp), endTs });
      }
    }

    let segCounter = 0;
    for (const seg of segments) {
      segCounter += 1;
      // 先重放本轮的对话与执行过程；同时收集本轮对代码文件的写/改事件。
      const segCodeEvents: CodeEditEvent[] = [];
      for (const m of msgs.slice(seg.from, seg.to)) {
        const duration = clamp((messageTextLength(m) / CHARS_PER_SEC) * 1000, MIN_MSG_DUR, MAX_MSG_DUR);
        out.push({
          id: `m-${m.id}`,
          type: 'message',
          sessionId: sess.id,
          sessionTitle: sess.title,
          role: m.role,
          messageKind: m.kind,
          content: m.content ?? m.text,
          images: m.images,
          toolResultImages: m.toolResultImages,
          agentName: m.agentName,
          agentRole: m.agentRole,
          model: m.model,
          toolName: m.toolName,
          toolInput: m.toolInput,
          isError: m.isError,
          messageArtifacts: m.artifacts,
          timestamp: parseTs(m.timestamp),
          startMs: cursor,
          durationMs: duration,
        });
        cursor += duration + GAP_MS;

        const ce = extractCodeEdit(m);
        if (ce) {
          segCodeEvents.push(ce);
          const st = codeState.get(ce.path);
          if (ce.operation === 'create') {
            codeState.set(ce.path, { content: ce.content });
          } else if (st) {
            if (st.content != null && ce.oldString != null) {
              st.content = st.content.replace(ce.oldString, ce.newString ?? '');
            }
          } else {
            codeState.set(ce.path, { content: undefined });
          }
        }
      }

      // 本轮对话完成 → 成果演示阶段：本轮产出（成果台交付物 + 写/改的代码）
      // 按发生时间合并，逐份上成果展示台演示。
      const segArts = arts.filter((a) => {
        const t = parseTs(a.ts);
        return t >= seg.startTs && t < seg.endTs;
      });
      // 本轮触碰过的代码文件（按最后一次触碰时间排序）。
      const touched = new Map<string, CodeEditEvent[]>();
      for (const ce of segCodeEvents) {
        const list = touched.get(ce.path);
        if (list) list.push(ce);
        else touched.set(ce.path, [ce]);
      }
      const codeDemos = [...touched.entries()]
        .map(([path, evs]) => {
          const st = codeState.get(path);
          const hasFull = st?.content != null && st.content.length > 0;
          return {
            path,
            operation: evs[0].operation,
            content: hasFull ? st!.content : undefined,
            edits: hasFull ? undefined : evs.map((e) => ({ oldString: e.oldString, newString: e.newString })),
            ts: Math.max(...evs.map((e) => e.ts)),
          };
        })
        .sort((a, b) => a.ts - b.ts);

      type Demo = { ts: number; art?: Artifact; code?: CodeArtifact };
      const demos: Demo[] = [
        ...segArts.map((a) => ({ ts: parseTs(a.ts), art: a })),
        ...codeDemos.map((c) => ({ ts: c.ts, code: c })),
      ].sort((x, y) => x.ts - y.ts);

      demos.forEach((d, idx) => {
        out.push({
          id: d.art ? `a-${d.art.id}` : `code-${sess.id}-${segCounter}-${idx}`,
          type: 'artifact',
          sessionId: sess.id,
          sessionTitle: sess.title,
          artifact: d.art,
          codeArtifact: d.code,
          timestamp: d.ts,
          startMs: cursor,
          durationMs: ARTIFACT_DEMO_MS,
          demoIndex: idx + 1,
          demoTotal: demos.length,
        });
        cursor += ARTIFACT_DEMO_MS + GAP_MS;
      });
    }
  }
  return out;
}

// ── 单条事件的渲染（memo：只有正在流式出现的那条会逐帧重渲）──────────────────────
const ReplayRow = memo(function ReplayRow({ item, progress, stageOpen }: {
  item: ReplayItem;
  progress: number;
  stageOpen: boolean;
}) {
  if (progress <= 0) return null;
  if (item.type === 'session-start') {
    return (
      <div className="my-4 flex flex-wrap items-center gap-2 text-[13px] font-medium text-neutral-500 dark:text-neutral-400">
        <History className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        <span>开始复现对话：{item.sessionTitle}</span>
        {item.timestamp ? <span className="text-[11px] opacity-60">{fmtWall(item.timestamp)}</span> : null}
      </div>
    );
  }
  if (item.type === 'artifact' && (item.artifact || item.codeArtifact)) {
    // 成果主体在右侧「成果展示台」演示；流里只留一行轻量提示。
    // 成果台被收起时退回富卡片（内联图片 / 代码内容 / 链接）。
    return stageOpen
      ? <ArtifactDemoRow item={item} />
      : item.artifact
        ? <ArtifactCard artifact={item.artifact} progress={progress} />
        : <CodeCardInline code={item.codeArtifact!} />;
  }
  return <MessageRow item={item} progress={progress} />;
});

// 成果演示行：本轮对话完成后，成果逐份上成果展示台演示（含代码成果）。
function ArtifactDemoRow({ item }: { item: ReplayItem }) {
  const isCode = !item.artifact && item.codeArtifact != null;
  const title = isCode
    ? basename(item.codeArtifact!.path)
    : item.artifact!.title || item.artifact!.file_name || item.artifact!.source_path || '成果';
  const type = isCode ? null : mediaType(item.artifact!);
  const hint = isCode
    ? '代码成果 · 可滚动查看'
    : type === 'model3d'
      ? '成果台演示中 · 可旋转 / 缩放'
      : type === 'iframe' || type === 'markdown'
        ? '成果台演示中 · 可滚动 / 缩放'
        : type === 'image' || type === 'video'
          ? '成果台演示中 · 可缩放查看'
          : '成果台演示中';
  return (
    <div className="my-1.5 flex justify-start">
      <div className="flex max-w-[92%] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-emerald-300/60 bg-emerald-50/60 px-3 py-1.5 text-[12.5px] text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/20 dark:text-emerald-300">
        <span className="shrink-0">{isCode ? '💻' : '📦'}</span>
        <span className="shrink-0 font-medium">
          本轮成果 {item.demoIndex ?? 1}/{item.demoTotal ?? 1}
        </span>
        <span className="min-w-0 truncate opacity-80">{title}</span>
        <span className="shrink-0 text-[11px] opacity-60">{hint}</span>
      </div>
    </div>
  );
}

// 成果台收起时代码成果的内联卡（预览前若干行，全量内容在「成果」演示视图里）。
function CodeCardInline({ code }: { code: CodeArtifact }) {
  const lines = code.content != null ? code.content.split('\n') : [];
  const preview = lines.slice(0, 40).join('\n');
  return (
    <div className="my-2 rounded-lg border border-emerald-300/60 bg-emerald-50/60 p-3 dark:border-emerald-500/40 dark:bg-emerald-950/20">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px] font-medium text-emerald-800 dark:text-emerald-300">
        <span>💻 代码成果 · {code.operation === 'create' ? '新建' : '修改'}</span>
        <span className="font-mono text-[11.5px] font-normal opacity-70">{code.path}</span>
        <span className="text-[11px] font-normal opacity-60">{codeLanguage(code.path)}</span>
        {lines.length > 40 ? <span className="text-[11px] font-normal opacity-60">（前 40 行 / 共 {lines.length} 行）</span> : null}
      </div>
      {preview ? (
        <pre className="max-h-64 overflow-auto whitespace-pre rounded-md bg-neutral-100 p-2 font-mono text-[12px] leading-relaxed text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">{preview}</pre>
      ) : code.edits && code.edits.length > 0 ? (
        <div className="flex flex-col gap-1">
          {code.edits.slice(0, 3).map((e, i) => (
            <div key={i} className="text-[12px]">
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-100 p-1.5 font-mono text-[11.5px] text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">{truncate(e.oldString || '', 400)}</pre>
              <div className="my-0.5 pl-1 text-[10px] opacity-50">↓ 改为</div>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-emerald-100/70 p-1.5 font-mono text-[11.5px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{truncate(e.newString || '', 400)}</pre>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] opacity-70">（本轮编辑片段未含内容）</div>
      )}
    </div>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function typeSlice(text: string, progress: number): string {
  if (progress >= 1) return text;
  return text.slice(0, Math.floor(progress * text.length));
}

// 工具调用卡
function ToolUseCard({ item, progress }: { item: ReplayItem; progress: number }) {
  const inputText = item.toolInput != null ? truncate(JSON.stringify(item.toolInput, null, 2), 1200) : '';
  const shown = typeSlice(inputText, progress);
  return (
    <div className="my-2 flex justify-start">
      <div className="max-w-[90%] rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
        <div className="mb-1 font-medium">🔧 调用工具：{item.toolName || 'unknown'}</div>
        {shown ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] opacity-80">{shown}</pre> : null}
      </div>
    </div>
  );
}

// 工具返回卡（内联 read_file 等读出的图片）
function ToolResultCard({ item, progress }: { item: ReplayItem; progress: number }) {
  const text = item.content || '';
  const shown = truncate(typeSlice(text, progress), 2000);
  const images = item.toolResultImages || [];
  return (
    <div className="my-2 flex justify-start pl-4">
      <div className="max-w-[90%] rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 text-[13px] text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        <div className="mb-1 font-medium text-neutral-500 dark:text-neutral-400">
          工具返回{item.isError ? '（出错）' : ''}
        </div>
        {shown ? <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] opacity-90">{shown}</pre> : null}
        {progress >= 1 && images.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img, idx) => (
              <img
                key={idx}
                src={img.data}
                alt={`工具返回图片 ${idx + 1}`}
                className="max-h-56 rounded-md border border-black/10 dark:border-white/10"
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 思考过程
function ThinkingCard({ item, progress }: { item: ReplayItem; progress: number }) {
  const full = item.content || '';
  const complete = progress >= 1;
  const shown = typeSlice(full, progress);
  return (
    <div className="my-2 flex justify-start">
      <div className="max-w-[90%] rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-[13px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        <div className="mb-1 text-[12px] italic">💭 思考过程</div>
        {complete ? <Markdown>{full}</Markdown> : <span className="whitespace-pre-wrap break-words">{shown}</span>}
      </div>
    </div>
  );
}

// agent 活动 / 子代理进度 / 任务通知 / 状态 / 错误 等「执行过程」行
function ActivityLine({ item, progress }: { item: ReplayItem; progress: number }) {
  const body = typeSlice(item.content || '', progress);

  const who = item.agentName || '系统';
  const kind = item.messageKind;
  const icon = kind === 'subagent_progress'
    ? '🔀'
    : kind === 'task_notification'
      ? '📋'
      : kind === 'error'
        ? '⚠️'
        : kind === 'interrupted'
          ? '✋'
          : kind === 'compact_boundary'
            ? '🗜️'
            : kind === 'permission_request' || kind === 'interactive_prompt'
              ? '❓'
              : '⚙️';

  const label = kind === 'subagent_progress'
    ? '子代理进度'
    : kind === 'task_notification'
      ? '任务通知'
      : kind === 'agent_activity'
        ? '执行活动'
        : kind === 'error'
          ? '错误'
          : kind === 'interrupted'
            ? '已中断'
            : kind === 'compact_boundary'
              ? '上下文压缩'
              : kind === 'permission_request'
                ? '等待授权'
                : kind === 'interactive_prompt'
                  ? '等待用户输入'
                  : kind === 'complete'
                    ? '完成'
                    : '状态';

  return (
    <div className="my-1.5 flex justify-start">
      <div className="flex max-w-[92%] items-start gap-2 rounded-md bg-neutral-100/70 px-2.5 py-1.5 text-[12.5px] text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="font-medium text-neutral-700 dark:text-neutral-200">
            {label} · {who}
          </span>
          {item.agentRole ? <span className="ml-1 text-neutral-400">（{item.agentRole}）</span> : null}
          {body ? <span className="mt-0.5 block whitespace-pre-wrap break-words opacity-90">{truncate(body, 600)}</span> : null}
        </span>
      </div>
    </div>
  );
}

// 普通对话气泡（用户 / 助手文字，用户可带图片附件）
function ChatBubble({ item, progress }: { item: ReplayItem; progress: number }) {
  const full = item.content || '';
  const complete = progress >= 1;
  const shown = typeSlice(full, progress);
  const isUser = item.role === 'user';
  const who = isUser
    ? '你'
    : item.agentName || '助手';
  const images = item.images || [];
  return (
    <div className={cn('my-2 flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[88%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed',
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100',
        )}
      >
        <div className="mb-0.5 text-[11px] font-medium opacity-60">
          {who}
          {!isUser && item.agentRole ? ` · ${item.agentRole}` : ''}
        </div>
        {complete ? <Markdown>{full}</Markdown> : <span className="whitespace-pre-wrap break-words">{shown}</span>}
        {!complete && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-current align-middle" />}
        {complete && images.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((src, idx) => (
              <img
                key={idx}
                src={src}
                alt={`附件图片 ${idx + 1}`}
                className="max-h-56 rounded-md border border-black/10 dark:border-white/10"
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 消息里内嵌的交付文件列表（kind: file_artifacts）
function FileArtifactsCard({ item, progress }: { item: ReplayItem; progress: number }) {
  const arts = item.messageArtifacts || [];
  const shownCount = Math.max(1, Math.floor(progress * arts.length));
  const shown = arts.slice(0, shownCount);
  return (
    <div className="my-2 flex justify-start">
      <div className="max-w-[90%] rounded-lg border border-sky-300/60 bg-sky-50/60 px-3 py-2 text-[13px] text-sky-900 dark:border-sky-500/40 dark:bg-sky-950/20 dark:text-sky-200">
        <div className="mb-1 font-medium">📎 交付文件</div>
        <div className="flex flex-col gap-0.5">
          {shown.map((art, idx) => (
            <div key={idx} className="text-[12.5px]">
              · {art.name || art.path || '文件'}
              {art.operation ? <span className="ml-1 opacity-60">（{art.operation}）</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ item, progress }: { item: ReplayItem; progress: number }) {
  switch (item.messageKind) {
    case 'tool_use':
      return <ToolUseCard item={item} progress={progress} />;
    case 'tool_result':
      return <ToolResultCard item={item} progress={progress} />;
    case 'thinking':
      return <ThinkingCard item={item} progress={progress} />;
    case 'file_artifacts':
      return <FileArtifactsCard item={item} progress={progress} />;
    case 'text':
      return <ChatBubble item={item} progress={progress} />;
    case 'status':
      if (!item.content) return null; // 空状态行不占画面
      return <ActivityLine item={item} progress={progress} />;
    default:
      // error / subagent_progress / task_notification / agent_activity /
      // complete / interrupted / permission_request 等执行过程类消息
      return item.content ? <ActivityLine item={item} progress={progress} /> : null;
  }
}

function ArtifactCard({ artifact, progress }: { artifact: Artifact; progress: number }) {
  const type = mediaType(artifact);
  const title = artifact.title || artifact.file_name || artifact.source_path || '成果';
  const url = artifactRawUrl(artifact);
  const opacity = clamp(progress * 1.4, 0, 1);
  return (
    <div
      className="my-3 rounded-lg border border-emerald-300/60 bg-emerald-50/60 p-3 dark:border-emerald-500/40 dark:bg-emerald-950/20"
      style={{ opacity }}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-emerald-800 dark:text-emerald-300">
        <span>📦 成果交付</span>
        <span className="text-[11px] font-normal opacity-70">{title}</span>
      </div>
      {type === 'image' ? (
        <img src={url} alt={title} className="max-h-64 rounded-md border border-black/10 dark:border-white/10" />
      ) : type === 'video' ? (
        <video src={url} controls className="max-h-64 rounded-md border border-black/10 dark:border-white/10" />
      ) : type === 'model3d' ? (
        <a
          href={artifactViewerUrl(artifact)}
          target="_blank"
          rel="noreferrer"
          className="inline-block rounded bg-emerald-600 px-3 py-1.5 text-[13px] text-white hover:bg-emerald-700"
        >
          打开三维模型
        </a>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-[13px] text-white hover:bg-emerald-700"
        >
          ⬇ 下载 / 打开文件
        </a>
      )}
    </div>
  );
}

// ── 导出 HTML ─────────────────────────────────────────────────────────────────
// 生成一份自包含的 HTML：时间线数据 + 图片（data URL）+ 自带播放器（播放/暂停/
// 速度 1–10×/进度拖动），离线可看，可用任意录屏工具直接录成视频。
type ExportImage = { src: string };
type ExportItem = {
  type: 'message' | 'artifact' | 'session-start';
  sessionTitle: string;
  wall?: string;
  role?: string;
  kind?: string;
  content?: string;
  images?: string[];
  toolImages?: ExportImage[];
  agentName?: string;
  agentRole?: string;
  toolName?: string;
  toolInputJson?: string;
  isError?: boolean;
  fileArtifacts?: Array<{ name?: string; path?: string; operation?: string }>;
  artifact?: { title: string; url: string; embedSrc?: string; mediaType: string };
  codePath?: string;
  codeOp?: 'create' | 'modify';
  codeContent?: string;
  codeEdits?: Array<{ oldString?: string; newString?: string }>;
  startMs: number;
  durationMs: number;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchAsDataUrl(url: string, limitBytes: number): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    if (blob.size > limitBytes) return undefined;
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

async function buildExportItems(items: ReplayItem[]): Promise<ExportItem[]> {
  return Promise.all(
    items.map(async (item): Promise<ExportItem> => {
      const base: ExportItem = {
        type: item.type,
        sessionTitle: item.sessionTitle,
        wall: item.timestamp ? fmtWall(item.timestamp) : undefined,
        startMs: item.startMs,
        durationMs: item.durationMs,
      };
      if (item.type === 'session-start') return base;
      if (item.type === 'artifact' && item.artifact) {
        const art = item.artifact;
        const type = mediaType(art);
        const rawUrl = artifactRawUrl(art);
        const absoluteUrl = new URL(rawUrl, window.location.origin).toString();
        const embedSrc =
          type === 'image' && (art.size == null || (art.size ?? 0) <= EXPORT_EMBED_MAX_BYTES)
            ? await fetchAsDataUrl(absoluteUrl, EXPORT_EMBED_MAX_BYTES)
            : undefined;
        return {
          ...base,
          artifact: {
            title: art.title || art.file_name || art.source_path || '成果',
            url: absoluteUrl,
            embedSrc,
            mediaType: type,
          },
        };
      }
      if (item.type === 'artifact' && item.codeArtifact) {
        // 代码成果：内容来自消息本身，导出文件里离线可看。
        const c = item.codeArtifact;
        return {
          ...base,
          codePath: c.path,
          codeOp: c.operation,
          codeContent: c.content != null ? truncate(c.content, 60_000) : undefined,
          codeEdits: c.edits,
        };
      }
      return {
        ...base,
        role: item.role,
        kind: item.messageKind,
        content: item.content,
        images: item.images && item.images.length > 0 ? item.images : undefined,
        toolImages: item.toolResultImages?.map((img) => ({ src: img.data })),
        agentName: item.agentName,
        agentRole: item.agentRole,
        toolName: item.toolName,
        toolInputJson: item.toolInput != null ? truncate(JSON.stringify(item.toolInput, null, 2), 1200) : undefined,
        isError: item.isError,
        fileArtifacts: item.messageArtifacts,
      };
    }),
  );
}

const EXPORT_PLAYER_JS = String.raw`
(function () {
  'use strict';
  var ITEMS = window.__REPLAY_ITEMS__ || [];
  var TOTAL = window.__REPLAY_TOTAL__ || 0;
  var SPEED = 1, playing = false, playhead = 0, last = 0, raf = null;
  var container = document.getElementById('replay-body');
  var playBtn = document.getElementById('btn-play');
  var speedInput = document.getElementById('speed');
  var speedLabel = document.getElementById('speed-label');
  var seek = document.getElementById('seek');
  var clock = document.getElementById('clock');
  var totalClock = document.getElementById('total-clock');
  var sessionLabel = document.getElementById('session-label');

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); }
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function slice(text, p) { if (p >= 1) return text; return text.slice(0, Math.floor(p * text.length)); }
  function md(src) {
    var text = esc(src);
    var codeBlocks = [];
    // \x60 = 反引号（模板字符串里不能写字面量反引号）。
    var fenceRe = new RegExp('\\x60{3}[a-zA-Z0-9_-]*\\n([\\s\\S]*?)\\x60{3}', 'g');
    text = text.replace(fenceRe, function (_, code) {
      codeBlocks.push('<pre class="md-pre">' + code.replace(/\n$/, '') + '</pre>');
      return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
    });
    text = text
      .replace(/^### (.*)$/gm, '<h4 class="md-h">$1</h4>')
      .replace(/^## (.*)$/gm, '<h3 class="md-h">$1</h3>')
      .replace(/^# (.*)$/gm, '<h2 class="md-h">$1</h2>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(new RegExp('\\x60([^\\x60\\n]+)\\x60', 'g'), '<code class="md-code">$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/^[-*] (.*)$/gm, '<div class="md-li">· $1</div>')
      .replace(/\n/g, '<br>');
    text = text.replace(/\u0000CODE(\d+)\u0000/g, function (_, i) { return codeBlocks[Number(i)] || ''; });
    return text;
  }

  function render(item, p) {
    if (item.type === 'session-start') {
      return '<div class="sess-start">▶ 开始复现对话：' + esc(item.sessionTitle) +
        (item.wall ? ' <span class="wall">' + esc(item.wall) + '</span>' : '') + '</div>';
    }
    if (item.type === 'artifact') {
      if (item.codeContent != null || (item.codeEdits && item.codeEdits.length)) {
        var head = '💻 代码成果 · ' + (item.codeOp === 'create' ? '新建' : '修改') +
          ' <span class="artifact-title">' + esc(item.codePath || '') + '</span>';
        var body = '';
        if (item.codeContent != null) {
          body = '<pre class="code-pre">' + esc(item.codeContent) + '</pre>';
        } else {
          body = (item.codeEdits || []).map(function (e, i) {
            return '<div class="code-edit"><div class="dim">第 ' + (i + 1) + ' 处修改</div>' +
              '<pre class="code-pre old">' + esc(e.oldString || '（空）') + '</pre>' +
              '<div class="code-edit-arrow">↓ 改为</div>' +
              '<pre class="code-pre new">' + esc(e.newString || '（空）') + '</pre></div>';
          }).join('');
        }
        return '<div class="artifact"><div class="artifact-head">' + head + '</div>' + body + '</div>';
      }
      if (item.artifact) {
        var a = item.artifact;
        var media = '';
        if (a.embedSrc) { media = '<img class="art-img" src="' + a.embedSrc + '" alt="">'; }
        else if (a.mediaType === 'video') { media = '<a class="btn" href="' + esc(a.url) + '" target="_blank" rel="noreferrer">▶ 打开视频</a>'; }
        else if (a.mediaType === 'model3d') { media = '<a class="btn" href="' + esc(a.url) + '" target="_blank" rel="noreferrer">打开三维模型</a>'; }
        else { media = '<a class="btn" href="' + esc(a.url) + '" target="_blank" rel="noreferrer">⬇ 下载 / 打开文件</a>'; }
        return '<div class="artifact"><div class="artifact-head">📦 本轮成果演示 <span class="artifact-title">' + esc(a.title) + '</span></div>' + media + '</div>';
      }
      return '';
    }
    var k = item.kind, body, head;
    if (k === 'tool_use') {
      var inputText = item.toolInputJson || '';
      return '<div class="card tool-use"><div class="card-head">🔧 调用工具：' + esc(item.toolName || 'unknown') + '</div>' +
        (inputText ? '<pre class="card-pre">' + esc(slice(inputText, p)) + '</pre>' : '') + '</div>';
    }
    if (k === 'tool_result') {
      var imgs = '';
      if (p >= 1 && item.toolImages && item.toolImages.length) {
        item.toolImages.forEach(function (img) { imgs += '<img class="tool-img" src="' + img.src + '" alt="">'; });
        imgs = '<div class="img-row">' + imgs + '</div>';
      }
      var resultText = (item.content || '').slice(0, 2000);
      return '<div class="card tool-result' + (item.isError ? ' err' : '') + '"><div class="card-head dim">工具返回' + (item.isError ? '（出错）' : '') + '</div>' +
        (resultText ? '<pre class="card-pre">' + esc(slice(resultText, p)) + '</pre>' : '') + imgs + '</div>';
    }
    if (k === 'thinking') {
      var thinkText = item.content || '';
      return '<div class="card thinking"><div class="card-head italic">💭 思考过程</div>' +
        (p >= 1 ? '<div class="md">' + md(thinkText) + '</div>' : '<div class="md raw">' + esc(slice(thinkText, p)) + '</div>') + '</div>';
    }
    if (k === 'file_artifacts') {
      var list = (item.fileArtifacts || []).map(function (f) { return '<div class="md-li">· ' + esc(f.name || f.path || '文件') + (f.operation ? '（' + esc(f.operation) + '）' : '') + '</div>'; }).join('');
      return '<div class="card files"><div class="card-head">📎 交付文件</div>' + list + '</div>';
    }
    if (k === 'text') {
      var isUser = item.role === 'user';
      var who = isUser ? '你' : (item.agentName || '助手') + (item.agentRole ? ' · ' + item.agentRole : '');
      var mainText = item.content || '';
      var userImgs = '';
      if (p >= 1 && isUser && item.images && item.images.length) {
        item.images.forEach(function (src) { userImgs += '<img class="tool-img" src="' + src + '" alt="">'; });
        userImgs = '<div class="img-row">' + userImgs + '</div>';
      }
      return '<div class="bubble-row ' + (isUser ? 'right' : '') + '"><div class="bubble ' + (isUser ? 'user' : 'agent') + '">' +
        '<div class="bubble-who">' + esc(who) + '</div>' +
        (p >= 1 ? '<div class="md">' + md(mainText) + '</div>' : '<div class="md raw">' + esc(slice(mainText, p)) + '</div>') +
        userImgs + '</div></div>';
    }
    // 其余：状态 / 错误 / 子代理进度 / 任务通知 / 完成 / 中断 …
    if (!item.content) return '';
    var icons = { subagent_progress: '🔀', task_notification: '📋', error: '⚠️', interrupted: '✋', compact_boundary: '🗜️', permission_request: '❓', interactive_prompt: '❓' };
    var labels = { subagent_progress: '子代理进度', task_notification: '任务通知', error: '错误', interrupted: '已中断', compact_boundary: '上下文压缩', permission_request: '等待授权', interactive_prompt: '等待用户输入', agent_activity: '执行活动', status: '状态', complete: '完成' };
    var icon = icons[k] || '⚙️';
    var label = labels[k] || '系统';
    var who2 = item.agentName || '系统';
    return '<div class="activity"><span class="act-icon">' + icon + '</span><span><b>' + esc(label) + ' · ' + esc(who2) + '</b>' +
      (item.agentRole ? '<span class="dim">（' + esc(item.agentRole) + '）</span>' : '') +
      '<div class="act-body">' + esc(slice(item.content || '', p).slice(0, 600)) + '</div></span></div>';
  }

  function draw() {
    var html = '';
    var currentSession = '';
    for (var i = 0; i < ITEMS.length; i++) {
      var it = ITEMS[i];
      if (it.startMs > playhead) break;
      if (it.type === 'session-start') currentSession = it.sessionTitle;
      var p = Math.min(1, (playhead - it.startMs) / Math.max(1, it.durationMs));
      var piece = render(it, p);
      if (piece) html += piece;
    }
    container.innerHTML = html;
    if (sessionLabel) sessionLabel.textContent = currentSession || '';
    if (clock) clock.textContent = fmt(playhead);
    if (seek) seek.value = String(Math.round(playhead));
    if (window.innerWidth) container.parentElement.scrollTop = container.parentElement.scrollHeight;
  }

  function tick(now) {
    if (!playing) { raf = null; return; }
    var delta = now - last; last = now;
    var target = playhead + delta * SPEED;
    // 逐份查看模式（用过上一步/下一步后）：成果一出现就暂停，交给用户手动查看；
    // 点「播放」或「下一步」继续。
    if (stepped) {
      for (var q = 0; q < artStops.length; q++) {
        if (artStops[q] > playhead && artStops[q] <= target) {
          target = artStops[q] + 30;
          playing = false;
          break;
        }
      }
    }
    playhead = target;
    if (playhead >= TOTAL) { playhead = TOTAL; playing = false; }
    setPlayBtn();
    draw();
    if (playing) raf = requestAnimationFrame(tick);
    else raf = null;
  }
  function setPlayBtn() {
    if (playBtn) playBtn.textContent = playing ? '暂停' : (playhead >= TOTAL ? '重播' : '播放');
  }
  if (playBtn) playBtn.addEventListener('click', function () {
    if (!playing && playhead >= TOTAL && TOTAL > 0) playhead = 0;
    playing = !playing;
    if (playing) { last = performance.now(); if (!raf) raf = requestAnimationFrame(tick); }
    setPlayBtn();
  });
  var restartBtn = document.getElementById('btn-restart');
  if (restartBtn) restartBtn.addEventListener('click', function () {
    // 从头连续播放：成果演示节奏自动控制，不在成果处暂停。
    stepped = false;
    playhead = 0; draw(); if (playBtn) setPlayBtn();
  });

  // 步进锚点：两类值得停下的位置——每份成果演示的起点（跳过去＝该成果完整出现）
  // 和每轮用户输入完整显示的时刻。用步进即进入逐份查看模式。
  var anchors = [];
  for (var si = 0; si < ITEMS.length; si++) {
    var sit = ITEMS[si];
    if (sit.type === 'artifact') anchors.push(sit.startMs + 60);
    else if (sit.type === 'message' && sit.role === 'user' && sit.kind === 'text') anchors.push(sit.startMs + (sit.durationMs || 600) + 60);
  }
  var artStops = [];
  for (var qi = 0; qi < ITEMS.length; qi++) {
    if (ITEMS[qi].type === 'artifact') artStops.push(ITEMS[qi].startMs);
  }
  var stepped = false;
  var STEP_EPS = 100;
  var prevBtn = document.getElementById('btn-prev');
  if (prevBtn) prevBtn.addEventListener('click', function () {
    playing = false; stepped = true; setPlayBtn();
    var target = null;
    for (var i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i] < playhead - STEP_EPS) { target = anchors[i]; break; }
    }
    playhead = target == null ? 0 : target;
    draw();
  });
  var nextBtn = document.getElementById('btn-next');
  if (nextBtn) nextBtn.addEventListener('click', function () {
    playing = false; stepped = true; setPlayBtn();
    var target = null;
    for (var j = 0; j < anchors.length; j++) {
      if (anchors[j] > playhead + STEP_EPS) { target = anchors[j]; break; }
    }
    playhead = target == null ? TOTAL : target;
    draw();
  });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); if (playBtn) playBtn.click(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (prevBtn) prevBtn.click(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); if (nextBtn) nextBtn.click(); }
  });
  if (speedInput) speedInput.addEventListener('input', function () {
    SPEED = Number(speedInput.value);
    if (speedLabel) speedLabel.textContent = SPEED + '×';
  });
  if (seek) seek.addEventListener('input', function () {
    playhead = clampNum(Number(seek.value), 0, TOTAL);
    draw();
  });
  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  if (totalClock) totalClock.textContent = fmt(TOTAL);
  draw();
})();
`;

function buildExportHtml(title: string, exportItems: ExportItem[], totalMs: number): string {
  const safeTitle = escapeHtml(title);
  // 内嵌数据：转义 <、>、&，防止内容里出现 </script> 截断脚本。
  const dataJson = JSON.stringify(exportItems)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务复现 · ${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f7f7f8; color: #171717; }
  .toolbar { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e5e5; }
  .toolbar .title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: #059669; min-width: 0; }
  .toolbar .title .name { color: #171717; }
  .toolbar .spacer { flex: 1; }
  .btn { display: inline-block; border: 0; border-radius: 8px; padding: 7px 14px; font-size: 13px; background: #059669; color: #fff; cursor: pointer; text-decoration: none; }
  .btn.ghost { background: #f0f0f0; color: #444; }
  .speed { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #444; }
  .speed-label { min-width: 34px; font-weight: 600; text-align: right; }
  .progress { display: flex; align-items: center; gap: 10px; padding: 6px 16px; background: #fff; border-bottom: 1px solid #e5e5e5; }
  .progress .clock { font-variant-numeric: tabular-nums; font-size: 12px; color: #888; min-width: 40px; }
  .progress input[type=range] { flex: 1; accent-color: #059669; }
  .stage { position: fixed; left: 0; right: 0; top: 106px; bottom: 0; overflow-y: auto; padding: 16px; }
  .stream { max-width: 760px; margin: 0 auto; }
  .sess-start { margin: 18px 0; font-size: 13px; font-weight: 600; color: #666; display: flex; gap: 8px; align-items: center; }
  .sess-start .wall { font-size: 11px; opacity: .6; font-weight: 400; }
  .bubble-row { display: flex; margin: 8px 0; }
  .bubble-row.right { justify-content: flex-end; }
  .bubble { max-width: 86%; border-radius: 16px; padding: 8px 14px; font-size: 14px; line-height: 1.6; }
  .bubble.user { background: #2563eb; color: #fff; }
  .bubble.agent { background: #f2f2f3; color: #171717; }
  .bubble-who { font-size: 11px; font-weight: 500; opacity: .6; margin-bottom: 2px; }
  .card { max-width: 90%; margin: 8px 0; border-radius: 10px; padding: 8px 12px; font-size: 13px; }
  .card.tool-use { border: 1px solid #fcd34d; background: #fffbeb; color: #78350f; }
  .card.tool-result { border: 1px solid #d4d4d4; background: #fafafa; color: #404040; }
  .card.tool-result.err { border-color: #fca5a5; background: #fef2f2; }
  .card.thinking { border: 1px dashed #d4d4d4; color: #737373; }
  .card.files { border: 1px solid #7dd3fc; background: #f0f9ff; color: #075985; }
  .card-head { font-weight: 600; margin-bottom: 4px; }
  .card-head.dim { color: #8a8a8a; font-weight: 500; }
  .card-head.italic { font-style: italic; font-weight: 400; font-size: 12px; }
  .card-pre { max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Consolas, monospace; font-size: 12px; opacity: .9; margin: 0; }
  .artifact { margin: 12px 0; border: 1px solid #6ee7b7; background: #ecfdf5; border-radius: 10px; padding: 12px; }
  .artifact-head { font-size: 13px; font-weight: 600; color: #065f46; margin-bottom: 6px; }
  .artifact-title { font-weight: 400; font-size: 11px; opacity: .7; }
  .code-pre { max-height: 360px; overflow: auto; white-space: pre; background: #101613; color: #d6e5dd; border-radius: 8px; padding: 12px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.55; margin: 0; }
  .code-pre.old { background: #fef2f2; color: #8c4a4a; }
  .code-pre.new { background: #f0fdf4; color: #166534; }
  .code-edit { margin: 8px 0; }
  .code-edit-arrow { font-size: 11px; color: #9a9a9a; margin: 2px 0; }
  .art-img { max-height: 260px; border-radius: 6px; border: 1px solid rgba(0,0,0,.1); }
  .img-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .tool-img { max-height: 230px; border-radius: 6px; border: 1px solid rgba(0,0,0,.1); }
  .activity { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0; background: #f0f0f1; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; color: #525252; max-width: 92%; }
  .activity b { color: #404040; }
  .act-body { white-space: pre-wrap; word-break: break-word; margin-top: 2px; opacity: .9; }
  .dim { color: #9a9a9a; }
  .md { font-size: 14px; }
  .md.raw { white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .md-h { margin: 6px 0 2px; font-weight: 700; }
  .md-code { background: rgba(0,0,0,.07); border-radius: 4px; padding: 1px 5px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  .md-pre { background: #f4f4f5; border-radius: 8px; padding: 10px; overflow: auto; max-height: 300px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  .md-li { margin: 1px 0; }
  .footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 6px; text-align: center; font-size: 12px; color: #9a9a9a; background: #fff; border-top: 1px solid #e5e5e5; }
  .hint { padding: 8px 16px; font-size: 12px; color: #8a8a8a; background: #fff; border-bottom: 1px solid #e5e5e5; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="title">↺ 任务复现 <span class="name" id="doc-title">${safeTitle}</span></span>
    <span class="spacer"></span>
    <button class="btn ghost" id="btn-restart" title="从头重放（连续播放，成果演示自动控制）">⟲ 重放</button>
    <button class="btn ghost" id="btn-prev" title="上一步：回到上一份成果或上一次用户输入；之后播放会在每份成果处暂停（←）">⏮ 上一步</button>
    <button class="btn ghost" id="btn-next" title="下一步：逐份前进——本轮成果一份一份演示，演示完跳到下一轮输入（→）">⏭ 下一步</button>
    <button class="btn" id="btn-play">播放</button>
    <label class="speed">速度
      <input type="range" id="speed" min="1" max="10" step="0.5" value="1">
      <span class="speed-label" id="speed-label">1×</span>
    </label>
  </div>
  <div class="progress">
    <span class="clock" id="clock">00:00</span>
    <input type="range" id="seek" min="0" max="${Math.round(totalMs)}" step="50" value="0">
    <span class="clock" id="total-clock">--:--</span>
  </div>
  <div class="hint">当前对话：<span id="session-label"></span> · 空格 = 播放/暂停，← → = 上一步/下一步（回到上一份成果或上一次输入 / 逐份成果演示前进）。每轮对话完成后自动演示本轮成果；用过上一步后播放会在每份成果处暂停。本文件离线自包含，可用任意录屏工具直接录成视频。</div>
  <div class="stage"><div class="stream" id="replay-body"></div></div>
  <div class="footer">由 PilotV 任务复现导出</div>
  <script>
    window.__REPLAY_ITEMS__ = ${dataJson};
    window.__REPLAY_TOTAL__ = ${Math.round(totalMs)};
  </script>
  <script>${EXPORT_PLAYER_JS}</script>
</body>
</html>`;
}

// ── 成果展示台（复用成果台 ArtifactStage：三维旋转/缩放、网页滚动、图片缩放；
// 代码成果用自带代码面板：可滚动、字号缩放）────────────────────────────────
const noop = (): void => undefined;

// 代码成果演示面板：滚动查看 + 字号缩放；无全量内容时展示编辑片段（old → new）。
const CodeStage = memo(function CodeStage({ code }: { code: CodeArtifact }) {
  const [fontSize, setFontSize] = useState(13);
  const content = code.content;
  const truncated = content != null && content.length > CODE_DEMO_MAX_CHARS;
  const shown = content != null ? content.slice(0, CODE_DEMO_MAX_CHARS) : null;
  const lines = content != null ? content.split('\n') : [];
  const kb = content != null ? (content.length / 1024).toFixed(1) : '';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-[12px]">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px] font-medium',
            code.operation === 'create'
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
          )}
        >
          {code.operation === 'create' ? '新建文件' : '修改文件'}
        </span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-neutral-700 dark:text-neutral-200" title={code.path}>
          {code.path}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-400">{codeLanguage(code.path)}</span>
        {lines.length > 0 ? (
          <span className="shrink-0 tabular-nums text-[11px] text-neutral-400">
            {lines.length} 行{kb ? ` · ${kb} KB` : ''}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setFontSize((v) => Math.max(10, v - 1))}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            title="缩小字号"
          >
            A−
          </button>
          <button
            type="button"
            onClick={() => setFontSize((v) => Math.min(22, v + 1))}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            title="放大字号"
          >
            A+
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-neutral-50 p-3 dark:bg-neutral-900/60">
        {shown != null ? (
          <pre
            className="font-mono leading-relaxed text-neutral-800 dark:text-neutral-200"
            style={{ fontSize: `${fontSize}px` }}
          >
            {shown}
          </pre>
        ) : code.edits && code.edits.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
              本轮编辑片段（无全量内容）· {code.edits.length} 处修改
            </div>
            {code.edits.map((e, i) => (
              <div key={i} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
                <div className="mb-1 text-[11px] text-neutral-400">第 {i + 1} 处</div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 font-mono text-[11.5px] text-red-900/80 dark:bg-red-950/30 dark:text-red-200/80">
                  {e.oldString || '（空）'}
                </pre>
                <div className="my-1 text-center text-[10px] text-neutral-400">↓ 改为</div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-emerald-50 p-2 font-mono text-[11.5px] text-emerald-900/80 dark:bg-emerald-950/30 dark:text-emerald-200/80">
                  {e.newString || '（空）'}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[13px] text-neutral-400">（本轮编辑片段未含内容）</div>
        )}
        {truncated ? (
          <div className="mt-2 text-[11px] text-neutral-400">
            （内容较长已截断：显示前 {CODE_DEMO_MAX_CHARS} 字符）
          </div>
        ) : null}
      </div>
    </div>
  );
});

// memo：播放头逐帧推进时主组件高频重渲，成果台只随「当前成果」变化重渲，
// 否则 model-viewer / iframe 会被无意义地重排。
const DemoStage = memo(function DemoStage({
  demo,
  demoIndex,
  demoTotal,
  onJump,
}: {
  demo: ReplayItem | null;
  demoIndex: number;
  demoTotal: number;
  onJump: (delta: number) => void;
}) {
  const navigation: ReactNode = demo ? (
    <>
      <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
      <button
        type="button"
        onClick={() => onJump(-1)}
        disabled={demoIndex <= 0}
        title="上一份成果（跳到它在时间线上出现的位置）"
        className="min-h-9 rounded-full border border-transparent px-2.5 text-xs hover:bg-muted disabled:opacity-40"
      >
        ‹ 上一份
      </button>
      <span className="flex min-h-9 items-center text-xs tabular-nums text-muted-foreground">
        {demoIndex + 1} / {demoTotal}
      </span>
      <button
        type="button"
        onClick={() => onJump(1)}
        disabled={demoIndex >= demoTotal - 1}
        title="下一份成果（跳到它在时间线上出现的位置）"
        className="min-h-9 rounded-full border border-transparent px-2.5 text-xs hover:bg-muted disabled:opacity-40"
      >
        下一份 ›
      </button>
    </>
  ) : null;
  if (!demo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-neutral-400 dark:text-neutral-500">
        <Monitor className="h-6 w-6" />
        <span className="text-[13px]">当前会话尚无成果演示</span>
        <span className="max-w-[280px] text-[12px] leading-relaxed">
          播放到成果出现时会自动展示：三维可旋转缩放、网页可滚动缩放、代码可滚动查看
        </span>
      </div>
    );
  }
  if (demo.codeArtifact && !demo.artifact) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 pl-2">{navigation}</div>
        <div className="min-h-0 flex-1">
          <CodeStage code={demo.codeArtifact} />
        </div>
      </div>
    );
  }
  return (
    <ArtifactStage
      artifact={demo.artifact!}
      annotations={[]}
      draft={null}
      activeNoteId={null}
      draftBody=""
      draftError=""
      onDraft={noop}
      onDraftBody={noop}
      onSaveDraft={noop}
      onCancelDraft={noop}
      onPickNote={noop}
      onSendInk={noop}
      navigation={navigation}
    />
  );
});

// ── 主组件 ────────────────────────────────────────────────────────────────────
type ReplayViewProps = {
  sessionId?: string;
  projectName?: string;
  projects?: Project[];
};

export default function ReplayView({ sessionId, projectName, projects }: ReplayViewProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // 单对话复现时，projectName 可能来自路由 query（侧栏已带上），用来定位 transcript。
  const effectiveProjectName = projectName || searchParams.get('project') || undefined;
  // 历史接口要 projectPath（项目完整路径）才能定位 transcript；从项目列表里找。
  const effectiveProjectPath = useMemo(() => {
    if (!effectiveProjectName) return undefined;
    const proj = projects?.find((p) => p.name === effectiveProjectName);
    return proj?.fullPath || proj?.path || undefined;
  }, [effectiveProjectName, projects]);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<ReplayItem[]>([]);
  const [totalMs, setTotalMs] = useState(0);
  const [exporting, setExporting] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [playhead, setPlayhead] = useState(0);
  // 成果展示台面板（右侧）是否展开。
  const [stageOpen, setStageOpen] = useState(true);
  // 成果演示视图：工具条「成果」按钮切换。true = 主区全幅展示「当前进度」的
  // 成果演示（与播放头同步推进）；再点切回会话复现视图（内容同样与进度同步）。
  const [demoView, setDemoView] = useState(false);
  // 逐份查看模式：用过上一步/下一步/成果台翻页后置真。此模式下播放会在
  // 每份成果上成果台的时刻暂停，交给用户手动查看；「从头重放」恢复连续模式。
  const [stepped, setStepped] = useState(false);

  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const steppedRef = useRef(stepped);
  useEffect(() => {
    steppedRef.current = stepped;
  }, [stepped]);

  const playheadRef = useRef(playhead);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 标题：项目复现用项目显示名
  const projectTitle = useMemo(() => {
    if (!projectName) return projectName;
    const proj = projects?.find((p) => p.name === projectName);
    return proj ? projectDisplayName(proj) : projectName;
  }, [projectName, projects]);

  // 加载数据并建时间线
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        setStatus('loading');
        setItems([]);
        setPlayhead(0);
        let sessions: ReplaySessionData[] = [];
        if (sessionId) {
          // 单对话：先拿项目会话列表（补标题 + background_task 等定位参数），再拉消息。
          let info: ReplaySessionInfo = { id: sessionId, title: sessionId };
          if (effectiveProjectName) {
            const list = await fetchProjectSessions(effectiveProjectName, controller.signal).catch(
              () => [] as ReplaySessionInfo[],
            );
            const hit = list.find((s) => s.id === sessionId);
            if (hit) info = hit;
          }
          const [messages, artifacts] = await Promise.all([
            fetchSessionMessages(info, effectiveProjectName, effectiveProjectPath, controller.signal),
            loadSessionArtifacts(sessionId, controller.signal).catch(() => [] as Artifact[]),
          ]);
          sessions = [{ id: sessionId, title: info.title, messages, artifacts }];
        } else if (projectName) {
          const list = await fetchProjectSessions(projectName, controller.signal);
          sessions = await Promise.all(
            list.map(async (s) => {
              const [messages, artifacts] = await Promise.all([
                fetchSessionMessages(s, projectName, effectiveProjectPath, controller.signal).catch(
                  () => [] as ReplayMessage[],
                ),
                loadSessionArtifacts(s.id, controller.signal).catch(() => [] as Artifact[]),
              ]);
              return { id: s.id, title: s.title, messages, artifacts };
            }),
          );
        }
        if (cancelled) return;
        const built = buildTimeline(sessions);
        const last = built[built.length - 1];
        const total = last ? last.startMs + last.durationMs : 0;
        setTitle(sessionId ? (sessions[0]?.title || sessionId) : (projectTitle || projectName || '项目'));
        setItems(built);
        setTotalMs(total);
        setStatus('ready');
      } catch (err) {
        if (cancelled || (err as { name?: string })?.name === 'AbortError') return;
        setErrorMsg((err as Error).message || '加载失败');
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, projectName, projectTitle, effectiveProjectName, effectiveProjectPath]);

  // ── 成果相关 ────────────────────────────────────────────────────────────
  // 成果演示项（成果台交付物 + 写/改的代码文件），按时间线顺序。
  const demoItems = useMemo(
    () => items.filter((it) => it.type === 'artifact' && (it.artifact || it.codeArtifact)),
    [items],
  );
  const hasDemos = demoItems.length > 0;

  // 播放头所在时刻应演示哪份成果：最近一份已开始的演示项
  // （成果会一直留在台上，直到下一份演示项替换它）。
  const currentDemoIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < demoItems.length; i++) {
      if (demoItems[i].startMs <= playhead) index = i;
    }
    return index;
  }, [demoItems, playhead]);
  const currentDemo = currentDemoIndex >= 0 ? demoItems[currentDemoIndex] : null;
  const currentDemoTitle = currentDemo
    ? currentDemo.codeArtifact && !currentDemo.artifact
      ? basename(currentDemo.codeArtifact.path)
      : currentDemo.artifact!.title || currentDemo.artifact!.file_name || currentDemo.artifact!.source_path || '成果'
    : '';

  // 逐份查看模式的自动暂停点：每份成果上成果台的时刻。
  const artifactStopRef = useRef<number[]>([]);
  useEffect(() => {
    artifactStopRef.current = demoItems.map((it) => it.startMs);
  }, [demoItems]);

  // 成果台翻页：跳到相邻成果在时间线上出现的位置，并保持逐份查看模式。
  const jumpArtifact = useCallback((delta: number) => {
    if (demoItems.length === 0) return;
    setPlaying(false);
    setStepped(true);
    let last = -1;
    const ph = playheadRef.current;
    for (let i = 0; i < demoItems.length; i++) {
      if (demoItems[i].startMs <= ph) last = i;
    }
    const targetIdx = clamp((last === -1 ? 0 : last) + delta, 0, demoItems.length - 1);
    setPlayhead(demoItems[targetIdx].startMs + 60);
  }, [demoItems]);

  // 播放时钟
  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;
      setPlayhead((prev) => {
        let next = prev + delta * speedRef.current;
        // 逐份查看模式：成果一上成果展示台就暂停，交给用户手动查看
        //（三维旋转缩放 / 网页滚动缩放）；点「播放」或「下一步」继续。
        if (steppedRef.current) {
          for (const sp of artifactStopRef.current) {
            if (sp > prev && sp <= next) {
              setPlaying(false);
              return sp + 30;
            }
          }
        }
        if (next >= totalMs) {
          setPlaying(false);
          return totalMs;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, totalMs]);

  // 播放时自动滚到底部（仅会话视图；成果演示视图不滚动对话流）
  useEffect(() => {
    if (playing && !demoView && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [playhead, playing, demoView]);

  const togglePlay = useCallback(() => {
    setPlaying((prev) => {
      if (!prev && playhead >= totalMs && totalMs > 0) {
        setPlayhead(0); // 播完后再按播放 → 从头来
      }
      return !prev;
    });
  }, [playhead, totalMs]);

  const restart = useCallback(() => {
    // 从头连续播放：成果演示节奏自动控制（每份 ARTIFACT_DEMO_MS），不在成果处暂停。
    setStepped(false);
    setPlaying(false);
    setPlayhead(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, []);

  // ── 步进 ────────────────────────────────────────────────────────────────
  // 锚点＝两类「值得停下来的位置」（跨会话全局有序）：
  //   · 每份成果演示的起点 —— 跳到这里＝本轮对话完整回放完、该成果出现在成果台上；
  //   · 每轮用户输入完整显示的时刻（startMs + durationMs + 60）—— 跳到这里＝
  //     能直接看到那条请求。用步进即进入逐份查看模式。
  const stepAnchors = useMemo(() => {
    const targets: number[] = [];
    for (const it of items) {
      if (it.type === 'artifact') {
        targets.push(it.startMs + 60);
      } else if (it.type === 'message' && it.role === 'user' && it.messageKind === 'text') {
        targets.push(it.startMs + it.durationMs + 60);
      }
    }
    return targets;
  }, [items]);

  const STEP_EPS = 100;

  // 上一步：回到最近一个锚点（上一份成果上成果台的位置，或上一次用户输入
  // 完整显示的位置）；之后点「播放」即复现该成果 / 该请求到当前位置的全过程。
  const stepPrev = useCallback(() => {
    setPlaying(false);
    setStepped(true);
    let target: number | undefined;
    for (let i = stepAnchors.length - 1; i >= 0; i--) {
      if (stepAnchors[i] < playhead - STEP_EPS) {
        target = stepAnchors[i];
        break;
      }
    }
    setPlayhead(target ?? 0);
  }, [playhead, stepAnchors]);

  // 下一步：跳到下一个锚点——本轮成果逐份演示（每按一次前进一份），本轮成果
  // 全部演示完则跳到下一轮用户输入；没有更多锚点则到时间线终点展示最终成果。
  const stepNext = useCallback(() => {
    setPlaying(false);
    setStepped(true);
    let target: number | undefined;
    for (let i = 0; i < stepAnchors.length; i++) {
      if (stepAnchors[i] > playhead + STEP_EPS) {
        target = stepAnchors[i];
        break;
      }
    }
    setPlayhead(target ?? totalMs);
  }, [playhead, stepAnchors, totalMs]);

  // 当前轮次（供工具条显示）
  const turnIndicator = useMemo(() => {
    if (items.length === 0) return '';
    const currentSession = [...items]
      .reverse()
      .find((it) => it.type === 'session-start' && it.startMs <= playhead);
    if (!currentSession) return '';
    const turnsInSession = items.filter(
      (it) => it.sessionId === currentSession.sessionId && it.type === 'message'
        && it.role === 'user' && it.messageKind === 'text',
    );
    if (turnsInSession.length === 0) return '';
    const current = turnsInSession.filter((it) => it.startMs <= playhead).length;
    return `第 ${Math.max(1, current)} / ${turnsInSession.length} 轮`;
  }, [items, playhead]);

  // 键盘：← / → 步进（焦点在输入控件上时不接管）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stepPrev, stepNext]);

  const onSeek = useCallback((value: number) => {
    setPlaying(false);
    setPlayhead(clamp(value, 0, totalMs));
  }, [totalMs]);

  // 导出为自包含 HTML（含自带播放器，可离线观看 / 录屏成视频）
  const handleExport = useCallback(async () => {
    if (items.length === 0 || exporting) return;
    setExporting(true);
    try {
      const exportItems = await buildExportItems(items);
      // 单文件里成果图片以 data URL 内嵌，其余给绝对链接。
      const html = buildExportHtml(title, exportItems, totalMs);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      a.href = url;
      a.download = `任务复现-${title}-${stamp}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setExporting(false);
    }
  }, [items, title, totalMs, exporting]);

  // 当前正在复现的对话名（项目复现时用于顶部提示）
  const currentSessionTitle = useMemo(() => {
    let name = title;
    for (const it of items) {
      if (it.type === 'session-start' && it.startMs <= playhead) name = it.sessionTitle;
    }
    return name;
  }, [items, playhead, title]);

  const visibleItems = useMemo(
    () => items.filter((it) => it.startMs <= playhead),
    [items, playhead],
  );

  const hasConversation = useMemo(
    () => items.some((it) => it.type === 'message'),
    [items],
  );

  if (status === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500 dark:text-neutral-400">
        <History className="h-8 w-8 animate-pulse" />
        <span>正在载入对话与成果…</span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-red-600 dark:text-red-400">载入失败</span>
        <span className="text-[13px] text-neutral-500 dark:text-neutral-400">{errorMsg}</span>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded bg-neutral-200 px-3 py-1.5 text-[13px] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
        >
          返回
        </button>
      </div>
    );
  }

  if (items.length === 0 || !hasConversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-neutral-500 dark:text-neutral-400">
        <span>没有可复现的对话内容</span>
        <span className="max-w-md text-[12px] text-neutral-400 dark:text-neutral-500">
          这条对话没有读到历史消息。若对话确实存在，请确认右键的是聊天里正在用的那个项目下的对话。
        </span>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded bg-neutral-200 px-3 py-1.5 text-[13px] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
        >
          返回
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      {/* 顶部工具条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          title="返回"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
            任务复现 · {currentSessionTitle}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={restart}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            title="从头重放"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={stepPrev}
            className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-[13px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            title="上一步：回到上一份成果上成果台的位置，或上一次用户输入并显示该请求；之后播放会在每份成果处暂停供手动查看（键盘 ←）"
          >
            <SkipBack className="h-4 w-4" />
            上一步
          </button>
          <button
            type="button"
            onClick={stepNext}
            className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-[13px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            title="下一步：逐份前进——本轮成果一份一份演示，演示完跳到下一轮用户输入；没有更多则到终点（键盘 →）"
          >
            <SkipForward className="h-4 w-4" />
            下一步
          </button>
          {turnIndicator ? (
            <span className="tabular-nums text-[12px] text-neutral-400 dark:text-neutral-500">{turnIndicator}</span>
          ) : null}
          <button
            type="button"
            onClick={() => setDemoView((v) => !v)}
            aria-pressed={demoView}
            className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[13px] ${
              demoView
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300'
                : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800'
            }`}
            title={demoView ? '返回会话复现视图（内容与当前进度同步）' : '切换到当前进度的成果演示（与播放进度同步；再点返回会话）'}
          >
            <Package className="h-4 w-4" />
            成果
          </button>
          {!demoView && hasDemos ? (
            <button
              type="button"
              onClick={() => setStageOpen((v) => !v)}
              aria-pressed={stageOpen}
              className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[13px] ${
                stageOpen
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300'
                  : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800'
              }`}
              title={stageOpen ? '收起成果展示台（成果改在对话流中展示）' : '展开成果展示台（三维可旋转缩放、网页可滚动、代码可滚动）'}
            >
              <Monitor className="h-4 w-4" />
              成果台
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[13px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300"
            title="导出为自包含 HTML（离线可看，可录屏成视频）"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {exporting ? '导出中…' : '导出 HTML'}
          </button>
          <button
            type="button"
            onClick={togglePlay}
            className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-700"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {playing ? '暂停' : playhead >= totalMs ? '重播' : '播放'}
          </button>

          {/* 速度调节：1× 正常流式 → 10× 快进 */}
          <label className="flex items-center gap-2 text-[12px] text-neutral-600 dark:text-neutral-300">
            <span className="whitespace-nowrap">速度</span>
            <input
              type="range"
              min={MIN_SPEED}
              max={MAX_SPEED}
              step={0.5}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-28 accent-emerald-600"
            />
            <span className="w-9 tabular-nums font-medium">{speed.toFixed(speed % 1 === 0 ? 0 : 1)}×</span>
          </label>
        </div>
      </div>

      {/* 进度条 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-neutral-200 px-4 py-1.5 dark:border-neutral-800">
        <span className="tabular-nums text-[12px] text-neutral-500 dark:text-neutral-400">{fmtClock(playhead)}</span>
        <input
          type="range"
          min={0}
          max={totalMs}
          step={50}
          value={playhead}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="w-full accent-emerald-600"
        />
        <span className="tabular-nums text-[12px] text-neutral-500 dark:text-neutral-400">{fmtClock(totalMs)}</span>
      </div>

      {/* 复现内容：成果演示视图（全幅，与进度同步）｜会话视图（对话流 + 右侧成果台） */}
      <div className="flex min-h-0 flex-1">
        {demoView ? (
          // 成果演示视图：全幅展示当前进度对应的成果演示；播放推进时自动同步。
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-[12px] dark:border-neutral-900">
              <Package className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">成果演示</span>
              {currentDemo ? (
                <span className="min-w-0 truncate text-neutral-500 dark:text-neutral-400" title={currentDemoTitle}>
                  {currentDemo.codeArtifact && !currentDemo.artifact ? '💻 ' : '📦 '}
                  {currentDemoTitle}
                </span>
              ) : (
                <span className="text-neutral-400 dark:text-neutral-500">当前会话尚无成果演示</span>
              )}
              <span className="ml-auto shrink-0 text-[11px] text-neutral-400 dark:text-neutral-500">
                演示内容随播放进度自动切换
              </span>
            </div>
            <div className="min-h-0 flex-1 p-1">
              <DemoStage demo={currentDemo} demoIndex={currentDemoIndex} demoTotal={demoItems.length} onJump={jumpArtifact} />
            </div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="mx-auto max-w-3xl">
                {visibleItems.map((item) => {
                  const progress = clamp((playhead - item.startMs) / item.durationMs, 0, 1);
                  return <ReplayRow key={item.id} item={item} progress={progress} stageOpen={stageOpen} />;
                })}
                {playhead >= totalMs ? (
                  <div className="my-6 text-center text-[13px] text-neutral-400 dark:text-neutral-500">
                    — 复现结束 · 全过程已展示完毕 —
                  </div>
                ) : null}
              </div>
            </div>

            {stageOpen && hasDemos ? (
              <aside className="flex w-[46%] min-w-[340px] max-w-[820px] shrink-0 flex-col border-l border-neutral-200 dark:border-neutral-800">
                <div className="flex shrink-0 items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-[12px] dark:border-neutral-900">
                  <Monitor className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">成果展示台</span>
                  {currentDemo ? (
                    <span className="min-w-0 truncate text-neutral-500 dark:text-neutral-400" title={currentDemoTitle}>
                      {currentDemoTitle}
                    </span>
                  ) : (
                    <span className="text-neutral-400 dark:text-neutral-500">等待本轮成果…</span>
                  )}
                </div>
                <div className="flex min-h-0 flex-1 flex-col p-1">
                  <DemoStage demo={currentDemo} demoIndex={currentDemoIndex} demoTotal={demoItems.length} onJump={jumpArtifact} />
                </div>
              </aside>
            ) : null}
          </>
        )}
      </div>

      {/* 底部提示 */}
      <div className="shrink-0 border-t border-neutral-200 px-4 py-1.5 text-center text-[12px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
        1× 为正常流式输出速度，最高 10× 快进。每轮对话完成后自动进入成果演示（成果台交付物＋本轮写/改的代码文件）；「成果」按钮切换成果演示视图（与进度同步，当前无成果会提示）。用「上一步」后播放会在每份成果处停下，供手动查看（三维旋转缩放 / 网页滚动 / 代码滚动）后再继续。可用系统录屏记录；也可「导出 HTML」离线回看。
      </div>
    </div>
  );
}
