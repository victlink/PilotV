import { useEffect, useRef, useState } from 'react';
import { useOptionalWebSocket } from '../../contexts/WebSocketContext';

export type TaskPhase = 'idle' | 'starting' | 'working' | 'waiting' | 'compacting' | 'retrying' | 'finished';

export type TaskProgress = {
  phase: TaskPhase;
  turnStartedAt?: number;
  toolsCompleted: number;
  contextRatio?: number;
  contextUsed?: number;
  contextTotal?: number;
};

export type TaskProgressBySession = Record<string, TaskProgress>;

type InternalProgress = TaskProgress & { runId?: string; completedToolIds: string[]; pendingRequestIds: string[] };

function budgetFields(budget: any): Pick<TaskProgress, 'contextRatio' | 'contextUsed' | 'contextTotal'> | null {
  if (!budget || typeof budget !== 'object' || budget.unknown === true) return null;
  const used = budget.used;
  const total = budget.total;
  const ratio = budget.ratio;
  const contextRatio = typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
    ? ratio : undefined;
  const contextUsed = typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : undefined;
  const contextTotal = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : undefined;
  if (contextRatio === undefined && (contextUsed === undefined || contextTotal === undefined)) return null;
  return { contextRatio, contextUsed, contextTotal };
}

export function useTaskProgress(): TaskProgressBySession {
  const { subscribe } = useOptionalWebSocket();
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const [state, setState] = useState<Record<string, InternalProgress>>({});
  const seenStarts = useRef(new Set<string>());

  useEffect(() => subscribeRef.current((message: any) => {
    const sessionId = message?.sessionId;
    const kind = message?.kind;
    if (typeof sessionId !== 'string' || !sessionId || typeof kind !== 'string') return;
    if (kind === 'text' && message.role === 'user') return;
    const start = kind === 'status' && message.text === 'started';
    const startIdentity = message.runId || message.id || message.timestamp;
    if (start && startIdentity) {
      const key = `${sessionId}:${startIdentity}`;
      if (seenStarts.current.has(key)) return;
      seenStarts.current.add(key);
    }
    const budget = (kind === 'status' && message.text === 'token_budget') || kind === 'compact_boundary'
      ? budgetFields(message.tokenBudget)
      : null;
    if (!start && !budget && kind !== 'tool_result' && kind !== 'tool_use' &&
      kind !== 'permission_request' && kind !== 'permission_cancelled' &&
      kind !== 'complete' && kind !== 'error' && kind !== 'compact_boundary' &&
      kind !== 'stream_delta' && kind !== 'text' && kind !== 'thinking' && kind !== 'stream_end' &&
      !(kind === 'status' && (message.text === 'model_request_started' ||
        message.text === 'compacting' || message.retryProgress))) return;

    setState(previous => {
      const current = previous[sessionId] ?? { phase: 'idle', toolsCompleted: 0, completedToolIds: [], pendingRequestIds: [] };
      const runId = typeof message.runId === 'string' && message.runId ? message.runId : undefined;
      if (runId && current.runId && runId !== current.runId && !start) return previous;
      if (start) {
        if (runId && current.runId === runId) return previous;
        if (!startIdentity && current.phase !== 'idle') return previous;
        const timestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
        const next: InternalProgress = {
          contextRatio: current.contextRatio,
          contextUsed: current.contextUsed,
          contextTotal: current.contextTotal,
          phase: 'starting',
          turnStartedAt: Number.isFinite(timestamp) ? timestamp : undefined,
          toolsCompleted: 0,
          completedToolIds: [],
          pendingRequestIds: [],
          runId,
        };
        return { ...previous, [sessionId]: next };
      }
      if (current.phase === 'finished') return previous;
      let next: InternalProgress = budget ? { ...current, ...budget } : current;
      if (kind === 'complete' || (kind === 'error' && message.terminal === true)) {
        next = { ...next, phase: 'finished', toolsCompleted: 0, completedToolIds: [], pendingRequestIds: [] };
      } else if (kind === 'permission_request') {
        const requestId = message.requestId;
        next = { ...next, phase: 'waiting', pendingRequestIds: typeof requestId === 'string' && requestId && !next.pendingRequestIds.includes(requestId)
          ? [...next.pendingRequestIds, requestId] : next.pendingRequestIds };
      } else if (kind === 'permission_cancelled') {
        const requestId = message.requestId;
        const pendingRequestIds = typeof requestId === 'string' ? next.pendingRequestIds.filter(id => id !== requestId) : next.pendingRequestIds;
        next = { ...next, pendingRequestIds, phase: pendingRequestIds.length ? 'waiting' : 'working' };
      } else if (kind === 'status' && message.text === 'compacting') {
        next = { ...next, phase: 'compacting' };
      } else if (kind === 'status' && message.retryProgress) {
        next = { ...next, phase: 'retrying' };
      } else if (kind === 'status' && message.text === 'model_request_started') {
        next = { ...next, phase: 'working' };
      } else if (kind === 'compact_boundary' || kind === 'tool_use' || kind === 'stream_delta' ||
        kind === 'text' || kind === 'thinking' || kind === 'stream_end') {
        next = { ...next, phase: 'working' };
      } else if (kind === 'tool_result') {
        const toolId = message.toolId;
        if (typeof toolId === 'string' && toolId && !next.completedToolIds.includes(toolId)) {
          next = { ...next, completedToolIds: [...next.completedToolIds, toolId], toolsCompleted: next.toolsCompleted + 1 };
        }
        next = { ...next, phase: 'working' };
      }
      if (next.pendingRequestIds.length && next.phase !== 'finished') next = { ...next, phase: 'waiting' };
      return next === current ? previous : { ...previous, [sessionId]: next };
    });
  }), []);

  return state;
}
