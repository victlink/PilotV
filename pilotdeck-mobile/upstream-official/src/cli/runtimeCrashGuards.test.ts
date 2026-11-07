import assert from "node:assert/strict";
import { test } from "node:test";
import { installRuntimeCrashGuards } from "./runtimeCrashGuards.js";

// Regression guard for defect B in docs/HANDOFF-Windows-20261105.md section 2.1.
// The gateway serves many concurrent sessions and then parks forever, but it
// inherited the CLI's fail-fast policy: an unhandledRejection from one turn's
// secondary promise called shutdownAndExit(1), ending every live WebSocket and
// surfacing as "PilotDeck gateway is unavailable." in the UI.

type Listener = (error: unknown) => void;

function fakeProcess() {
  const listeners = new Map<string, Listener[]>();
  return {
    target: {
      on(event: string, listener: Listener) {
        const existing = listeners.get(event) ?? [];
        listeners.set(event, [...existing, listener]);
        return this;
      },
    },
    emit(event: string, error: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(error);
    },
    registered: () => [...listeners.keys()],
  };
}

function harness() {
  const proc = fakeProcess();
  const tracked: unknown[] = [];
  const logged: string[] = [];
  let exitCode: number | undefined;
  installRuntimeCrashGuards({
    target: proc.target,
    telemetry: { trackError: (error) => tracked.push(error) },
    shutdownAndExit: (code) => {
      exitCode = code;
    },
    error: (message, cause) => logged.push(`${message} ${String(cause)}`),
  });
  return { proc, tracked, logged, exitCode: () => exitCode };
}

test("an unhandled rejection does not shut the gateway down", () => {
  const h = harness();
  const reason = new Error("compaction summary failed");

  assert.doesNotThrow(() => h.proc.emit("unhandledRejection", reason));
  assert.equal(h.exitCode(), undefined, "a rejection must never trigger shutdownAndExit");
  assert.deepEqual(h.tracked, [reason], "telemetry must still see it");
});

test("an unhandled rejection logs the full cause, not just a snapshot", () => {
  const h = harness();
  const reason = new Error("telemetry write failed");
  h.proc.emit("unhandledRejection", reason);

  assert.equal(h.logged.length, 1, "the cause must be logged");
  assert.ok(h.logged[0].includes("unhandledRejection"));
  assert.ok(h.logged[0].includes("telemetry write failed"), `stack lost: ${h.logged[0]}`);
});

test("an uncaught exception still exits with code 1", () => {
  const h = harness();
  const error = new Error("stream corrupted");
  h.proc.emit("uncaughtException", error);

  assert.equal(h.exitCode(), 1, "a synchronous failure must remain fatal");
  assert.ok(h.logged[0].includes("stream corrupted"), "full stack must be logged");
});

test("both guards are installed", () => {
  const h = harness();
  assert.deepEqual(h.proc.registered().sort(), ["uncaughtException", "unhandledRejection"]);
});