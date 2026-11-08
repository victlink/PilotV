/**
 * `createApprovalBridge` — hardening of the unified approval center
 * (统一审批中心, contract §3).
 *
 * Three properties are locked here:
 *
 *  1. A chat answer may never become an *unlimited* (session wide)
 *     authorization for a `high`/`critical` request (A3).
 *  2. A stopped bridge must not keep guarding or auditing the gateway (A4).
 *  3. An approval that nobody answered must expire and release the pending
 *     turn instead of hanging forever (A6).
 *
 * The IM answer is simulated at the gateway boundary: the decision is
 * handed to the real `InProcessGateway.permissionDecide` with
 * `origin: "im"`, exactly like `ImPermissionHelper` does. That is a
 * simulation of the channel round trip, not a real Feishu/WeCom round trip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalCenter } from "../../approval/ApprovalCenter.js";
import { ApprovalRouter } from "../../approval/ApprovalRouter.js";
import { InProcessGateway } from "../client/InProcessGateway.js";
import type { SessionRouter } from "../SessionRouter.js";
import { createApprovalBridge, type ApprovalBridge } from "./createApprovalBridge.js";

const SESSION_KEY = "session-hardening-1";
const CHANNEL_KEY = "feishu";
const CHAT_ID = "oc_hardening_1";
const ACTOR = "ou_alice";

type AuditEntry = {
  at: number;
  approvalId: string;
  action: string;
  actor?: string;
  actorSource?: string;
  channelKey?: string;
  detail?: string;
};

type Harness = {
  center: ApprovalCenter;
  gateway: InProcessGateway;
  bridge: ApprovalBridge;
  /** Advances the clock the center uses for the TTL. */
  advanceClock(ms: number): void;
  /** Every decision that reached the permission bus. */
  busDecisions: Array<{ requestId: string; decision: string; remember?: boolean }>;
  audit(): Promise<AuditEntry[]>;
  dispose(): Promise<void>;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

