// supervisor 的重启退避与告警判定 —— 纯函数，不碰进程，方便单测。
//
// 为什么要单独拎出来：原版 .run/agent-supervisor.mjs 里写死 CHECK_MS=3000，
// gateway 一起不来就每 3 秒 spawn 一次。真出「配置错了 / 端口被占」这类慢性病时，
// 它会以每天约 2.8 万次的频率反复拉起再失败，把 agent.log 灌满（HANDOFF #3.1
// 那 1.82 GB 的另一半成因），而且看起来「一直在自愈」，实际上永远自愈不好。
// Rodex 的做法是把失败如实报出来，而不是无限重试，所以这里把退避和告警
// 都写成有状态可验证的纯函数。

/** 首次退避。再快也没必要低于 1 秒：端口释放本身要时间。 */
export const BASE_BACKOFF_MS = 3000;
/** 封顶退避。到顶之后仍然会重试，只是不再刷屏。 */
export const MAX_BACKOFF_MS = 30000;
/** 连续失败几次之后认为这不是「一次偶发崩溃」，需要人看一眼。 */
export const ALERT_AFTER_RESTARTS = 5;
/** 稳定运行超过这么久就把失败计数清零，避免上周的问题影响本周的判断。 */
export const STABLE_RESET_MS = 10 * 60 * 1000;

/**
 * 第 attempt 次（从 1 开始）重启之前该等多久。
 *
 * 指数退避 + 抖动。抖动是为了避免「重启风暴同步化」：机器醒来时多个守护
 * 同时到点、同时 spawn，会把 IO 打满然后一起失败，退避就白做了。
 * jitterRatio 传 0 可以得到确定性结果，测试用。
 */
export function backoffDelay(attempt, options = {}) {
  const base = options.baseMs ?? BASE_BACKOFF_MS;
  const max = options.maxMs ?? MAX_BACKOFF_MS;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const index = Math.max(1, Math.trunc(attempt));
  const exponential = Math.min(max, base * 2 ** (index - 1));
  if (jitterRatio <= 0) return exponential;
  const random = options.random ?? Math.random;
  const jitter = (random() * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round(exponential * (1 + jitter)));
}

/**
 * 退避序列是否已经封顶。到顶还在失败 = 慢性病。
 */
export function isBackoffCapped(attempt, options = {}) {
  const base = options.baseMs ?? BASE_BACKOFF_MS;
  const max = options.maxMs ?? MAX_BACKOFF_MS;
  return base * 2 ** (Math.max(1, Math.trunc(attempt)) - 1) >= max;
}

/**
 * 一次重启结果的记账器。有状态，但状态全在这一个对象里，可序列化。
 */
export function createRestartTracker(options = {}) {
  const alertAfter = options.alertAfter ?? ALERT_AFTER_RESTARTS;
  const stableResetMs = options.stableResetMs ?? STABLE_RESET_MS;
  const now = options.now ?? (() => Date.now());
  const state = { restarts: 0, lastStartedAt: null, lastAlertAt: null, alertCount: 0 };

  return {
    /** 进程起来了。记下时间，用于判断「这次是不是稳住了」。 */
    recordStart() {
      const at = now();
      // 上一次启动活过稳定窗口，说明中间这段是正常服务，清零。
      if (state.lastStartedAt !== null && at - state.lastStartedAt >= stableResetMs) {
        state.restarts = 0;
        state.alertCount = 0;
        state.lastAlertAt = null;
      }
      state.lastStartedAt = at;
      return state.restarts;
    },
    /** 进程死了。返回本次的告警建议，由调用方决定怎么报（日志 / 通知 / 工单）。 */
    recordFailure() {
      state.restarts += 1;
      const capped = isBackoffCapped(state.restarts, options);
      const shouldAlert = state.restarts >= alertAfter
        && (state.lastAlertAt === null || now() - state.lastAlertAt >= backoffDelay(state.restarts, options));
      if (shouldAlert) {
        state.lastAlertAt = now();
        state.alertCount += 1;
      }
      return {
        restarts: state.restarts,
        attempt: state.restarts,
        capped,
        shouldAlert,
        message: shouldAlert
          ? `gateway 已连续失败 ${state.restarts} 次（退避已到 ${capped ? '上限' : '中途'}）：不再是偶发崩溃，需要人工介入`
          : undefined,
      };
    },
    /** 服务恢复健康（比如 healthz 通过）就把计数清掉。 */
    markHealthy() {
      state.restarts = 0;
      state.alertCount = 0;
      state.lastAlertAt = null;
    },
    snapshot() {
      return { restarts: state.restarts, alertCount: state.alertCount, lastStartedAt: state.lastStartedAt };
    },
  };
}

/**
 * healthz 的判读规则单独放这里，这样「健康」的定义只有一份。
 * supervisor 用它决定要不要重启，doctor 用它决定报什么颜色。
 */
export function judgeHealth(snapshot, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? 60000;
  const now = options.now ?? Date.now();
  if (!snapshot || typeof snapshot !== 'object') return { healthy: false, reason: 'no-snapshot' };
  if (snapshot.ok !== true) return { healthy: false, reason: 'not-ok' };
  if (typeof snapshot.pid !== 'number' || snapshot.pid <= 0) return { healthy: false, reason: 'bad-pid' };
  const at = Date.parse(snapshot.at || '');
  if (!Number.isFinite(at)) return { healthy: false, reason: 'no-timestamp' };
  if (now - at > maxAgeMs) return { healthy: false, reason: `stale-${Math.round((now - at) / 1000)}s` };
  return { healthy: true, reason: 'ok' };
}
