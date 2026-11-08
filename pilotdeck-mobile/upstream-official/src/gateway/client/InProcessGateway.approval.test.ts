/**
 * `InProcessGateway` — unified approval center (统一授权中心) wiring regression.
 *
 * These tests drive the *real* production chain without starting an LLM turn:
 *
 *   permission hook ──emit──▶ gateway.emitForSession ──▶ submitTurn's
 *     `enqueueTurnEvent` ──▶ `notifyApprovalEventSinks` ──▶ approval event sinks
 *
 *   gateway.permissionDecide ──▶ `runApprovalGuards` ──▶ `permissionBus.consume`
 *     ──▶ `entry.resolve` ──▶ `notifyApprovalDecisionSinks` ──▶ approval decision sinks
 *
 * The turn is driven by a stub `SessionRouter` plus a stub `AgentSession` whose
 * `submit()` yields one event and then parks, so the per-session emit sink
 * stays installed for the whole test. No production code is modified.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InProcessGateway } from "./InProcessGateway.js";
import type {
  ApprovalDecisionGuard,
  ApprovalDecisionSink,
  ApprovalEventSink,
} from "./InProcessGateway.js";
import { createGatewayPermissionHook } from "../permission/createGatewayPermissionHook.js";
import { GatewayElicitationChannel } from "../elicitation/GatewayElicitationChannel.js";
import type { AgentEvent, AgentSession } from "../../agent/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import type {
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewaySubmitTurnInput,
} from "../protocol/types.js";

// Keep every read of the pilot home inside a throwaway directory.
const TEST_PILOT_HOME = mkdtempSync(join(tmpdir(), "pilotdeck-approval-test-"));
process.env.PILOT_HOME = TEST_PILOT_HOME;

after(() => {
  rmSync(TEST_PILOT_HOME, { recursive: true, force: true });
});

const SESSION_KEY = "approval-test-session";
const CHANNEL_KEY = "web";
const PROJECT_KEY = "approval-test-project";

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Harness = {
  gateway: InProcessGateway;
  /** Every gateway event the stubbed turn streamed out. */
  events: GatewayEvent[];
  /** Releases the stubbed agent turn. */
  release: () => void;
};

/**
 * Readiness probe — the per-session emit sink is a private field of
 * `InProcessGateway`; the permission hook needs it to be installed before it
 * emits, otherwise it denies immediately.
 */
function hasEmitSink(gateway: InProcessGateway, sessionKey: string): boolean {
  const internals = gateway as unknown as {
    emitSinks?: Map<string, (event: GatewayEvent) => void>;
  };
  return internals.emitSinks?.has(sessionKey) ?? false;
}

/**
 * Starts a real `InProcessGateway` whose turn is driven by stubs. The turn
 * stays open until `release()` is called so the test can inject events.
 */
async function startHarness(): Promise<Harness> {
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
    uuid: () => "run-approval-test",
  });

  const events: GatewayEvent[] = [];
  void (async () => {
    for await (const event of gateway.submitTurn({
      sessionKey: SESSION_KEY,
      channelKey: CHANNEL_KEY as GatewaySubmitTurnInput["channelKey"],
      message: "hello",
      projectKey: PROJECT_KEY,
    })) {
      events.push(event);
    }
  })();

  for (let attempt = 0; attempt < 200 && !hasEmitSink(gateway, SESSION_KEY); attempt += 1) {
    await delay(5);
  }
  assert.ok(
    hasEmitSink(gateway, SESSION_KEY),
    "the stubbed turn must install its per-session emit sink",
  );

  return { gateway, events, release };
}

/**
 * Raises a real `permission_request` through the production permission hook
 * and returns the (parked) hook promise.
 */
function raisePermissionRequest(
  gateway: InProcessGateway,
  requestId: string,
): Promise<unknown> {
  const hook = createGatewayPermissionHook({
    sessionKey: SESSION_KEY,
    bus: gateway.getPermissionBus(),
    emit: (event) => gateway.emitForSession(SESSION_KEY, event),
    permissionRules: [],
    uuid: () => requestId,
  });
  const hookPromise = Promise.resolve(hook({
    hookInput: {
      hookEventName: "PermissionRequest",
      sessionId: SESSION_KEY,
      transcriptPath: join(TEST_PILOT_HOME, "transcript.jsonl"),
      cwd: TEST_PILOT_HOME,
      toolName: "bash",
      toolCallId: `call-${requestId}`,
      toolInput: { command: "echo hi" },
    },
  }));
  // The hook parks on the permission bus until a decision arrives; a rejected
  // turn must not surface as an unhandled rejection.
  hookPromise.catch(() => undefined);
  return hookPromise;
}

test("approval event sink receives the permission_request raised by the turn", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.release());

  const received: Array<{
    sessionKey: string;
    channelKey: string;
    projectKey?: string | undefined;
    event: { type: string; [key: string]: unknown };
  }> = [];
  const sink: ApprovalEventSink = (input) => {
    received.push(input);
  };
  harness.gateway.addApprovalEventSink(sink);

  raisePermissionRequest(harness.gateway, "req-permission-1");
  await delay(0);

  assert.equal(received.length, 1);
  const notification = received[0]!;
  assert.equal(notification.sessionKey, SESSION_KEY);
  assert.equal(notification.channelKey, CHANNEL_KEY);
  assert.equal(notification.projectKey, PROJECT_KEY);
  assert.equal(notification.event.type, "permission_request");
  assert.equal(notification.event.requestId, "req-permission-1");
  assert.equal(notification.event.toolName, "bash");
  assert.deepEqual(notification.event.payload, { command: "echo hi" });

  // The same event must also reach the turn stream.
  assert.ok(
    harness.events.some((event) => event.type === "permission_request"),
    "the permission_request must still be streamed to the turn consumer",
  );

  harness.gateway.removeApprovalEventSink(sink);
});

