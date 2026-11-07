// 会话级健康跟踪与会话熔断。
//
// 为什么需要它（HANDOFF-Windows-20261105 §2.1 的教训）：
//   缺陷 B 的本质是「一个会话的次要 promise 失败 -> 整个 gateway 优雅退出 ->
//   所有在线会话一起掉线」。当时的修复让进程不再退出，但故障的**归属**仍然没有
//   被记录：谁坏了、坏在哪、坏了几次，前端一概看不见，只能翻日志猜。
//   这里补上另一半：故障按会话记账，只降级出问题的那个会话，并把原因如实
//   上报给前端和 /healthz。
//
// 三条硬约束：
//   1. 永不抛异常。这个模块坐在事件流的必经之路上，它自己崩了就又变成
//      「观测代码制造故障」，正是我们刚从上游搬开的那种坑。
//   2. 只记账，不处置。要不要重建议话、要不要提示用户由调用方决定；
//      熔断只负责把「这个会话现在是降级的，原因是 X」说清楚。
//   3. 降级必须可恢复。后续成功事件会把会话拉回 healthy，不是一次失败定终身。

import type { GatewayEvent } from "../protocol/types.js";

/** 连续失败多少次才判降级。1 次就降级会被偶发抖动误伤。 */
export const DEFAULT_FAILURE_THRESHOLD = 2;
/** 超过这个时长没再出事的会话记录会被回收，防止长跑进程里 Map 只增不减。 */
export const DEFAULT_RECORD_TTL_MS = 60 * 60 * 1000;

export type SessionHealthCategory = "compaction" | "model" | "tool" | "external";
export type SessionHealthState = "healthy" | "degraded";

export type SessionHealthSnapshot = {
  sessionKey: string;
  state: SessionHealthState;
  category?: SessionHealthCategory;
  reason?: string;
  degradedAt?: number | null;
  lastFailureAt?: number | null;
  consecutive: number;
  failureTotal: number;
  turnTotal: number;
  failures: Partial<Record<SessionHealthCategory, number>>;
  compaction: { succeeded: number; failed: number };
};

export type SessionHealthSummary = {
  sessions: number;
  degraded: number;
  /** 熔断的作用域：坏的是局部还是全部 —— 这是会话级隔离的核心结论。 */
  scope: "none" | "partial" | "all";
  degradedSessions: Array<{ sessionKey: string; category?: SessionHealthCategory; reason?: string }>;
  compaction: { total: number; succeeded: number; failed: number; successRate: number | null };
};

export type SessionDegradeListener = (info: {
  sessionKey: string;
  category: SessionHealthCategory;
  reason: string;
  failures: number;
}) => void;

export type SessionHealthTrackerOptions = {
  now?: () => number;
  failureThreshold?: number;
  recordTtlMs?: number;
  onDegrade?: SessionDegradeListener;
  onRecover?: (info: { sessionKey: string }) => void;
};

type HealthRecord = {
  sessionKey: string;
  state: SessionHealthState;
  failures: Map<SessionHealthCategory, number>;
  consecutive: number;
  lastFailureAt: number | null;
  lastEventAt: number;
  degradedAt: number | null;
  reason: string | null;
  category: SessionHealthCategory | null;
  failureTotal: number;
  turnTotal: number;
  compaction: { succeeded: number; failed: number };
};

// 压缩事件在 gateway 协议里不是独立类型：InProcessGateway 把上游的
// compact_completed 包成 { type: "agent_status", event: "compact_completed", detail }。
// 直接匹配 "compact_completed" 永远匹配不上，健康度就成了摆设 —— 这一点是
// 照抄 agent 层事件类型时最容易犯的错，tsc 会直接拒绝，所以留给编译器来提醒。
const TRACKED_EVENT_TYPES = new Set<string>([
  "agent_status",
  "error",
  "tool_call_finished",
  "turn_completed",
]);

const COMPACTION_COMPLETED_EVENT = "compact_completed";

