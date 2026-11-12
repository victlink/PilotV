/**
 * P0 "completeness gate": decide whether the agent loop should start another
 * model iteration after a `Stop` lifecycle hook produced messages.
 *
 * A `Stop` hook that returns messages (without blocking) is asking the model
 * to keep working within the same turn — typically "the stated done criteria
 * are not met yet, continue". Before this gate existed the messages were
 * pushed into context and the turn still ended, so the feedback never reached
 * the model.
 *
 * Bounded on two axes:
 *  - `MAX_STOP_HOOK_CONTINUATIONS`: most callers never set `maxTurns` (it is
 *    `undefined`), so a hook that always emits messages would otherwise loop
 *    forever. The hard cap keeps that impossible.
 *  - `maxTurns` (when set): the hook continuation consumes the same per-turn
 *    budget as tool-driven iterations.
 */
export const MAX_STOP_HOOK_CONTINUATIONS = 3;

export function shouldContinueAfterStopHook(options: {
  /** Messages returned by the `Stop` hook dispatch. */
  hookMessageCount: number;
  /** Stop-hook continuations already used in this turn. */
  continuationCount: number;
  /** Current turn iteration (1-based). */
  turnCount: number;
  /** Per-turn iteration budget; `undefined` means unbounded. */
  maxTurns?: number;
  /** Whether the run's abort signal is already fired. */
  aborted: boolean;
}): boolean {
  if (options.hookMessageCount <= 0) return false;
  if (options.aborted) return false;
  if (options.continuationCount >= MAX_STOP_HOOK_CONTINUATIONS) return false;
  if (options.maxTurns !== undefined && options.turnCount >= options.maxTurns) return false;
  return true;
}