async function createHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-hardening-"));
  let clock = Date.now();
  const center = new ApprovalCenter({ storeDir, now: () => clock });
  await center.init();

  const busDecisions: Array<{ requestId: string; decision: string; remember?: boolean }> = [];
  const stubRouter = {
    beginTurn: () => false,
    endTurn: () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(stubRouter, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => `approval-hardening-${busDecisions.length}`,
  });
  const router = new ApprovalRouter({
    center,
    gateway,
    resolveChannel: () => undefined,
    bindingConfigs: () => [],
  });
  const bridge = createApprovalBridge({ center, router, gateway });

  return {
    center,
    gateway,
    bridge,
    advanceClock: (ms: number) => {
      clock += ms;
    },
    busDecisions,
    audit: async () => {
      const raw = await readFile(center.auditFilePath, "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditEntry);
    },
    dispose: async () => {
      bridge.stop();
      await delay(20);
      await rm(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** Put a pending permission into the gateway bus, like a tool call would. */
function registerBusEntry(harness: Harness, requestId: string, toolName = "bash"): void {
  harness.gateway.getPermissionBus().register(SESSION_KEY, {
    requestId,
    toolCallId: `call-${requestId}`,
    toolName,
    resolve: (decision) => {
      harness.busDecisions.push({
        requestId,
        decision: decision.decision,
        remember: decision.remember,
      });
    },
    reject: () => undefined,
  });
}

/** Register a pending approval record in the center. */
async function registerApproval(
  harness: Harness,
  options: {
    requestId: string;
    toolName?: string;
    risk?: "low" | "medium" | "high" | "critical";
    originChannelKey?: string;
    ttlMs?: number;
  },
) {
  return harness.center.register({
    kind: "permission",
    sessionKey: SESSION_KEY,
    requestId: options.requestId,
    toolName: options.toolName ?? "bash",
    originChannelKey: options.originChannelKey ?? CHANNEL_KEY,
    risk: options.risk ?? "high",
    summary: "synthetic approval request",
    payloadPreview: "(synthetic)",
    bindings: [{ channelKey: CHANNEL_KEY, chatId: CHAT_ID }],
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });
}

/** An IM answer, as the channel adapter hands it to the gateway. */
function imDecision(requestId: string, remember: boolean) {
  return {
    sessionKey: SESSION_KEY,
    requestId,
    decision: "allow" as const,
    remember,
    actor: ACTOR,
    origin: "im" as const,
    channelKey: CHANNEL_KEY,
    chatId: CHAT_ID,
    actorSource: "channel_identity" as const,
  };
}

/* ------------------------------------------------------------------ *
 * A3 — no session wide authorization from a chat channel
 * ------------------------------------------------------------------ */

test("a native IM session grant is refused for a high risk request", async () => {
  const harness = await createHarness();
  try {
    // The channel raised the request itself (the agent asked from Feishu),
    // so this is the *native* path, not a cross channel decision.
    const record = await registerApproval(harness, {
      requestId: "req-session-grant-high",
      risk: "high",
      originChannelKey: CHANNEL_KEY,
    });
    registerBusEntry(harness, "req-session-grant-high");

    const result = await harness.gateway.permissionDecide(
      imDecision("req-session-grant-high", true),
    );

    assert.equal(result.delivered, false);
    assert.equal(result.reason, "im_session_authorization_not_allowed_for_high_risk");
    assert.equal(harness.busDecisions.length, 0, "the tool call must stay undecided");

    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.find((entry) => entry.action === "decision_blocked") ? entries : undefined;
      },
      "the decision_blocked audit entry",
    );
    const blocked = audit.find((entry) => entry.action === "decision_blocked")!;
    assert.equal(blocked.approvalId, record.id);
    assert.equal(blocked.actor, ACTOR);
    assert.equal(blocked.channelKey, CHANNEL_KEY);
    assert.match(
      blocked.detail ?? "",
      /im_session_authorization_not_allowed_for_high_risk/,
      `unexpected blocked reason: ${blocked.detail}`,
    );

    // The request stays pending: a refused answer must not consume it.
    assert.equal(harness.center.findByRequestId("req-session-grant-high", SESSION_KEY)?.state, "pending");
  } finally {
    await harness.dispose();
  }
});

test("a native IM session grant is refused for a critical request", async () => {
  const harness = await createHarness();
  try {
    await registerApproval(harness, {
      requestId: "req-session-grant-critical",
      risk: "critical",
      originChannelKey: CHANNEL_KEY,
    });
    registerBusEntry(harness, "req-session-grant-critical");

    const result = await harness.gateway.permissionDecide(
      imDecision("req-session-grant-critical", true),
    );

    assert.equal(result.delivered, false);
    assert.equal(result.reason, "im_session_authorization_not_allowed_for_high_risk");
    assert.equal(harness.busDecisions.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("a native one shot IM answer for a high risk request stays allowed", async () => {
  const harness = await createHarness();
  try {
    // Contract §1: the same request may be answered from the Web UI *or*
    // from Feishu/WeCom. Only the session wide grant is closed.
    await registerApproval(harness, {
      requestId: "req-one-shot-high",
      risk: "high",
      originChannelKey: CHANNEL_KEY,
    });
    registerBusEntry(harness, "req-one-shot-high");

    const result = await harness.gateway.permissionDecide(
      imDecision("req-one-shot-high", false),
    );

    assert.deepEqual(result, { delivered: true });
    assert.equal(harness.busDecisions.length, 1);
    assert.equal(harness.busDecisions[0]!.decision, "allow");
    assert.equal(harness.busDecisions[0]!.remember, false);
  } finally {
    await harness.dispose();
  }
});

test("a native IM session grant stays allowed for a medium risk request", async () => {
  const harness = await createHarness();
  try {
    await registerApproval(harness, {
      requestId: "req-session-grant-medium",
      risk: "medium",
      originChannelKey: CHANNEL_KEY,
    });
    registerBusEntry(harness, "req-session-grant-medium");

    const result = await harness.gateway.permissionDecide(
      imDecision("req-session-grant-medium", true),
    );

    assert.deepEqual(result, { delivered: true });
    assert.equal(harness.busDecisions.length, 1);
    assert.equal(harness.busDecisions[0]!.remember, true);
  } finally {
    await harness.dispose();
  }
});

/* ------------------------------------------------------------------ *
 * A4 — a stopped bridge neither guards nor audits
 * ------------------------------------------------------------------ */

test("after stop() the gateway runs neither the guard nor the decision sink", async () => {
  const harness = await createHarness();
  try {
    const record = await registerApproval(harness, {
      requestId: "req-after-stop",
      risk: "high",
      originChannelKey: CHANNEL_KEY,
    });
    registerBusEntry(harness, "req-after-stop");

    // Before the stop the guard runs: the IM decision without a matching
    // center record is refused and audited.
    const refused = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-not-registered",
      decision: "allow",
      actor: ACTOR,
      origin: "im",
      channelKey: CHANNEL_KEY,
      chatId: CHAT_ID,
      actorSource: "channel_identity",
    });
    assert.equal(refused.delivered, false);
    assert.equal(refused.reason, "im_decision_without_record");
    await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.some((entry) => entry.action === "decision_blocked") ? entries : undefined;
      },
      "the decision_blocked audit entry",
    );

    harness.bridge.stop();

    const auditBefore = (await harness.audit()).length;

    // After the stop the guard is gone: the decision reaches the bus.
    const delivered = await harness.gateway.permissionDecide(
      imDecision("req-after-stop", false),
    );
    assert.deepEqual(delivered, { delivered: true });
    assert.equal(harness.busDecisions.length, 1);
    assert.equal(harness.busDecisions[0]!.requestId, "req-after-stop");

    // The decision sink is gone as well: the center did not resolve the
    // record and no new audit entry appeared.
    await delay(50);
    assert.equal(
      harness.center.findByRequestId("req-after-stop", SESSION_KEY)?.state,
      "pending",
      "a stopped bridge must not resolve records",
    );
    assert.equal((await harness.audit()).length, auditBefore, "a stopped bridge must not audit");
    assert.equal(harness.center.get(record.id)?.state, "pending");
  } finally {
    await harness.dispose();
  }
});

test("stop() is idempotent and start() restores the guard", async () => {
  const harness = await createHarness();
  try {
    harness.bridge.stop();
    harness.bridge.stop();

    registerBusEntry(harness, "req-restart");
    const delivered = await harness.gateway.permissionDecide(
      imDecision("req-restart", false),
    );
    assert.deepEqual(delivered, { delivered: true });

    harness.bridge.start();

    // The guard is back: an IM decision for an unknown request is refused.
    const refused = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-not-registered",
      decision: "allow",
      actor: ACTOR,
      origin: "im",
      channelKey: CHANNEL_KEY,
      chatId: CHAT_ID,
      actorSource: "channel_identity",
    });
    assert.equal(refused.delivered, false);
    assert.equal(refused.reason, "im_decision_without_record");
  } finally {
    await harness.dispose();
  }
});

