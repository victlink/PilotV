import { useEffect, useRef, useState } from 'react';
import { useOptionalWebSocket } from '../../contexts/WebSocketContext';

type Subscribe = (handler: (message: any) => void) => () => void;

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

  useEffect(() => subscribe((message: any) => {
    const messageSessionId = message?.sessionId;
    if (!messageSessionId || messageSessionId !== sessionId) return;
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
    if (runId && runIdRef.current && runId !== runIdRef.current) return;
    if (startedAtRef.current === null || frozenRef.current !== null) return;
    frozenRef.current = Date.now() - startedAtRef.current;
    setTaskElapsed(Math.max(0, frozenRef.current));
  }), [sessionId, subscribe]);

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
    const isBudget = (message.kind === 'status' && message.text === 'token_budget') || message.kind === 'compact_boundary';
    if (!isBudget) return;
    const budget = message.tokenBudget;
    if (!budget || typeof budget !== 'object' || budget.unknown === true) return;
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
  const { subscribe } = useOptionalWebSocket();
  return useSessionContextUsage({ sessionId, subscribe });
}
