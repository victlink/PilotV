/**
 * `createApprovalBridge` — end-to-end regression of the unified approval
 * center guard (统一审批中心).
 *
 * Everything below drives the *real* production chain; the guard is never
 * mocked:
 *
 *   ImPermissionHelper.answerWithState
 *     → InProcessGateway.permissionDecide
 *       → runApprovalGuards  ← the real `createApprovalBridge` guard
 *       → GatewayPermissionBus.consume
 *     → the bridge decision sink → ApprovalCenter.resolve
 *
 * If the guard stops refusing IM answers without a center record, or starts
 * refusing answers it must accept, the cases below turn red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalCenter } from "../../approval/ApprovalCenter.js";
import { ApprovalRouter } from "../../approval/ApprovalRouter.js";
import { ImPermissionHelper } from "../../adapters/channel/protocol/ImPermissionHelper.js";
import { InProcessGateway } from "../client/InProcessGateway.js";
import type { SessionRouter } from "../SessionRouter.js";
import { createApprovalBridge, type ApprovalBridge } from "./createApprovalBridge.js";

// Keep every read of the pilot home inside a throwaway directory.
const TEST_PILOT_HOME = mkdtempSync(join(tmpdir(), "pilotdeck-approval-bridge-home-"));
process.env.PILOT_HOME = TEST_PILOT_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_PILOT_HOME, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

const SESSION_KEY = "session-bridge-1";
const CHAT_ID = "oc_chat_1";
const CHANNEL_KEY = "feishu";
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
  /** Every decision that reached the permission bus. */
  busDecisions: Array<{ requestId: string; decision: string }>;
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
  const storeDir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-bridge-"));
  const center = new ApprovalCenter({ storeDir });
  await center.init();

  const busDecisions: Array<{ requestId: string; decision: string }> = [];
  const stubRouter = {
    beginTurn: () => false,
    endTurn: () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(stubRouter, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => `approval-bridge-${busDecisions.length}`,
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
      // The center persists asynchronously; give the pending writes a moment
      // and retry the removal so a late write cannot fail the test.
      await delay(20);
      await rm(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** Put a pending permission into the gateway bus, like a tool call would. */
function registerBusEntry(
  harness: Harness,
  sessionKey: string,
  requestId: string,
  toolName = "read_file",
): void {
  harness.gateway.getPermissionBus().register(sessionKey, {
    requestId,
    toolCallId: `call-${requestId}`,
    toolName,
    resolve: (decision) => {
      harness.busDecisions.push({ requestId, decision: decision.decision });
    },
    reject: () => undefined,
  });
}

/** Register a pending approval record in the center. */
async function registerApproval(
  harness: Harness,
  options: {
    requestId: string;
    sessionKey?: string;
    toolName?: string;
    risk?: "low" | "medium" | "high" | "critical";
    originChannelKey?: string;
    bindings?: Array<{ channelKey: string; chatId?: string; approverIds?: string[] }>;
  },
) {
  return harness.center.register({
    kind: "permission",
    sessionKey: options.sessionKey ?? SESSION_KEY,
    requestId: options.requestId,
    toolName: options.toolName ?? "read_file",
    originChannelKey: options.originChannelKey ?? "web",
    risk: options.risk ?? "low",
    summary: "synthetic approval request",
    payloadPreview: "(synthetic)",
    bindings: options.bindings ?? [{ channelKey: CHANNEL_KEY, chatId: CHAT_ID }],
  });
}

test("an IM answer passes the real guard and approves the record", async () => {
  const harness = await createHarness();
  try {
    const record = await registerApproval(harness, { requestId: "req-e2e-allow" });
    registerBusEntry(harness, SESSION_KEY, "req-e2e-allow");

    const helper = new ImPermissionHelper({ channelKey: CHANNEL_KEY });
    helper.captureMirrored(CHAT_ID, {
      sessionKey: SESSION_KEY,
      requestId: "req-e2e-allow",
      toolName: "read_file",
      expiresAt: Date.now() + 60_000,
    });

    const answer = await helper.answerWithState(CHAT_ID, "1", harness.gateway, {
      actor: ACTOR,
    });

    // `canAdvance` is only true when the gateway reported `delivered`.
    assert.equal(answer?.canAdvance, true);
    assert.equal(harness.busDecisions.length, 1);
    assert.equal(harness.busDecisions[0]!.decision, "allow");

    // The center must have applied the decision (the bridge sink resolves it).
    const decided = await waitFor(
      () => {
        const current = harness.center.findByRequestId("req-e2e-allow", SESSION_KEY);
        return current && current.state === "approved" ? current : undefined;
      },
      "the approval record to become approved",
    );
    assert.equal(decided.state, "approved");
    assert.equal(decided.decision?.actor, ACTOR);
    assert.equal(decided.decision?.channelKey, CHANNEL_KEY);
    assert.equal(decided.decision?.chatId, CHAT_ID);
    assert.equal(decided.decision?.actorSource, "channel_identity");
    assert.equal(decided.id, record.id);

    // The audit must answer "who, from which channel, what was approved".
    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.find((entry) => entry.action === "decided") ? entries : undefined;
      },
      "the decided audit entry",
    );
    const decidedEntry = audit.find((entry) => entry.action === "decided")!;
    assert.equal(decidedEntry.approvalId, record.id);
    assert.equal(decidedEntry.actor, ACTOR);
    assert.equal(decidedEntry.channelKey, CHANNEL_KEY);
    assert.match(decidedEntry.detail ?? "", /allow:im:tool=read_file/);
  } finally {
    await harness.dispose();
  }
});

test("an IM answer without a center record is refused and audited", async () => {
  const harness = await createHarness();
  try {
    registerBusEntry(harness, SESSION_KEY, "req-e2e-orphan");

    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-e2e-orphan",
      decision: "allow",
      actor: ACTOR,
      origin: "im",
      channelKey: CHANNEL_KEY,
      chatId: CHAT_ID,
      actorSource: "channel_identity",
    });

    // B2: a refused decision reports *why* it was refused (contract §4).
    assert.equal(result.delivered, false);
    assert.equal(result.reason, "im_decision_without_record");
    // The decision never reached the permission bus.
    assert.equal(harness.busDecisions.length, 0);

    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.find((entry) => entry.action === "decision_blocked") ? entries : undefined;
      },
      "the decision_blocked audit entry",
    );
    const blocked = audit.find((entry) => entry.action === "decision_blocked")!;
    assert.equal(blocked.actor, ACTOR);
    assert.equal(blocked.channelKey, CHANNEL_KEY);
    assert.match(blocked.detail ?? "", /im_decision_without_record/);
  } finally {
    await harness.dispose();
  }
});