/* ------------------------------------------------------------------ *
 * A6 — an expired approval releases the pending turn
 * ------------------------------------------------------------------ */

test("an expired approval is denied and releases the pending turn", async () => {
  const harness = await createHarness();
  try {
    const record = await registerApproval(harness, {
      requestId: "req-expired",
      risk: "high",
      originChannelKey: CHANNEL_KEY,
      ttlMs: 1_000,
    });
    registerBusEntry(harness, "req-expired");

    // Nobody answered: the TTL elapses.
    harness.advanceClock(5_000);

    // The sweeper expires the record and denies it, so the pending tool
    // call is resolved and the turn may continue.
    await harness.bridge.sweep();

    assert.equal(
      harness.center.findByRequestId("req-expired", SESSION_KEY)?.state,
      "expired",
      "the expired approval must be marked as expired",
    );
    assert.equal(harness.busDecisions.length, 1);
    assert.equal(harness.busDecisions[0]!.requestId, "req-expired");
    assert.equal(harness.busDecisions[0]!.decision, "deny");
    assert.equal(
      harness.gateway.getPermissionBus().hasPending(SESSION_KEY, "req-expired"),
      false,
      "the pending permission request must be released",
    );
  } finally {
    await harness.dispose();
  }
});

test("expireDue() marks a pending approval as expired", async () => {
  const harness = await createHarness();
  try {
    const record = await registerApproval(harness, {
      requestId: "req-expire-due",
      risk: "high",
      originChannelKey: CHANNEL_KEY,
      ttlMs: 1_000,
    });
    registerBusEntry(harness, "req-expire-due");

    harness.advanceClock(5_000);
    const expired = await harness.center.expireDue();

    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.id, record.id);
    assert.equal(expired[0]!.state, "expired");
    assert.equal(
      harness.center.findByRequestId("req-expire-due", SESSION_KEY)?.state,
      "expired",
    );
  } finally {
    await harness.dispose();
  }
});

test("an unbound IM denial is refused", async () => {
  const harness = await createHarness();
  try {
    await registerApproval(harness, { requestId: "req-deny-unbound", risk: "medium", originChannelKey: "feishu" });
    registerBusEntry(harness, "req-deny-unbound");
    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-deny-unbound",
      decision: "deny",
      actor: ACTOR,
      origin: "im",
      channelKey: "wecom",
      chatId: CHAT_ID,
      actorSource: "channel_identity",
    });
    assert.deepEqual(result, { delivered: false, reason: "channel_not_bound" });
    assert.equal(harness.busDecisions.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("an unknown web decision is audited as not delivered", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-unknown-audit",
      decision: "deny",
      actor: "web-user",
      origin: "web",
      actorSource: "client_reported",
    });
    assert.deepEqual(result, { delivered: false });
    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.find((entry) => entry.approvalId === "req-unknown-audit") ? entries : undefined;
      },
      "the unknown request audit entry",
    );
    const blocked = audit.find((entry) => entry.approvalId === "req-unknown-audit")!;
    assert.equal(blocked.action, "decision_blocked");
    assert.equal(blocked.actor, "web-user");
    assert.equal(blocked.detail, "approval_request_not_found:tool=unknown");
  } finally {
    await harness.dispose();
  }
});

test("a bound IM denial still resolves the pending request", async () => {
  const harness = await createHarness();
  try {
    await registerApproval(harness, { requestId: "req-deny-bound", risk: "high", originChannelKey: "wecom" });
    registerBusEntry(harness, "req-deny-bound");
    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-deny-bound",
      decision: "deny",
      actor: ACTOR,
      origin: "im",
      channelKey: CHANNEL_KEY,
      chatId: CHAT_ID,
      actorSource: "channel_identity",
    });
    assert.deepEqual(result, { delivered: true });
    assert.equal(harness.busDecisions[0]!.decision, "deny");
  } finally {
    await harness.dispose();
  }
});

test("a web denial keeps its existing pass-through behavior", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-web-unknown-deny",
      decision: "deny",
      origin: "web",
    });
    assert.deepEqual(result, { delivered: false });
  } finally {
    await harness.dispose();
  }
});
