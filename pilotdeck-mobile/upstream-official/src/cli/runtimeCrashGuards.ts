type TelemetryLike = {
  trackError(error: unknown, context: Record<string, unknown>): void;
};

export type RuntimeCrashGuardOptions = {
  telemetry: TelemetryLike;
  /** Called for an uncaughtException only; an unhandled rejection must not exit. */
  shutdownAndExit: (exitCode: number) => void | Promise<void>;
  /** Injectable for tests; defaults to the real process. */
  target?: { on(event: string, listener: (error: unknown) => void): unknown };
  error?: (message: string, error?: unknown) => void;
};

/**
 * Keeps a long-lived multi-session gateway alive when one session misbehaves.
 *
 * The gateway hosts many concurrent sessions and then parks forever, so the
 * CLI's original fail-fast policy was wrong for it: an unhandledRejection from
 * one turn's secondary promise (a compaction summary, a telemetry write) used
 * to call shutdownAndExit(1) and drop every live WebSocket, which the UI
 * reported as "PilotDeck gateway is unavailable." A rejection is now logged
 * with its full cause and the process keeps serving.
 *
 * The stack must reach the logs. During the 2026-11-05 investigation the
 * telemetry call swallowed it, leaving only "[telemetry] shutdown snapshot"
 * behind, which caused two rounds of misdiagnosis as a "clean exit".
 *
 * uncaughtException still exits: synchronous corruption is not survivable.
 */
export function installRuntimeCrashGuards(options: RuntimeCrashGuardOptions): void {
  const target = options.target ?? (process as unknown as RuntimeCrashGuardOptions["target"]);
  const error = options.error ?? ((message: string, cause?: unknown) => console.error(message, cause));

  target?.on("unhandledRejection", (reason) => {
    error("[pilotdeck] unhandledRejection (gateway stays alive):", reason);
    options.telemetry.trackError(reason, { module: "runtime", metadata: { source: "unhandledRejection" } });
  });

  target?.on("uncaughtException", (caught) => {
    error("[pilotdeck] uncaughtException (full stack):", caught);
    options.telemetry.trackError(caught, { module: "runtime", metadata: { source: "uncaughtException" } });
    void options.shutdownAndExit(1);
  });
}