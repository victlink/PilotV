export type ProviderHealthState = "healthy" | "degraded" | "open" | "half_open";

const DEFAULT_DEGRADE_THRESHOLD = 3;
const DEFAULT_OPEN_THRESHOLD = 5;
const DEFAULT_OPEN_DURATION_MS = 30_000;
const DEFAULT_WINDOW_SIZE = 20;
/** Never let a provider Retry-After value pin the circuit closed forever. */
const DEFAULT_MAX_COOLDOWN_MS = 5 * 60_000;
/** A half-open probe that never reports back must not wedge the circuit. */
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

export type ProviderFailure = {
  /** Canonical error code. A 429 opens the circuit immediately. */
  code?: string;
  /** Parsed Retry-After, in milliseconds. */
  retryAfterMs?: number;
};

export type ProviderHealthSnapshot = {
  state: ProviderHealthState;
  successRate: number;
  consecutiveFailures: number;
  /** Epoch ms until which the provider must not be selected. 0 when healthy. */
  cooldownUntil: number;
  probeInFlight: boolean;
};

type ProviderRecord = {
  state: ProviderHealthState;
  consecutiveFailures: number;
  /** Timestamp (ms) when the circuit was opened. */
  openedAt: number;
  /** Timestamp (ms) until which the circuit stays open. */
  cooldownUntil: number;
  /** Only one half-open probe may be in flight at a time. */
  probeInFlight: boolean;
  probeStartedAt: number;
  /** Sliding window of recent results (true = success). */
  window: boolean[];
};

/**
 * Lightweight per-provider circuit breaker.
 *
 * States:
 *   healthy  → degraded (after `degradeThreshold` consecutive failures)
 *   degraded → open     (after `openThreshold` consecutive failures, or any 429)
 *   open     → half_open (once the cooldown / Retry-After window elapses)
 *   half_open → healthy  (probe succeeds) or open (probe fails)
 *
 * Rate limits are deterministic rather than flaky, so a single 429 opens the
 * circuit immediately. The cooldown comes from the provider's Retry-After
 * when available; otherwise `openDurationMs` is used.
 *
 * The tracker never blocks requests for explicitly-chosen providers by itself;
 * callers decide how to act on `isCoolingDown` / `tryAcquireProbe`.
 */
export class ProviderHealthTracker {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly degradeThreshold: number;
  private readonly openThreshold: number;
  private readonly openDurationMs: number;
  private readonly windowSize: number;
  private readonly maxCooldownMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(options?: {
    degradeThreshold?: number;
    openThreshold?: number;
    openDurationMs?: number;
    windowSize?: number;
    maxCooldownMs?: number;
    probeTimeoutMs?: number;
    now?: () => number;
  }) {
    this.degradeThreshold = options?.degradeThreshold ?? DEFAULT_DEGRADE_THRESHOLD;
    this.openThreshold = options?.openThreshold ?? DEFAULT_OPEN_THRESHOLD;
    this.openDurationMs = options?.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.maxCooldownMs = options?.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
    this.probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.now = options?.now ?? (() => Date.now());
  }

  private getOrCreate(providerId: string): ProviderRecord {
    let rec = this.records.get(providerId);
    if (!rec) {
      rec = {
        state: "healthy",
        consecutiveFailures: 0,
        openedAt: 0,
        cooldownUntil: 0,
        probeInFlight: false,
        probeStartedAt: 0,
        window: [],
      };
      this.records.set(providerId, rec);
    }
    return rec;
  }

  /**
   * Records a successful request. Returns true when this success brought the
   * provider back from an open / half-open circuit (i.e. the primary model can
   * be selected again).
   */
  recordSuccess(providerId: string): boolean {
    const rec = this.getOrCreate(providerId);
    const stateBefore = this.getState(providerId);
    const recovered = stateBefore === "open" || stateBefore === "half_open";
    rec.consecutiveFailures = 0;
    rec.window.push(true);
    if (rec.window.length > this.windowSize) rec.window.shift();
    rec.state = "healthy";
    rec.openedAt = 0;
    rec.cooldownUntil = 0;
    rec.probeInFlight = false;
    rec.probeStartedAt = 0;
    return recovered;
  }

