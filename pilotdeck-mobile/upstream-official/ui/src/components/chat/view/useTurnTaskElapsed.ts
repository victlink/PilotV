import { useEffect, useRef, useState } from 'react';
import { useOptionalWebSocket } from '../../../contexts/WebSocketContext';

type Subscribe = (handler: (message: any) => void) => () => void;

// History is loaded by the session store, often before the header mounts.
const historyTimings = new Map<string, any>();
const historyListeners = new Set<(message: any) => void>();
export function restoreSessionTurnTiming(sessionId: string, messages: readonly any[]): void {
  const latest = [...messages].reverse().find((message) => {
    const start = Date.parse(message.turnTiming?.startedAt);
    const end = Date.parse(message.turnTiming?.completedAt);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start;
  });
  if (!latest) return;
  const cached = historyTimings.get(sessionId);
  if (cached && Date.parse(cached.turnTiming.startedAt) > Date.parse(latest.turnTiming.startedAt)) return;
  const frame = { ...latest, sessionId, kind: 'complete', restoredHistory: true };
  historyTimings.delete(sessionId);
  historyTimings.set(sessionId, frame);
  if (historyTimings.size > 100) historyTimings.delete(historyTimings.keys().next().value!);
  for (const listener of historyListeners) listener(frame);
}

/**
 * Execution time (ms) for the conversation's current turn.
 *
 * The clock starts at the `started` frame the gateway emits for a turn (the
 * same event the task monitor trusts) and freezes when the turn completes,
 * errors terminally, or gets interrupted, so the finished duration stays
 * readable until the next turn begins. It resets when the conversation
 * changes and never appears for turns that were not actually started.
 */