test("a rejecting approval guard does not consume the pending decision", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.release());

  raisePermissionRequest(harness.gateway, "req-permission-2");
  await delay(0);
  assert.equal(
    harness.gateway.getPermissionBus().hasPending(SESSION_KEY, "req-permission-2"),
    true,
  );

  const guard: ApprovalDecisionGuard = async () => ({
    allowed: false,
    reason: "not authorised",
  });
  harness.gateway.addApprovalDecisionGuard(guard);

  const blocked = await harness.gateway.permissionDecide({
    sessionKey: SESSION_KEY,
    requestId: "req-permission-2",
    decision: "allow",
    actor: "alice",
    origin: "im",
  });
  assert.equal(blocked.delivered, false);
  // B2: the refusal reason of the guard is observable by the caller.
  assert.equal(blocked.reason, "not authorised");
  // The guard must short-circuit BEFORE the bus consumes the entry.
  assert.equal(
    harness.gateway.getPermissionBus().hasPending(SESSION_KEY, "req-permission-2"),
    true,
    "a rejected decision must leave the pending entry in place",
  );

  harness.gateway.removeApprovalDecisionGuard(guard);

  const allowed = await harness.gateway.permissionDecide({
    sessionKey: SESSION_KEY,
    requestId: "req-permission-2",
    decision: "allow",
    actor: "alice",
    origin: "im",
  });
  assert.deepEqual(allowed, { delivered: true });
});

test("the approval decision sink receives the applied decision", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.release());

  const decisions: GatewayPermissionDecisionInput[] = [];
  const sink: ApprovalDecisionSink = (input) => {
    decisions.push(input);
  };
  harness.gateway.addApprovalDecisionSink(sink);

  raisePermissionRequest(harness.gateway, "req-permission-3");
  await delay(0);

  const result = await harness.gateway.permissionDecide({
    sessionKey: SESSION_KEY,
    requestId: "req-permission-3",
    decision: "allow",
    actor: "alice",
    origin: "im",
    channelKey: CHANNEL_KEY,
    remember: true,
    reason: "looks safe",
  });
  assert.deepEqual(result, { delivered: true });

  assert.equal(decisions.length, 1);
  const decision = decisions[0]!;
  assert.equal(decision.sessionKey, SESSION_KEY);
  assert.equal(decision.requestId, "req-permission-3");
  assert.equal(decision.decision, "allow");
  assert.equal(decision.actor, "alice");
  assert.equal(decision.origin, "im");
  assert.equal(decision.remember, true);
  assert.equal(decision.reason, "looks safe");
  assert.equal(decision.channelKey, CHANNEL_KEY);

  harness.gateway.removeApprovalDecisionSink(sink);
});

test("an unknown request id reaches the approval decision sink as blocked", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.release());

  const calls: Array<{ blocked?: boolean; blockedReason?: string; requestId: string; actor?: string }> = [];
  const sink: ApprovalDecisionSink = (input) => {
    calls.push(input);
  };
  harness.gateway.addApprovalDecisionSink(sink);

  const result = await harness.gateway.permissionDecide({
    sessionKey: SESSION_KEY,
    requestId: "req-does-not-exist",
    decision: "deny",
    actor: "alice",
    origin: "web",
  });
  assert.deepEqual(result, { delivered: false });
  assert.deepEqual(calls, [{
    sessionKey: SESSION_KEY,
    requestId: "req-does-not-exist",
    decision: "deny",
    actor: "alice",
    origin: "web",
    blocked: true,
    blockedReason: "approval_request_not_found",
    kind: "permission",
  }]);

  harness.gateway.removeApprovalDecisionSink(sink);
});

test("elicitation_request also reaches the approval event sink", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.release());

  const received: Array<{
    sessionKey: string;
    channelKey: string;
    projectKey?: string | undefined;
    event: { type: string; [key: string]: unknown };
  }> = [];
  const sink: ApprovalEventSink = (input) => {
    received.push(input);
  };
  harness.gateway.addApprovalEventSink(sink);

  const channel = new GatewayElicitationChannel({
    sessionKey: SESSION_KEY,
    bus: harness.gateway.getElicitationBus(),
    emit: (event) => {
      harness.gateway.emitForSession(SESSION_KEY, event);
    },
    uuid: () => "req-elicit-1",
  });

  const answerPromise = channel.askUser({
    toolCallId: "call-elicit-1",
    toolName: "ask_user_question",
    questions: [
      {
        question: "Continue?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Continue the turn" }],
      },
    ],
  });
  answerPromise.catch(() => undefined);
  await delay(0);

  const elicitation = received.find(
    (notification) => notification.event.type === "elicitation_request",
  );
  assert.ok(elicitation, "the elicitation_request must reach the approval event sink");
  assert.equal(elicitation!.sessionKey, SESSION_KEY);
  assert.equal(elicitation!.channelKey, CHANNEL_KEY);
  assert.equal(elicitation!.projectKey, PROJECT_KEY);
  assert.equal(elicitation!.event.requestId, "req-elicit-1");
  assert.equal(elicitation!.event.toolName, "ask_user_question");

  const responded = await harness.gateway.respondElicitation({
    sessionKey: SESSION_KEY,
    requestId: "req-elicit-1",
    answer: { type: "answered", answers: { "Continue?": "Yes" } },
  });
  assert.deepEqual(responded, { delivered: true });

  harness.gateway.removeApprovalEventSink(sink);
});