function compactionStatusOf(event: GatewayEvent): string | null {
  if (event.type !== "agent_status" || event.event !== COMPACTION_COMPLETED_EVENT) return null;
  const status = event.detail?.status;
  return typeof status === "string" ? status : null;
}

function failureKeyOf(event: GatewayEvent): SessionHealthCategory | null {
  switch (event.type) {
    case "agent_status":
      // 摘要失败就是 HANDOFF §2.2 里那个会反复自增的病态循环，单独归类。
      return compactionStatusOf(event) === "failed" ? "compaction" : null;
    case "error":
      // recoverable:false 在上游语义里等于「这条会话这次真出事了」。
      return event.recoverable === false ? "model" : null;
    case "tool_call_finished":
      // 上游用的是 ok:false 而不是 isError，照搬别的代码库会永远漏判。
      return event.ok === false ? "tool" : null;
    default:
      return null;
  }
}

function describeFailure(event: GatewayEvent): string {
  if (event.type === "agent_status") {
    const trigger = String(event.detail?.trigger ?? "unknown");
    const preTokens = String(event.detail?.preTokens ?? "?");
    return `上下文压缩失败（trigger=${trigger}，${preTokens} tokens 未回收）`;
  }
  if (event.type === "error") {
    return `模型/运行时错误${event.code ? ` code=${event.code}` : ""}：${event.message || "未提供原因"}`;
  }
  if (event.type === "tool_call_finished") {
    return `工具调用失败：${event.toolName || event.toolCallId || "unknown"}`;
  }
  return "未知失败";
}

function emptyCompaction() {
  return { succeeded: 0, failed: 0 };
}

export type SessionHealthTracker = {
  observe(event: GatewayEvent, context?: { sessionKey?: string }): {
    changed: boolean;
    state?: SessionHealthState;
    category?: SessionHealthCategory;
  };
  markDegraded(sessionKey: string, category?: SessionHealthCategory | string, reason?: string): void;
  markRecovered(sessionKey: string): void;
  get(sessionKey: string): SessionHealthSnapshot;
  snapshot(): SessionHealthSummary;
};

