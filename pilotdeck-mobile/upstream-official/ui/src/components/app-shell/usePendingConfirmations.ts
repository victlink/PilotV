import { useEffect, useRef, useState } from 'react';
import { useOptionalWebSocket } from '../../contexts/WebSocketContext';

export type PendingConfirmation = {
  requestId: string;
  toolName: string;
  receivedAt: number;
};

/** sessionId -> requests still waiting on the user. */
export type PendingConfirmationsBySession = Record<string, readonly PendingConfirmation[]>;

const EMPTY: PendingConfirmationsBySession = {};
const TTL_MS = 45 * 60 * 1000;
const PRUNE_INTERVAL_MS = 1000;

/** Mirrors the session-id resolution used by the chat realtime handler. */
function explicitSessionId(msg: any): string | null {
  const value = msg?.sessionId ?? msg?.session_id ?? msg?.actualSessionId ?? msg?.newSessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Collects permission / confirmation prompts for **every** session.
 *
 * The chat panel only keeps requests for the session it is currently showing
 * (`useChatProviderState` drops the rest when you switch conversations), so the
 * task monitor needs its own listener: a prompt raised by a background session
 * is exactly the thing the user must not miss.
 *
 * Recovers prompts from the all-sessions snapshot on each connection, merging
 * rather than replacing live events. Both sources expire after 45 minutes.
 */
export function usePendingConfirmations(): PendingConfirmationsBySession {
  const { subscribe, sendMessage, isConnected } = useOptionalWebSocket();
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const [pending, setPending] = useState<PendingConfirmationsBySession>(EMPTY);

  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  useEffect(() => subscribeRef.current(msg => {
    if (msg?.type === 'all-pending-permissions-response') {
      if (!Array.isArray(msg.data)) return;
      const now = Date.now();
      setPending(previous => {
        let next = pruneRequests(previous, entry => now - entry.receivedAt < TTL_MS);
        for (const item of msg.data) {
          const sessionId = explicitSessionId(item);
          const requestId = item?.requestId;
          if (!sessionId || typeof requestId !== 'string' || !requestId) continue;
          const parsed = typeof item.receivedAt === 'string' ? Date.parse(item.receivedAt) : NaN;
          const receivedAt = Number.isFinite(parsed) ? parsed : now;
          if (now - receivedAt >= TTL_MS) continue;
          const entries = next[sessionId] ?? [];
          if (entries.some(entry => entry.requestId === requestId)) continue;
          next = {
            ...next,
            [sessionId]: [...entries, {
              requestId,
              toolName: typeof item.toolName === 'string' ? item.toolName : 'UnknownTool',
              receivedAt,
            }],
          };
        }
        return next;
      });
      return;
    }
    const kind = msg?.kind;
    if (kind === 'permission_request') {
      const requestId = msg?.requestId;
      const sessionId = explicitSessionId(msg);
      if (typeof requestId !== 'string' || !requestId || !sessionId) return;
      setPending(previous => {
        const forSession = previous[sessionId] ?? [];
        if (forSession.some(entry => entry.requestId === requestId)) return previous;
        return {
          ...previous,
          [sessionId]: [
            ...forSession,
            {
              requestId,
              toolName: typeof msg?.toolName === 'string' ? msg.toolName : 'UnknownTool',
              receivedAt: Date.now(),
            },
          ],
        };
      });
      return;
    }

    if (kind === 'permission_cancelled') {
      const requestId = msg?.requestId;
      if (typeof requestId !== 'string' || !requestId) return;
      setPending(previous => pruneRequests(previous, entry => entry.requestId !== requestId));
      return;
    }

    if (kind === 'complete' || kind === 'session-turn-replaced') {
      const sessionId = explicitSessionId(msg);
      if (!sessionId) return;
      setPending(previous => {
        if (!(sessionId in previous)) return previous;
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
    }
  }), []);

  // Subscribe before requesting: a fast snapshot response must not be missed.
  useEffect(() => {
    if (isConnected) sendMessageRef.current({ type: 'get-all-pending-permissions' });
  }, [isConnected]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setPending(previous => pruneRequests(previous, entry => now - entry.receivedAt < TTL_MS));
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return pending;
}

function pruneRequests(
  previous: PendingConfirmationsBySession,
  keep: (entry: PendingConfirmation) => boolean,
): PendingConfirmationsBySession {
  let changed = false;
  const next: PendingConfirmationsBySession = {};
  for (const [sessionId, entries] of Object.entries(previous)) {
    const kept = entries.filter(keep);
    if (kept.length === entries.length) {
      next[sessionId] = entries;
    } else {
      changed = true;
      if (kept.length > 0) next[sessionId] = kept;
    }
  }
  return changed ? next : previous;
}

/** Convenience selector for a single session. */
export function useSessionConfirmationCount(bySession: PendingConfirmationsBySession, sessionId?: string): number {
  return sessionId ? bySession[sessionId]?.length ?? 0 : 0;
}