test("a mirrored high risk request cannot be answered from the chat channel", async () => {
  const harness = await createHarness();
  try {
    // The request was raised in the Web UI and mirrored into the chat: the
    // chat answer is a cross channel decision, so the risk gate applies.
    const record = await registerApproval(harness, {
      requestId: "req-e2e-high",
      risk: "high",
      originChannelKey: "web",
    });
    registerBusEntry(harness, SESSION_KEY, "req-e2e-high");

    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-e2e-high",
      decision: "allow",
      actor: ACTOR,
      origin: "im",
      channelKey: CHANNEL_KEY,
      chatId: CHAT_ID,
      actorSource: "channel_identity",
    });

    // B2: the risk gate is reported to the caller, not only audited.
    assert.equal(result.delivered, false);
    assert.equal(result.reason, "risk_not_im_decidable");
    assert.equal(harness.busDecisions.length, 0);

    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.find((entry) => entry.action === "decision_blocked") ? entries : undefined;
      },
      "the decision_blocked audit entry",
    );
    const blocked = audit.find((entry) => entry.action === "decision_blocked")!;
    assert.equal(blocked.approvalId, record.id);
    assert.match(blocked.detail ?? "", /risk_not_im_decidable/);

    // The request stays pending: a refused answer must not consume it.
    assert.equal(harness.center.findByRequestId("req-e2e-high", SESSION_KEY)?.state, "pending");
  } finally {
    await harness.dispose();
  }
});