export function createSessionHealthTracker(options: SessionHealthTrackerOptions = {}): SessionHealthTracker {
  const now = options.now ?? (() => Date.now());
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const recordTtlMs = options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS;
  const records = new Map<string, HealthRecord>();

  function notifyDegrade(record: HealthRecord, category: SessionHealthCategory, reason: string) {
    // 回调是外部塞进来的，它崩了不能连累事件流。
    try {
      options.onDegrade?.({ sessionKey: record.sessionKey, category, reason, failures: record.consecutive });
    } catch { /* ignore */ }
  }

  function notifyRecover(sessionKey: string) {
    try { options.onRecover?.({ sessionKey }); } catch { /* ignore */ }
  }

  function recordFor(sessionKey: string): HealthRecord {
    let record = records.get(sessionKey);
    if (!record) {
      record = {
        sessionKey,
        state: "healthy",
        failures: new Map(),
        consecutive: 0,
        lastFailureAt: null,
        lastEventAt: now(),
        degradedAt: null,
        reason: null,
        category: null,
        failureTotal: 0,
        turnTotal: 0,
        compaction: emptyCompaction(),
      };
      records.set(sessionKey, record);
    }
    return record;
  }

  function degrade(record: HealthRecord, category: SessionHealthCategory, reason: string) {
    const wasDegraded = record.state === "degraded";
    record.state = "degraded";
    record.category = category;
    record.reason = reason;
    if (!wasDegraded) {
      record.degradedAt = now();
      notifyDegrade(record, category, reason);
    }
  }

  function recover(record: HealthRecord) {
    if (record.state !== "degraded") return;
    record.state = "healthy";
    record.reason = null;
    record.category = null;
    record.degradedAt = null;
    record.consecutive = 0;
    record.failures.clear();
    notifyRecover(record.sessionKey);
  }

  /** 回收长期静默的会话记录。由 snapshot() 顺带做，不额外起定时器。 */
  function sweep() {
    const cutoff = now() - recordTtlMs;
    for (const [sessionKey, record] of records) {
      if (record.lastEventAt < cutoff) records.delete(sessionKey);
    }
  }

  return {
    observe(event, context = {}) {
      const sessionKey = typeof context.sessionKey === "string" ? context.sessionKey : "";
      if (!sessionKey || !event || !TRACKED_EVENT_TYPES.has(event.type)) {
        return { changed: false };
      }
      try {
        const record = recordFor(sessionKey);
        record.lastEventAt = now();
        const before = record.state;

        if (event.type === "turn_completed") {
          // 一轮完整跑完 = 这条会话此刻能用。压缩失败的历史账不清（那是事实），
          // 但连续失败计数归零，避免把「偶发失败 + 之后正常」误判成熔断。
          record.turnTotal += 1;
          record.consecutive = 0;
          recover(record);
          return { changed: before !== record.state, state: record.state };
        }

        const category = failureKeyOf(event);
        if (!category) {
          // 压缩成功是明确的康复信号（§2.2 那个会话最需要的就是这个出口）。
          if (compactionStatusOf(event) === "success") {
            record.compaction.succeeded += 1;
            recover(record);
          }
          return { changed: before !== record.state, state: record.state };
        }

        if (category === "compaction") record.compaction.failed += 1;
        record.consecutive += 1;
        record.failureTotal += 1;
        record.lastFailureAt = now();
        record.failures.set(category, (record.failures.get(category) ?? 0) + 1);

        if (record.consecutive >= failureThreshold) {
          degrade(record, category, describeFailure(event));
        }
        return { changed: before !== record.state, state: record.state, category };
      } catch {
        // 观测逻辑出错时最合适的处理是当没看见，绝不能把异常送回事件流。
        return { changed: false };
      }
    },

    markDegraded(sessionKey, category, reason) {
      if (!sessionKey) return;
      try {
        degrade(recordFor(sessionKey), (category || "external") as SessionHealthCategory, reason || "未提供原因");
      } catch { /* ignore */ }
    },

    markRecovered(sessionKey) {
      try {
        const record = records.get(sessionKey);
        if (record) recover(record);
      } catch { /* ignore */ }
    },

    get(sessionKey) {
      const record = records.get(sessionKey);
      if (!record) {
        return {
          sessionKey,
          state: "healthy",
          consecutive: 0,
          failureTotal: 0,
          turnTotal: 0,
          failures: {},
          compaction: emptyCompaction(),
        };
      }
      return {
        sessionKey,
        state: record.state,
        category: record.category ?? undefined,
        reason: record.reason ?? undefined,
        degradedAt: record.degradedAt,
        lastFailureAt: record.lastFailureAt,
        consecutive: record.consecutive,
        failureTotal: record.failureTotal,
        turnTotal: record.turnTotal,
        failures: Object.fromEntries(record.failures),
        compaction: { ...record.compaction },
      };
    },

    snapshot() {
      sweep();
      const sessions = [...records.values()];
      const degraded = sessions.filter(record => record.state === "degraded");
      let succeeded = 0;
      let failed = 0;
      for (const record of sessions) {
        succeeded += record.compaction.succeeded;
        failed += record.compaction.failed;
      }
      const total = succeeded + failed;
      return {
        sessions: sessions.length,
        degraded: degraded.length,
        scope: degraded.length === 0 ? "none"
          : degraded.length === sessions.length ? "all" : "partial",
        degradedSessions: degraded.map(record => ({
          sessionKey: record.sessionKey,
          category: record.category ?? undefined,
          reason: record.reason ?? undefined,
        })),
        compaction: {
          total,
          succeeded,
          failed,
          // 计划里点名的「最近压缩成功率」。没有样本时给 null 而不是 1，
          // 免得 doctor 把「还没跑过压缩」读成「压缩全对」。
          successRate: total === 0 ? null : succeeded / total,
        },
      };
    },
  };
}