/**
 * Subagent concurrency gate.
 *
 * Why this exists: the `agent` tool is marked `isConcurrencySafe: () => true`,
 * and `ConcurrentToolScheduler` runs every concurrency-safe call with a bare
 * `Promise.all`. So one model turn that asks for twelve subagents starts twelve
 * forked AgentLoops at once — twelve model streams, twelve tool registries, all
 * of them writing into the same workspace. That is not a performance tuning
 * knob; it is the shape of a request that gets us rate-limited by the provider,
 * and the rate-limit error then looks like "the model is broken".
 *
 * The gate is deliberately shared (one per parent session) rather than per
 * call site: a limit that each call site enforces on its own is N limits, and
 * the thing we actually need bounded is the total number of live subagents.
 *
 * Design notes:
 *   - The limit is read per acquire, not fixed at construction. Operators
 *     change it in settings while the process is running; a snapshot taken at
 *     startup would silently disagree with the UI.
 *   - `limit <= 0` means "no limit" rather than "nothing may run". A gate that
 *     blocks everything when misconfigured turns a config typo into an outage.
 *   - Waiters are served strictly in arrival order (FIFO). Not because fairness
 *     is elegant, but because "why hasn't my subagent started" needs a
 *     answerable answer: it is behind exactly the queue shown in `pending`.
 *   - Rejections are never swallowed: a waiter whose turn arrives but whose
 *     signal already aborted still dequeues the next waiter. A gate that loses
 *     a slot on cancellation deadlocks the session, which is far worse than the
 *     bug it prevents.
 */

export type SubagentSlot = { release(): void };

export type SubagentGate = {
  /** Resolves once a slot is free. Rejects with `Error` if aborted while queued. */
  acquire(options?: { signal?: AbortSignal }): Promise<SubagentSlot>;
  /**
   * Take a slot only if one is free right now; returns null otherwise.
   * Exists so a caller can tell "started immediately" from "had to queue" and
   * surface the difference — a subagent that sits silently in a queue looks
   * exactly like one that has hung.
   */
  tryAcquire(): SubagentSlot | null;
  /** How many subagents are running right now. */
  running(): number;
  /** How many callers are queued. */
  pending(): number;
  /** Current effective limit (0 = unlimited). */
  limit(): number;
  /**
   * Re-pump the queue after the limit got larger.
   *
   * A limit that only takes effect on the next acquire/release would leave an
   * already-queued subagent waiting until something else finishes, which reads
   * as "I raised the cap and nothing happened". Hosts call this from their
   * settings-change path.
   */
  refresh(): void;
};

export const DEFAULT_SUBAGENT_CONCURRENCY = 3;

export function resolveSubagentConcurrency(
  raw: unknown,
  fallback: number = DEFAULT_SUBAGENT_CONCURRENCY,
): number {
  // Env/settings hand us strings. Anything that is not a positive integer is
  // treated as "not configured" and falls back, rather than becoming NaN and
  // silently disabling the gate.
  // An empty/blank string means "not configured", NOT zero: treating it as 0
  // would turn an unset env var into "unlimited", i.e. the gate silently off.
  if (typeof raw === "string" && raw.trim() === "") return fallback;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (value === 0 || value === "0") return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1) return fallback;
  return n;
}

export function createSubagentGate(
  limitOrGetter: number | (() => number) = DEFAULT_SUBAGENT_CONCURRENCY,
): SubagentGate {
  const readLimit = typeof limitOrGetter === "function" ? limitOrGetter : () => limitOrGetter;
  let active = 0;
  const queue: { resolve(): void; reject(error: Error): void; cleanup(): void }[] = [];

  const dequeueReady = () => {
    const limit = readLimit();
    // Wake waiters one at a time and let each one claim the slot: a woken
    // waiter may already be aborted, and handing it a slot would waste it.
    while (queue.length > 0 && (limit <= 0 || active < limit)) {
      const next = queue.shift();
      if (!next) return;
      next.cleanup();
      active += 1;
      next.resolve();
      // One slot per loop iteration keeps `running()` honest when the limit
      // is exactly reached.
      if (limit > 0 && active >= limit) return;
    }
  };

  const makeRoom = () => {
    active = Math.max(0, active - 1);
    dequeueReady();
  };

  return {
    tryAcquire() {
      const limit = readLimit();
      if (limit <= 0 || active >= limit) return null;
      active += 1;
      return { release: makeRoom };
    },
    acquire(options: { signal?: AbortSignal } = {}) {
      // Checked before the fast path, not only in the queue branch: an already
      // cancelled caller must never start work just because a slot happened to
      // be free. That is the "user hit stop and the subagent ran anyway" bug.
      if (options.signal?.aborted) {
        return Promise.reject(new Error("subagent queue wait aborted"));
      }
      const limit = readLimit();
      if (limit <= 0 || active < limit) {
        active += 1;
        return Promise.resolve({ release: makeRoom });
      }
      const signal = options.signal;
      return new Promise<SubagentSlot>((resolve, reject) => {
        const entry = {
          resolve: () => resolve({ release: makeRoom }),
          reject,
          cleanup: () => {
            if (signal) signal.removeEventListener("abort", onAbort);
          },
        };
        const onAbort = () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          entry.cleanup();
          reject(new Error("subagent queue wait aborted"));
          // A cancelled waiter frees nothing, but its departure may have made
          // the queue shorter — nothing to reclaim. Still pump once in case a
          // release raced with this abort.
          dequeueReady();
        };
        if (signal?.aborted) {
          reject(new Error("subagent queue wait aborted"));
          return;
        }
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        queue.push(entry);
      });
    },
    refresh: () => dequeueReady(),
    running: () => active,
    pending: () => queue.length,
    limit: () => readLimit(),
  };
}
/**
 * Acquire a slot, telling the caller whether it had to wait.
 *
 * Lives here (rather than inline in the loop) for two reasons:
 *   - the queued/immediate/aborted branches are the part that can silently go
 *     wrong, and they need to be testable without standing up an AgentLoop;
 *   - the ordering rule is the real content: the queue notification must happen
 *     BEFORE anything announces the subagent as started, and a caller that
 *     cancels while queued must not have created any record of having run.
 *
 * `onQueued` fires exactly once, only when a wait was actually needed. It gets
 * the live queue depth so the UI can say "2 ahead of you" instead of "busy".
 */
export async function acquireSubagentSlot(
  gate: SubagentGate | undefined,
  args: {
    signal?: AbortSignal;
    onQueued?: (state: { running: number; pending: number; limit: number }) => void;
  } = {},
): Promise<SubagentSlot | null> {
  if (!gate) return null;
  const slot = gate.tryAcquire();
  if (slot) return slot;
  args.onQueued?.({ running: gate.running(), pending: gate.pending() + 1, limit: gate.limit() });
  // `+ 1` on pending: this caller is not enqueued until acquire() runs, and
  // "3 waiting" that means "3 waiting, including you" reads better in a UI than
  // a number that leaves out the one case the reader cares about.
  return gate.acquire({ signal: args.signal });
}