test("a mirrored critical request cannot be answered from the chat channel", async () => {
  const harness = await createHarness();
  try {
    await registerApproval(harness, {
      requestId: "req-e2e-critical",
      risk: "critical",
      originChannelKey: "web",
    });
    registerBusEntry(harness, SESSION_KEY, "req-e2e-critical");

    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-e2e-critical",
      decision: "allow",
      actor: ACTOR,
      origin: "im",
      channelKey: CHANNEL_KEY,
      chatId: CHAT_ID,
    });

    assert.equal(result.delivered, false);
    assert.equal(result.reason, "risk_not_im_decidable");
    assert.equal(harness.busDecisions.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("a high risk request raised by the channel itself stays in its own prompt", async () => {
  const harness = await createHarness();
  try {
    // The channel raised the request itself: the numbered 1/2/0 prompt *is*
    // the native authorization interface, so the chat answer is allowed even
    // though the risk is high.
    const record = await registerApproval(harness, {
      requestId: "req-e2e-native",
      risk: "high",
      originChannelKey: CHANNEL_KEY,
    });
    registerBusEntry(harness, SESSION_KEY, "req-e2e-native");

    const helper = new ImPermissionHelper({ channelKey: CHANNEL_KEY });
    helper.captureMirrored(CHAT_ID, {
      sessionKey: SESSION_KEY,
      requestId: "req-e2e-native",
      toolName: "read_file",
      expiresAt: Date.now() + 60_000,
    });

    const answer = await helper.answerWithState(CHAT_ID, "1", harness.gateway, {
      actor: ACTOR,
    });

    assert.equal(answer?.canAdvance, true);
    assert.equal(harness.busDecisions.length, 1);

    const decided = await waitFor(
      () => {
        const current = harness.center.findByRequestId("req-e2e-native", SESSION_KEY);
        return current && current.state === "approved" ? current : undefined;
      },
      "the native high risk record to become approved",
    );
    assert.equal(decided.id, record.id);
  } finally {
    await harness.dispose();
  }
});

test("a web answer is not affected by the IM risk gate", async () => {
  const harness = await createHarness();
  try {
    await registerApproval(harness, {
      requestId: "req-e2e-web",
      risk: "critical",
      originChannelKey: "web",
    });
    registerBusEntry(harness, SESSION_KEY, "req-e2e-web");

    const result = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: "req-e2e-web",
      decision: "allow",
      actor: "web-user",
      origin: "web",
      actorSource: "client_reported",
    });

    assert.deepEqual(result, { delivered: true });
    assert.equal(harness.busDecisions.length, 1);

    const decided = await waitFor(
      () => {
        const current = harness.center.findByRequestId("req-e2e-web", SESSION_KEY);
        return current && current.state === "approved" ? current : undefined;
      },
      "the web record to become approved",
    );
    assert.equal(decided.decision?.source, "web");
    assert.equal(decided.decision?.actorSource, "client_reported");
  } finally {
    await harness.dispose();
  }
});

test("ending the turn cancels the pending approvals of that session only", async () => {
  const harness = await createHarness();
  try {
    const pending = await registerApproval(harness, { requestId: "req-e2e-cancel" });
    const other = await registerApproval(harness, {
      requestId: "req-e2e-other",
      sessionKey: "session-bridge-2",
    });
    // A record that was already decided must survive the cancellation.
    await harness.center.resolve({
      requestId: "req-e2e-decided",
      sessionKey: SESSION_KEY,
      decision: "allow",
      actor: ACTOR,
      source: "web",
    });
    const decidedRecord = await registerApproval(harness, { requestId: "req-e2e-decided" });
    await harness.center.resolve({
      approvalId: decidedRecord.id,
      decision: "deny",
      actor: ACTOR,
      source: "web",
    });

    const cancelled = await harness.center.cancelSession(SESSION_KEY, "turn_ended");

    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]!.id, pending.id);
    assert.equal(harness.center.get(pending.id)?.state, "cancelled");
    assert.equal(harness.center.get(pending.id)?.reason, "turn_ended");
    // Another session is untouched.
    assert.equal(harness.center.get(other.id)?.state, "pending");
    // An already decided record is not rewritten.
    assert.equal(harness.center.get(decidedRecord.id)?.state, "denied");

    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.find((entry) => entry.action === "cancelled") ? entries : undefined;
      },
      "the cancelled audit entry",
    );
    const cancelledEntry = audit.find((entry) => entry.action === "cancelled")!;
    assert.equal(cancelledEntry.approvalId, pending.id);
    assert.equal(cancelledEntry.detail, "turn_ended");
  } finally {
    await harness.dispose();
  }
});
