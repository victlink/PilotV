import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InProcessGateway } from "../../gateway/client/InProcessGateway.js";
import type { AgentEvent, AgentSession } from "../../agent/index.js";
import type { SessionRouter } from "../../gateway/SessionRouter.js";
import type { GatewayEvent, GatewaySubmitTurnInput } from "../../gateway/protocol/types.js";
import { attachApprovalRuntime } from "./attachApprovalRuntime.js";

/**
 * B1 — the approval runtime is attached *once* per gateway instance.
 *
 * `createLocalGateway()` and `Gateway.createGateway()` both wire the runtime;
 * a second attachment must not create a second center, because every
 * decision would then be audited twice and the guard would run twice.
 */

const SESSION_KEY = "approval-attach-session";
const PROJECT_KEY = "approval-attach-project";
const CHANNEL_KEY = "web";

const TEST_PILOT_HOME = mkdtempSync(join(tmpdir(), "pilotdeck-approval-attach-"));
process.env.PILOT_HOME = TEST_PILOT_HOME;

after(() => {
  rmSync(TEST_PILOT_HOME, { recursive: true, force: true });
});

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type AuditEntry = {
  at: number;
  approvalId: string;
  action: string;
  actor?: string;
  actorSource?: string;
  detail?: string;
};

function hasEmitSink(gateway: InProcessGateway, sessionKey: string): boolean {
  const internals = gateway as unknown as {
    emitSinks?: Map<string, (event: GatewayEvent) => void>;
  };
  return internals.emitSinks?.has(sessionKey) ?? false;
}

/** A gateway whose turn parks, so events can be injected while it runs. */
async function createGateway(): Promise<{ gateway: InProcessGateway; release: () => void }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stubSession = {
    async *submit(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "turn_started", sessionId: SESSION_KEY, turnId: "turn-1" };
      await gate;
    },
    abort(): void {},
    async dispose(): Promise<void> {},
  };
  const stubRouter = {
    beginTurn: () => true,
    endTurn: () => {},
    activeTurnRunId: () => undefined,
    getOrCreate: async () => stubSession as unknown as AgentSession,
    close: async () => {},
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(stubRouter, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => "run-approval-attach",
  });
  void (async () => {
    for await (const _event of gateway.submitTurn({
      sessionKey: SESSION_KEY,
      channelKey: CHANNEL_KEY as GatewaySubmitTurnInput["channelKey"],
      message: "hello",
      projectKey: PROJECT_KEY,
    })) {
      // drain
    }
  })();
  for (let attempt = 0; attempt < 200 && !hasEmitSink(gateway, SESSION_KEY); attempt += 1) {
    await delay(5);
  }
  assert.ok(hasEmitSink(gateway, SESSION_KEY), "the stubbed turn must install its emit sink");
  return { gateway, release };
}

function readAudit(auditFilePath: string): AuditEntry[] {
  let raw = "";
  try {
    raw = readFileSync(auditFilePath, "utf8");
  } catch {
    raw = "";
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

test("B1/T2: attaching the approval runtime twice keeps one handle, one center and one audit trail", async () => {
  const { gateway, release } = await createGateway();
  const first = attachApprovalRuntime({ gateway, pilotHome: TEST_PILOT_HOME });
  const second = attachApprovalRuntime({ gateway, pilotHome: TEST_PILOT_HOME });

  // One handle per gateway instance.
  assert.equal(first, second, "a second attachment must return the very same handle");

  await first.ready;
  const runtime = first.current();
  assert.ok(runtime, "the approval runtime must be initialised");
  assert.equal(runtime, second.current(), "both handles must expose the same runtime");
  assert.equal(runtime.center, second.current()?.center, "both handles must expose the same center");

  // The request reaches the center exactly once.
  gateway.emitForSession(SESSION_KEY, {
    type: "permission_request",
    requestId: "req-attach-1",
    toolName: "bash",
    payload: { command: "ls" },
  });
  const record = runtime.center.findByRequestId("req-attach-1", SESSION_KEY);
  assert.ok(record, "the request must be registered in the center");
  assert.equal(runtime.center.listRecent().filter((entry) => entry.requestId === "req-attach-1").length, 1);

  // A refused decision is audited exactly once — two bridges would write two
  // "decision_blocked" entries.
  const refused = await gateway.permissionDecide({
    sessionKey: SESSION_KEY,
    requestId: "req-attach-unknown",
    decision: "allow",
    actor: "alice",
    origin: "im",
    channelKey: "feishu",
    chatId: "chat-1",
    actorSource: "channel_identity",
  });
  assert.equal(refused.delivered, false);
  assert.equal(refused.reason, "im_decision_without_record");

  await delay(50);
  const blocked = readAudit(runtime.center.auditFilePath).filter(
    (entry) => entry.action === "decision_blocked",
  );
  assert.equal(blocked.length, 1, "a refused decision must be audited exactly once");

  first.stop();
  release();
  await delay(20);
});
