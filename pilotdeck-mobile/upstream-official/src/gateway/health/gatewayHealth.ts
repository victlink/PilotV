// 进程级会话健康注册表：把 tracker 挂到「写侧（WS 事件流）」和「读侧（/healthz）」
// 之间，这样两侧不用互相引用。
//
// 为什么用模块级单例：gateway 进程只有一个（18790 锁 + supervisor 保证），
// 而 GatewayWsConnection 由 handleUpgrade 每条连接 new 一个，拿不到依赖注入。
// 用单例是这里最小的接入面 —— 代价是测试里要显式 reset()，测试已经这么做。

import { createSessionHealthTracker, type SessionHealthTracker } from "./SessionHealthTracker.js";

let tracker: SessionHealthTracker | null = null;

/** 第一次用到时惰性建，之后所有人共用同一份账。 */
export function getSessionHealthTracker(): SessionHealthTracker {
  if (!tracker) tracker = createSessionHealthTracker();
  return tracker;
}

/** 仅供测试。生产代码不应该换掉这份账。 */
export function resetSessionHealthTracker(): void {
  tracker = null;
}

/**
 * 组装 /healthz 的响应。
 *
 * 字段口径写死在这里，supervisor 和 doctor 都按这份读，避免两边各猜一套。
 * 「进程活着」和「进程能干活」是两件事：健康检查必须能区分，否则就会像
 * HANDOFF 那次一样，端口能连上、进程在，但每个会话都在失败。
 */
export type GatewayHealthInput = {
  /** 当前存活的 gateway WebSocket 连接数。 */
  wsConnections: number;
  /** 静态资产目录是否可用（没有它前端是白屏，属于「活着但没用」）。 */
  staticAssetsReady?: boolean;
  serverVersion?: string;
  now?: () => number;
};

export function buildGatewayHealthPayload(input: GatewayHealthInput) {
  const now = input.now?.() ?? Date.now();
  const summary = getSessionHealthTracker().snapshot();
  const degraded = summary.degraded > 0;
  // 会话全降级 + 一条连接都没有 = 这个进程实际上已经不干活了。
  const stalled = summary.sessions > 0 && summary.degraded === summary.sessions;
  return {
    ok: !stalled,
    status: stalled ? "degraded" : degraded ? "degraded-partial" : "healthy",
    pid: process.pid,
    at: new Date(now).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    serverVersion: input.serverVersion,
    wsConnections: input.wsConnections,
    sessions: summary.sessions,
    degradedSessions: summary.degraded,
    healthScope: summary.scope,
    // 计划点名的三项：进程、ws 在线会话数、最近压缩成功率。
    compaction: summary.compaction,
    reasons: summary.degradedSessions.slice(0, 5),
    staticAssetsReady: input.staticAssetsReady,
  };
}