  recordFailure(providerId: string, failure: ProviderFailure = {}): void {
    const rec = this.getOrCreate(providerId);
    const now = this.now();
    const stateBefore = this.getState(providerId);
    const isRateLimit = failure.code === "rate_limit_error";
    const retryAfterMs = failure.retryAfterMs;
    const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0;

    rec.consecutiveFailures++;
    rec.window.push(false);
    if (rec.window.length > this.windowSize) rec.window.shift();
    // A failed probe releases its slot; a subsequent probe can start after the
    // refreshed cooldown elapses.
    rec.probeInFlight = false;
    rec.probeStartedAt = 0;

    const cooldownMs = Math.min(
      Math.max(isRateLimit && hasRetryAfter ? (retryAfterMs as number) : this.openDurationMs, 1_000),
      this.maxCooldownMs,
    );
    rec.cooldownUntil = Math.max(rec.cooldownUntil, now + cooldownMs);

    if (isRateLimit || rec.consecutiveFailures >= this.openThreshold) {
      if (rec.state !== "open" || rec.openedAt === 0) {
        rec.state = "open";
        rec.openedAt = now;
      }
    } else if (rec.consecutiveFailures >= this.degradeThreshold) {
      if (rec.state === "healthy") {
        rec.state = "degraded";
      }
    }
    if (stateBefore === "half_open") {
      rec.state = "open";
      rec.openedAt = now;
    }
  }

  getState(providerId: string): ProviderHealthState {
    const rec = this.records.get(providerId);
    if (!rec) return "healthy";
    if (rec.state === "open") {
      const deadline = Math.max(rec.cooldownUntil, rec.openedAt + this.openDurationMs);
      if (this.now() >= deadline) {
        rec.state = "half_open";
        rec.probeInFlight = false;
        rec.probeStartedAt = 0;
      }
    }
    return rec.state;
  }

  /** True while the provider is cooling down and must not be selected. */
  isCoolingDown(providerId: string): boolean {
    return this.getState(providerId) === "open";
  }

  /** Milliseconds left before the circuit moves to half-open. */
  cooldownRemainingMs(providerId: string): number {
    const rec = this.records.get(providerId);
    if (!rec || this.getState(providerId) !== "open") return 0;
    const deadline = Math.max(rec.cooldownUntil, rec.openedAt + this.openDurationMs);
    return Math.max(0, deadline - this.now());
  }

  cooldownUntil(providerId: string): number {
    const rec = this.records.get(providerId);
    if (!rec) return 0;
    return Math.max(rec.cooldownUntil, rec.openedAt ? rec.openedAt + this.openDurationMs : 0);
  }

  /**
   * Attempts to reserve the single half-open probe slot. Healthy / degraded
   * providers are always allowed through; an open provider is never allowed;
   * a half-open provider allows exactly one probe until it succeeds, fails, or
   * the probe times out (so an aborted turn cannot wedge the circuit).
   */
  tryAcquireProbe(providerId: string): boolean {
    const state = this.getState(providerId);
    if (state === "open") return false;
    if (state !== "half_open") return true;
    const rec = this.getOrCreate(providerId);
    const now = this.now();
    if (rec.probeInFlight && now - rec.probeStartedAt < this.probeTimeoutMs) {
      return false;
    }
    rec.probeInFlight = true;
    rec.probeStartedAt = now;
    return true;
  }

  releaseProbe(providerId: string): void {
    const rec = this.records.get(providerId);
    if (!rec) return;
    rec.probeInFlight = false;
    rec.probeStartedAt = 0;
  }

  /**
   * Returns true when the provider should be skipped (circuit is open).
   * `half_open` allows one probe request through.
   */
  shouldSkip(providerId: string): boolean {
    return this.getState(providerId) === "open";
  }

  /**
   * Returns true when the provider is in a healthy or half_open (probing) state
   * and can accept requests.
   */
  isAvailable(providerId: string): boolean {
    return this.getState(providerId) !== "open";
  }

  getSuccessRate(providerId: string): number {
    const rec = this.records.get(providerId);
    if (!rec || rec.window.length === 0) return 1;
    return rec.window.filter(Boolean).length / rec.window.length;
  }

  reset(providerId: string): void {
    this.records.delete(providerId);
  }

  resetAll(): void {
    this.records.clear();
  }

  snapshot(): Map<string, ProviderHealthSnapshot> {
    const result = new Map<string, ProviderHealthSnapshot>();
    for (const [id, rec] of this.records) {
      result.set(id, {
        state: this.getState(id),
        successRate: this.getSuccessRate(id),
        consecutiveFailures: rec.consecutiveFailures,
        cooldownUntil: this.cooldownUntil(id),
        probeInFlight: rec.probeInFlight,
      });
    }
    return result;
  }
}