export function useTurnTaskElapsed({ sessionId, subscribe }: {
  sessionId: string | null;
  subscribe: Subscribe;
}): number | null {
  const sessionKeyRef = useRef(sessionId);
  const runIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const frozenRef = useRef<number | null>(null);
  const [taskElapsed, setTaskElapsed] = useState<number | null>(null);
  const taskElapsedRunning = taskElapsed !== null && frozenRef.current === null;

  useEffect(() => {
    if (sessionKeyRef.current !== sessionId) {
      sessionKeyRef.current = sessionId;
      runIdRef.current = null;
      startedAtRef.current = null;
      frozenRef.current = null;
      setTaskElapsed(null);
    }
  }, [sessionId]);

  useEffect(() => {
    const handle = (message: any) => {
    const messageSessionId = message?.sessionId;
    if (!messageSessionId || messageSessionId !== sessionId) return;
    if (message.type === 'session-status') {
      const frames = Array.isArray(message.activeTurnMessages) ? message.activeTurnMessages : [];
      const start = frames.find((frame: any) => frame.kind === 'status' && frame.text === 'started'
        && frame.runId === message.activeRunId);
      const timestamp = typeof start?.timestamp === 'string' ? Date.parse(start.timestamp) : NaN;
      if (message.isProcessing && Number.isFinite(timestamp)) {
        runIdRef.current = message.activeRunId;
        startedAtRef.current = timestamp;
        frozenRef.current = null;
        setTaskElapsed(Math.max(0, Date.now() - timestamp));
      }
      return;
    }
    const runId = typeof message.runId === 'string' && message.runId ? message.runId : null;
    if (message.kind === 'status' && message.text === 'started') {
      if (runId && runIdRef.current === runId) return;
      const parsed = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
      runIdRef.current = runId;
      startedAtRef.current = Number.isFinite(parsed) ? parsed : Date.now();
      frozenRef.current = null;
      setTaskElapsed(Math.max(0, Date.now() - startedAtRef.current));
      return;
    }
    const terminal = message.kind === 'complete'
      || message.kind === 'interrupted'
      || (message.kind === 'error' && message.terminal !== false);
    if (!terminal) return;
    const timingStart = typeof message.turnTiming?.startedAt === 'string' ? Date.parse(message.turnTiming.startedAt) : NaN;
    const timingEnd = typeof message.turnTiming?.completedAt === 'string' ? Date.parse(message.turnTiming.completedAt) : NaN;
    // Late history cannot overwrite a running turn or regress a known result.
    // A newer completed turn may have happened while the socket was offline.
    if (message.restoredHistory && startedAtRef.current !== null
      && (frozenRef.current === null || !Number.isFinite(timingStart) || timingStart < startedAtRef.current)) return;
    if (!message.restoredHistory && runId && runIdRef.current && runId !== runIdRef.current) return;
    if (Number.isFinite(timingStart) && Number.isFinite(timingEnd) && timingEnd >= timingStart) {
      runIdRef.current = runId;
      startedAtRef.current = timingStart;
      frozenRef.current = timingEnd - timingStart;
      setTaskElapsed(frozenRef.current);
      return;
    }
    if (startedAtRef.current === null || frozenRef.current !== null) return;
    frozenRef.current = Date.now() - startedAtRef.current;
    setTaskElapsed(Math.max(0, frozenRef.current));
    };
    historyListeners.add(handle);
    const unsubscribe = subscribe(handle);
    if (sessionId && historyTimings.has(sessionId)) handle(historyTimings.get(sessionId));
    return () => { historyListeners.delete(handle); unsubscribe(); };
  }, [sessionId, subscribe]);

  useEffect(() => {
    // A frozen duration stops ticking; only a live turn needs the redraw.
    if (!taskElapsedRunning) return undefined;
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null || frozenRef.current !== null) return;
      setTaskElapsed(Math.max(0, Date.now() - startedAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [taskElapsedRunning, sessionId]);

  return taskElapsed;
}

/**
 * Same clock for surfaces outside the chat interface (the workspace header).
 * Ambient shells mount without a socket, so it reads the optional context and
 * stays empty where no connection exists.
 */
export function useTurnTaskElapsedFromSocket(sessionId: string | null): number | null {
  const { subscribe } = useOptionalWebSocket();
  return useTurnTaskElapsed({ sessionId, subscribe });
}
/**
 * Latest context usage snapshot (tokens used / model window) for one session,
 * fed by the gateway's `token_budget` status and `compact_boundary` frames —
 * the same events the composer's context gauge reads. Unknown frames and
 * non-positive totals are ignored so nothing renders a made-up number.
 */
export function useSessionContextUsage({ sessionId, subscribe }: {
  sessionId: string | null;
  subscribe: Subscribe;
}): { used: number; total: number } | null {
  const [usage, setUsage] = useState<{ used: number; total: number } | null>(null);
  const sessionKeyRef = useRef(sessionId);
  useEffect(() => {
    if (sessionKeyRef.current !== sessionId) {
      sessionKeyRef.current = sessionId;
      setUsage(null);
    }
  }, [sessionId]);
  useEffect(() => subscribe((message: any) => {
    if (!sessionId || message?.sessionId !== sessionId) return;
    const isSnapshot = message.type === 'session-status';
    const isBudget = isSnapshot || (message.kind === 'status' && message.text === 'token_budget') || message.kind === 'compact_boundary';
    if (!isBudget) return;
    const budget = message.tokenBudget;
    if (!budget || typeof budget !== 'object' || budget.unknown === true) {
      if (isSnapshot) setUsage(null);
      return;
    }
    const used = readFinite(budget.used ?? budget.displayUsed);
    const total = readFinite(budget.total);
    if (total === null || total <= 0 || used === null || used < 0) return;
    setUsage({ used, total });
  }), [sessionId, subscribe]);
  return usage;
}

function readFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Socket-fed variant for the workspace header. */
export function useSessionContextUsageFromSocket(sessionId: string | null): { used: number; total: number } | null {
  const { subscribe, sendMessage, isConnected } = useOptionalWebSocket();
  const usage = useSessionContextUsage({ sessionId, subscribe });
  // Subscribe before requesting: a fast reply must not be missed. The same
  // request restores the snapshot on mount, session switch and reconnect.
  useEffect(() => {
    if (sessionId && isConnected) {
      sendMessage({ type: 'check-session-status', sessionId, includeActiveTurnMessages: true });
    }
  }, [sessionId, isConnected, sendMessage]);
  return usage;
}
