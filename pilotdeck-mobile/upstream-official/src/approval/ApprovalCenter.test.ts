/**
 * `ApprovalCenter` — binding rules for answers that arrive from a chat
 * channel (contract §4/§5).
 *
 * The cases below pin the *rejection reasons*, not just "rejected": the
 * reason is what the audit trail records, so a silently different reason
 * would hide why an answer was refused.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalCenter } from "./ApprovalCenter.js";
import type { ApprovalBinding, ApprovalRecord } from "./types.js";

async function createCenter(): Promise<{ center: ApprovalCenter; dispose: () => Promise<void> }> {
  const storeDir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-center-"));
  const center = new ApprovalCenter({ storeDir });
  await center.init();
  return {
    center,
    dispose: () => rm(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

function makeRecord(bindings: ApprovalBinding[]): ApprovalRecord {
  return {
    id: "approval-1",
    kind: "permission",
    sessionKey: "session-1",
    requestId: "req-1",
    toolName: "read_file",
    originChannelKey: "web",
    risk: "low",
    state: "pending",
    summary: "synthetic",
    payloadPreview: "(synthetic)",
    payloadRedacted: false,
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    bindings,
    deliveries: [],
  };
}

test("an IM answer without a channel is refused", () => {
  const record = makeRecord([{ channelKey: "feishu", chatId: "oc_1" }]);
  assert.equal(record.bindings.length, 1);
  assert.equal(
    new ApprovalCenter({ storeDir: "/tmp/unused" }).checkImBinding(record, { chatId: "oc_1" }),
    "im_decision_without_channel",
  );
});

test("an IM answer from an unbound channel is refused", () => {
  const record = makeRecord([{ channelKey: "feishu", chatId: "oc_1" }]);
  assert.equal(
    new ApprovalCenter({ storeDir: "/tmp/unused" }).checkImBinding(record, {
      channelKey: "wecom",
      chatId: "oc_1",
    }),
    "channel_not_bound",
  );
});

test("an IM answer from the wrong chat of a bound channel is refused", () => {
  const record = makeRecord([{ channelKey: "feishu", chatId: "oc_1" }]);
  assert.equal(
    new ApprovalCenter({ storeDir: "/tmp/unused" }).checkImBinding(record, {
      channelKey: "feishu",
      chatId: "oc_other",
    }),
    "chat_not_bound",
  );
});

test("an IM answer without a chat is refused when the binding names one", () => {
  const record = makeRecord([{ channelKey: "feishu", chatId: "oc_1" }]);
  assert.equal(
    new ApprovalCenter({ storeDir: "/tmp/unused" }).checkImBinding(record, {
      channelKey: "feishu",
    }),
    "im_decision_without_chat",
  );
});

test("an IM answer from the bound chat passes", () => {
  const record = makeRecord([{ channelKey: "feishu", chatId: "oc_1" }]);
  assert.equal(
    new ApprovalCenter({ storeDir: "/tmp/unused" }).checkImBinding(record, {
      channelKey: "feishu",
      chatId: "oc_1",
    }),
    undefined,
  );
});

test("a binding without a chat accepts an answer from any chat of that channel", () => {
  const record = makeRecord([{ channelKey: "feishu" }]);
  assert.equal(
    new ApprovalCenter({ storeDir: "/tmp/unused" }).checkImBinding(record, {
      channelKey: "feishu",
      chatId: "oc_whatever",
    }),
    undefined,
  );
  assert.equal(
    new ApprovalCenter({ storeDir: "/tmp/unused" }).checkImBinding(record, {
      channelKey: "feishu",
    }),
    undefined,
  );
});

test("an answer from an approver that is not on the whitelist is refused", () => {
  const record = makeRecord([
    { channelKey: "feishu", chatId: "oc_1", approverIds: ["ou_alice", "ou_bob"] },
  ]);
  const center = new ApprovalCenter({ storeDir: "/tmp/unused" });
  assert.equal(
    center.checkImBinding(record, {
      channelKey: "feishu",
      chatId: "oc_1",
      actor: "ou_mallory",
    }),
    "approver_not_allowed",
  );
});

test("an answer without an actor is refused when a whitelist exists", () => {
  const record = makeRecord([
    { channelKey: "feishu", chatId: "oc_1", approverIds: ["ou_alice"] },
  ]);
  const center = new ApprovalCenter({ storeDir: "/tmp/unused" });
  assert.equal(
    center.checkImBinding(record, { channelKey: "feishu", chatId: "oc_1" }),
    "approver_not_allowed",
  );
  assert.equal(
    center.checkImBinding(record, { channelKey: "feishu", chatId: "oc_1", actor: "   " }),
    "approver_not_allowed",
  );
});

test("an answer from a listed approver passes", () => {
  const record = makeRecord([
    { channelKey: "feishu", chatId: "oc_1", approverIds: ["ou_alice", "ou_bob"] },
  ]);
  const center = new ApprovalCenter({ storeDir: "/tmp/unused" });
  assert.equal(
    center.checkImBinding(record, {
      channelKey: "feishu",
      chatId: "oc_1",
      actor: "ou_bob",
    }),
    undefined,
  );
});

test("a denied decision never escalates: the record ends up denied", async () => {
  const { center, dispose } = await createCenter();
  try {
    const record = await center.register({
      kind: "permission",
      sessionKey: "session-1",
      requestId: "req-1",
      toolName: "read_file",
      originChannelKey: "web",
      risk: "critical",
      summary: "synthetic",
      payloadPreview: "(synthetic)",
      bindings: [{ channelKey: "feishu", chatId: "oc_1" }],
    });

    // A denial from an unbound channel is still accepted: refusing can never
    // escalate privileges.
    const result = await center.resolve({
      requestId: "req-1",
      sessionKey: "session-1",
      decision: "deny",
      actor: "ou_mallory",
      source: "im",
      channelKey: "wecom",
    });

    assert.equal(result.applied, true);
    assert.equal(center.get(record.id)?.state, "denied");
    assert.equal(center.get(record.id)?.decision?.source, "im");
  } finally {
    await dispose();
  }
});

test("an allow from an unbound channel is rejected and the record stays pending", async () => {
  const { center, dispose } = await createCenter();
  try {
    const record = await center.register({
      kind: "permission",
      sessionKey: "session-1",
      requestId: "req-1",
      toolName: "read_file",
      originChannelKey: "web",
      risk: "low",
      summary: "synthetic",
      payloadPreview: "(synthetic)",
      bindings: [{ channelKey: "feishu", chatId: "oc_1" }],
    });

    const result = await center.resolve({
      requestId: "req-1",
      sessionKey: "session-1",
      decision: "allow",
      actor: "ou_alice",
      source: "im",
      channelKey: "wecom",
      chatId: "oc_1",
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, "channel_not_bound");
    assert.equal(center.get(record.id)?.state, "pending");
  } finally {
    await dispose();
  }
});

test("an allow from a channel that raised the request itself skips the binding", async () => {
  const { center, dispose } = await createCenter();
  try {
    const record = await center.register({
      kind: "permission",
      sessionKey: "session-1",
      requestId: "req-1",
      toolName: "read_file",
      originChannelKey: "feishu",
      risk: "high",
      summary: "synthetic",
      payloadPreview: "(synthetic)",
      bindings: [{ channelKey: "feishu", chatId: "oc_1" }],
    });

    assert.equal(center.isNativeChannelDecision(record, "feishu"), true);
    assert.equal(center.isNativeChannelDecision(record, "wecom"), false);
    assert.equal(center.isNativeChannelDecision(record, undefined), false);

    const result = await center.resolve({
      requestId: "req-1",
      sessionKey: "session-1",
      decision: "allow",
      actor: "ou_alice",
      source: "im",
      channelKey: "feishu",
      chatId: "oc_other",
    });

    assert.equal(result.applied, true);
    assert.equal(center.get(record.id)?.state, "approved");
  } finally {
    await dispose();
  }
});

test("a second decision for the same record is refused", async () => {
  const { center, dispose } = await createCenter();
  try {
    await center.register({
      kind: "permission",
      sessionKey: "session-1",
      requestId: "req-1",
      toolName: "read_file",
      originChannelKey: "web",
      risk: "low",
      summary: "synthetic",
      payloadPreview: "(synthetic)",
      bindings: [{ channelKey: "feishu", chatId: "oc_1" }],
    });

    const first = await center.resolve({
      requestId: "req-1",
      sessionKey: "session-1",
      decision: "allow",
      actor: "ou_alice",
      source: "im",
      channelKey: "feishu",
      chatId: "oc_1",
    });
    assert.equal(first.applied, true);

    const second = await center.resolve({
      requestId: "req-1",
      sessionKey: "session-1",
      decision: "deny",
      actor: "ou_bob",
      source: "im",
      channelKey: "feishu",
      chatId: "oc_1",
    });
    assert.equal(second.applied, false);
    assert.equal(second.reason, "already_approved");
    assert.equal(center.findByRequestId("req-1", "session-1")?.decision?.actor, "ou_alice");
  } finally {
    await dispose();
  }
});
