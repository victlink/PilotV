import { globalModelSelectionStore } from '../components/chat/utils/globalModelSelection';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { withDeviceParam } from '../components/app-shell/pilotvRuntime';

type WSSubscriber = (msg: any) => void;

export type ReconnectInfo = {
  attempt: number;
  nextRetryMs: number;
  status: 'connected' | 'disconnected' | 'reconnecting';
};

type WebSocketContextType = {
  ws: WebSocket | null;
  /** Returns true when the frame was sent or safely queued for replay. */
  sendMessage: (message: any) => boolean;
  latestMessage: any | null;
  isConnected: boolean;
  reconnectInfo: ReconnectInfo;
  /**
   * Subscribe to every incoming WebSocket message synchronously, bypassing
   * React state batching. Returns an unsubscribe function. Use this for
   * high-frequency event streams (chat stream_delta, etc.) where dropping
   * intermediate values is not acceptable. For low-frequency one-shot events
   * the `latestMessage` state is still fine.
   */
  subscribe: (handler: WSSubscriber) => () => void;
};

const DISCONNECTED_SNAPSHOT: WebSocketContextType = {
  ws: null,
  sendMessage: () => false,
  latestMessage: null,
  isConnected: false,
  reconnectInfo: { attempt: 0, nextRetryMs: 0, status: 'disconnected' },
  subscribe: () => () => {},
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

/**
 * Same context, but tolerates a missing provider and hands back inert handles.
 * Ambient monitors (the task panel) must keep rendering where no socket is
 * mounted, so they cannot use the throwing hook.
 */
export const useOptionalWebSocket = (): WebSocketContextType =>
  useContext(WebSocketContext) ?? DISCONNECTED_SNAPSHOT;


const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 带上当前设备：这个长连接连的是哪台后端，不能由别的标签页改掉。
  if (IS_PLATFORM || !token) return withDeviceParam(`${protocol}//${window.location.host}/ws`);
  return withDeviceParam(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
};

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const BACKOFF_FACTOR = 2;
const MAX_QUEUED_MESSAGES = 100;

/**
 * 活体检测（watchdog）参数。
 *
 * 手机/平板上「用一会儿就整个卡死、只能重启」的根因是一条半开的 WebSocket：
 * 链路被静默掐掉后，手机浏览器的 socket 仍然停在 readyState === OPEN，
 * send() 把数据写进死亡连接的内核缓冲并返回 true，前端以为发出去了。
 * 于是界面完全正常、没有任何报错、断线横幅也不弹（横幅只在 status !== 'connected'
 * 时出现），用户点任何按钮都毫无反应。之前这里只发 ping、从不校验回包，
 * 也没有握手超时，所以这种情况可以一直持续下去。
 */
const PING_INTERVAL_MS = 30_000;
/** 建连后多久还没进入 OPEN 就判定失败。CONNECTING 状态下既不 open 也不 close，只能自己收手。 */
const HANDSHAKE_TIMEOUT_MS = 12_000;
const LIVENESS_CHECK_INTERVAL_MS = 10_000;
/** ping 发出后这么久还没有任何回包，才认为链路可能已经死了。留了两轮 ping 的余量。 */
const LIVENESS_TIMEOUT_MS = 75_000;
/**
 * 服务端不回应 ping 时不能套用 LIVENESS_TIMEOUT_MS：一条「健康但空闲」的连接
 * 本来就不会有任何回包，那样每 75 秒就会误杀一次。所以先观察一段时间，
 * 收到过 pong 说明支持探活（走严格阈值），一直没收到就退化成宽松阈值。
 */
const PONG_PROBE_WINDOW_MS = 120_000;
const SILENT_RECYCLE_MS = 10 * 60_000;
/** 切后台超过这么久再回来，链路大概率已经换过路径（Wi-Fi ↔ 蜂窝、Tailscale 换出口）。 */
const BACKGROUND_STALE_MS = 20_000;

export function getQueuedMessageKey(message: any): string | null {
  if (message?.type === 'check-session-status' && typeof message.sessionId === 'string' && message.sessionId.trim()) {
    return `check-session-status:${message.sessionId.trim()}`;
  }
  return null;
}

export function isQueueableDisconnectedMessage(message: any): boolean {
  return getQueuedMessageKey(message) !== null;
}

export function enqueueDisconnectedMessage(queue: any[], message: any, maxQueuedMessages = MAX_QUEUED_MESSAGES): void {
  const key = getQueuedMessageKey(message);
  if (!key) return;
  const existingIndex = queue.findIndex((queuedMessage) => getQueuedMessageKey(queuedMessage) === key);
  if (existingIndex >= 0) {
    queue.splice(existingIndex, 1);
  }
  queue.push(message);
  if (queue.length > maxQueuedMessages) {
    queue.splice(0, queue.length - maxQueuedMessages);
  }
}

export function clearDisconnectedQueue(queue: any[]): void {
  queue.splice(0, queue.length);
}

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const connectIdRef = useRef(0);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectInfo>({
    attempt: 0,
    nextRetryMs: 0,
    status: 'disconnected',
  });
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const queuedMessagesRef = useRef<any[]>([]);
  const subscribersRef = useRef<Set<WSSubscriber>>(new Set());
  /** 进入后台的时刻；回到前台时用它判断该不该直接换一条连接。 */
  const hiddenAtRef = useRef<number | null>(null);
  /**
   * 当前这条连接清理计时器的办法。
   * 组件卸载的清理逻辑会先把 onclose 置空再 close()，所以那条连接自己的 onclose
   * 不会执行，里面的清理也就永远不会跑。定时器必须在这里补一刀，
   * 否则每卸载一次就留下一个永远醒着的 10 秒定时器。
   */
  const clearConnectionTimersRef = useRef<(() => void) | null>(null);
  const { token } = useAuth();

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  useEffect(() => {
    const id = ++connectIdRef.current;

    const connect = () => {
      if (unmountedRef.current || connectIdRef.current !== id) return;
      setReconnectInfo((prev) => ({ ...prev, status: 'reconnecting' }));
      try {
        const wsUrl = buildWebSocketUrl(token);
        if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

        const websocket = new WebSocket(wsUrl);

        // 这一条连接专属的状态。放在局部而不是 ref 里：连接被放弃时它们就该整体消失，
        // 少一个残留的定时器就少一个每 30 秒醒一次、然后往一条死连接上写东西的僵尸。
        let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;
        let livenessTimer: ReturnType<typeof setInterval> | null = null;
        let lastInboundAt = Date.now();
        /** 最近一次 ping 的发出时刻；在收到 pong 之前一直等着。 */
        let pingSentAt: number | null = null;
        /** 有没有收到过 pong。它决定我们敢不敢用严格的静默阈值。 */
        let pongSeen = false;
        /** 宽松回退只提醒一次，否则每 10 秒都会往控制台刷一遍。 */
        let silentFallbackLogged = false;

        const clearConnectionTimers = () => {
          if (handshakeTimer) clearTimeout(handshakeTimer);
          if (pingTimer) clearInterval(pingTimer);
          if (livenessTimer) clearInterval(livenessTimer);
          handshakeTimer = null;
          pingTimer = null;
          livenessTimer = null;
        };
        clearConnectionTimersRef.current = clearConnectionTimers;

        /**
         * 主动放弃这条连接，统一走 onclose 的重连路径。
         * 退避计数先归零，所以是 1 秒后重连，而不是排队等一个 30 秒的退避。
         */
        const abandon = (reason: string) => {
          if (websocket.readyState === WebSocket.CLOSING || websocket.readyState === WebSocket.CLOSED) return;
          console.warn(`WebSocket 连接已放弃：${reason}`);
          reconnectAttemptRef.current = 0;
          try { websocket.close(); } catch { /* 已经断了，交给 onclose */ }
        };

        // CONNECTING 状态下浏览器既不 open 也不 close，前端只能自己收手。
        handshakeTimer = setTimeout(() => abandon('握手超时'), HANDSHAKE_TIMEOUT_MS);

        websocket.onopen = () => {
          if (connectIdRef.current !== id) { websocket.close(); return; }
          if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
          lastInboundAt = Date.now();
          setIsConnected(true);
          reconnectAttemptRef.current = 0;
          setReconnectInfo({ attempt: 0, nextRetryMs: 0, status: 'connected' });
          wsRef.current = websocket;

          while (queuedMessagesRef.current.length > 0 && websocket.readyState === WebSocket.OPEN) {
            const message = queuedMessagesRef.current.shift();
            websocket.send(JSON.stringify(message));
          }

          pingTimer = setInterval(() => {
            if (websocket.readyState !== WebSocket.OPEN) return;
            pingSentAt = Date.now();
            try {
              websocket.send(JSON.stringify({ type: 'ping', ts: pingSentAt }));
            } catch (error) {
              abandon('发送 ping 失败');
            }
          }, PING_INTERVAL_MS);

          livenessTimer = setInterval(() => {
            if (websocket.readyState !== WebSocket.OPEN) return;
            const now = Date.now();
            const silentFor = now - lastInboundAt;
            if (pongSeen) {
              // 服务端会回 pong：ping 出去 75 秒还没有回包，这条连接只能是死的。
              if (pingSentAt !== null && now - pingSentAt >= LIVENESS_TIMEOUT_MS) {
                abandon(`ping 发出后 ${LIVENESS_TIMEOUT_MS / 1000} 秒没有任何回包`);
              }
              return;
            }
            // 服务端不回 pong，只能退一步：靠「长时间彻底没动静」来兜底。
            // 观察窗口过了还没等到 pong，就认定这条连接不支持探活。
            if (silentFor >= PONG_PROBE_WINDOW_MS && !silentFallbackLogged) {
              console.warn('服务端不回应 ping，改用宽松的静默回收阈值');
              silentFallbackLogged = true;
            }
            if (silentFor >= SILENT_RECYCLE_MS) {
              abandon(`静默 ${Math.round(silentFor / 1000)} 秒没有任何回包`);
            }
          }, LIVENESS_CHECK_INTERVAL_MS);

          websocket.addEventListener('close', clearConnectionTimers);

          if (hasConnectedRef.current) {
            globalModelSelectionStore.invalidate();
            const reconnectMsg = { type: 'websocket-reconnected', timestamp: Date.now() };
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach((sub) => {
                try { sub(reconnectMsg); } catch { /* Isolate subscriber failures. */ }
              });
            }
            setLatestMessage(reconnectMsg);
          }
          hasConnectedRef.current = true;
        };

        websocket.onmessage = (event) => {
          if (connectIdRef.current !== id) return;
          try {
            const data = JSON.parse(event.data);
            lastInboundAt = Date.now();
            if (data?.type === 'pong') {
              // pong 只用来探活，不再往下游广播：latestMessage 一变整棵 App 就会重渲染，
              // 每 30 秒白刷一次没有好处。
              pongSeen = true;
              silentFallbackLogged = false;
              pingSentAt = null;
              return;
            }
            // Invalidate even while the composer is unmounted (for example in settings).
            if (data?.type === 'config:reloaded') globalModelSelectionStore.invalidate();
            globalModelSelectionStore.receiveMessage(data);
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach((sub) => {
                try {
                  sub(data);
                } catch (err) {
                  console.error('WebSocket subscriber error:', err);
                }
              });
            }
            setLatestMessage(data);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };

        websocket.onclose = () => {
          if (connectIdRef.current !== id) return;
          clearConnectionTimers();
          setIsConnected(false);
          wsRef.current = null;
          const attempt = ++reconnectAttemptRef.current;
          const delay = Math.min(
            INITIAL_RECONNECT_MS * Math.pow(BACKOFF_FACTOR, attempt - 1),
            MAX_RECONNECT_MS,
          );
          setReconnectInfo({ attempt, nextRetryMs: delay, status: 'disconnected' });
          reconnectTimeoutRef.current = setTimeout(() => {
            if (unmountedRef.current || connectIdRef.current !== id) return;
            connect();
          }, delay);
        };

        websocket.onerror = (error) => {
          console.error('WebSocket error:', error);
        };
      } catch (error) {
        console.error('Error creating WebSocket connection:', error);
      }
    };

    connect();

    /**
     * 手机/平板上最常见的死法：App 切到后台 → 系统休眠、或 Wi-Fi ↔ 蜂窝切换、
     * 或 Tailscale 换了出口 → 旧的那条 TCP 连接被静默丢弃。
     * 回到前台时浏览器里的 socket 仍然停在 OPEN，既没有 close 也没有 error，
     * 上面那条重连逻辑永远不会被触发 —— 这就是「界面完全正常但什么都点不动，
     * 只有重启才好」的直接来源。
     *
     * 所以在可见性/网络恢复的瞬间无条件换一条连接，不去猜原来那条还活不活着。
     * 只是短暂切走（比如误触了一下）就不打扰，避免无谓的抖动。
     */
    const recycleIfStale = () => {
      if (unmountedRef.current || connectIdRef.current !== id) return;
      const hiddenAt = hiddenAtRef.current;
      if (document.visibilityState === 'visible') hiddenAtRef.current = null;
      const backgroundedTooLong = hiddenAt !== null && Date.now() - hiddenAt >= BACKGROUND_STALE_MS;
      const networkWentDown = document.visibilityState === 'visible' && navigator.onLine === false;
      if (!backgroundedTooLong && !networkWentDown) return;
      const ws = wsRef.current;
      if (!ws) return;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        console.warn('前台/网络恢复，主动重建 WebSocket 连接');
        reconnectAttemptRef.current = 0;
        try { ws.close(); } catch { /* 已经断了，交给 onclose */ }
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      recycleIfStale();
    };
    const onOnline = () => recycleIfStale();
    const onPageShow = (event: PageTransitionEvent) => {
      // 从 bfcache 恢复时 JS 状态被原样保留，但 socket 早就没了，而且不会有 close 事件。
      if (event.persisted) recycleIfStale();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
      hiddenAtRef.current = null;
      clearConnectionTimersRef.current?.();
      clearConnectionTimersRef.current = null;
      connectIdRef.current++;
      clearDisconnectedQueue(queuedMessagesRef.current);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [token]);

  const sendMessage = useCallback((message: any): boolean => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(message));
        globalModelSelectionStore.trackMessage(message);
        return true;
      } catch (error) {
        console.warn('Failed to send WebSocket message', error);
        return false;
      }
    } else if (isQueueableDisconnectedMessage(message)) {
      enqueueDisconnectedMessage(queuedMessagesRef.current, message);
      console.warn('WebSocket not connected');
      return true;
    } else {
      console.warn('WebSocket not connected');
      return false;
    }
  }, []);

  const subscribe = useCallback<WebSocketContextType['subscribe']>((handler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected,
    reconnectInfo,
    subscribe,
  }), [sendMessage, latestMessage, isConnected, reconnectInfo, subscribe]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
