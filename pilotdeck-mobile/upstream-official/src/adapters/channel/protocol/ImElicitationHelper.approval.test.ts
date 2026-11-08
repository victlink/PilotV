/**
 * `ImElicitationHelper` — an elicitation is a *question*, not an
 * authorization (contract §6).
 *
 * The mirrored elicitation must live in the elicitation queue only. If it
 * ever landed in the permission queue, a reply to the question could be
 * read as a permission decision — a silent privilege escalation. The cases
 * below therefore check the *negative*: the permission queue stays empty and
 * the reply is answered through `respondElicitation`, never through
 * `permissionDecide`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Gateway } from "../../../gateway/index.js";

import { ImElicitationHelper } from "./ImElicitationHelper.js";
import { ImPermissionHelper } from "./ImPermissionHelper.js";

const EXPIRES_AT = Date.UTC(2031, 0, 2, 3, 4, 5);

const QUESTIONS = [
  {
    question: "要继续部署吗？",
    header: "部署确认",
    options: [
      { label: "继续", description: "立即部署到测试环境" },
      { label: "稍后", description: "等下一个窗口" },
    ],
  },
];

type GatewayCalls = {
  elicitations: Array<{ requestId: string; answer: unknown }>;
  decisions: Array<{ requestId: string; decision: string }>;
};

function createGateway(): { gateway: Gateway; calls: GatewayCalls } {
  const calls: GatewayCalls = { elicitations: [], decisions: [] };
  const gateway = {
    respondElicitation: async (input: { requestId: string; answer: unknown }) => {
      calls.elicitations.push({ requestId: input.requestId, answer: input.answer });
      return { delivered: true };
    },
    permissionDecide: async (input: { requestId: string; decision: string }) => {
      calls.decisions.push({ requestId: input.requestId, decision: input.decision });
      return { delivered: true };
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

test("a mirrored elicitation is registered in the elicitation queue only", () => {
  const elicitation = new ImElicitationHelper();
  const permissions = new ImPermissionHelper({ channelKey: "feishu" });

  const text = elicitation.captureMirrored("oc_chat_1", {
    sessionKey: "session-1",
    requestId: "req-elicit-1",
    questions: QUESTIONS,
    expiresAt: EXPIRES_AT,
  });

  assert.ok(text);
  // It is pending as an elicitation ...
  assert.equal(elicitation.hasPending("oc_chat_1"), true);
  // ... and the permission queue of the same chat knows nothing about it.
  assert.equal(permissions.hasPending("oc_chat_1"), false);
  assert.equal(permissions.hasMirroredPending("oc_chat_1"), false);
});

test("the elicitation prompt does not use the permission wording", () => {
  const elicitation = new ImElicitationHelper();

  const text = elicitation.captureMirrored("oc_chat_2", {
    sessionKey: "session-1",
    requestId: "req-elicit-2",
    questions: QUESTIONS,
    expiresAt: EXPIRES_AT,
  })!;

  // The permission wording must not appear: "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。"
  assert.equal(text.includes("允许一次"), false);
  assert.equal(text.includes("允许本会话"), false);
  assert.equal(text.includes("拒绝"), false);
  // The elicitation wording must be there instead.
  assert.ok(text.includes("回复数字选择"));
  assert.ok(text.includes("回复 0 取消"));
  // The question itself is shown.
  assert.ok(text.includes("要继续部署吗？"));
  assert.ok(text.includes("继续"));
});

test("a reply to an elicitation is answered as an elicitation, never as a permission", async () => {
  const elicitation = new ImElicitationHelper();
  const permissions = new ImPermissionHelper({ channelKey: "feishu" });
  const { gateway, calls } = createGateway();

  elicitation.captureMirrored("oc_chat_3", {
    sessionKey: "session-1",
    requestId: "req-elicit-3",
    questions: QUESTIONS,
    expiresAt: EXPIRES_AT,
  });

  await elicitation.answer("oc_chat_3", "1", gateway, { actor: "ou_alice", origin: "im" });

  assert.equal(calls.elicitations.length, 1);
  assert.equal(calls.elicitations[0]!.requestId, "req-elicit-3");
  // The permission path was never touched.
  assert.equal(calls.decisions.length, 0);
  assert.equal(permissions.hasPending("oc_chat_3"), false);
  // The elicitation queue is empty again.
  assert.equal(elicitation.hasPending("oc_chat_3"), false);
});

test("a cancelled elicitation is answered as an elicitation too", async () => {
  const elicitation = new ImElicitationHelper();
  const { gateway, calls } = createGateway();

  elicitation.captureMirrored("oc_chat_4", {
    sessionKey: "session-1",
    requestId: "req-elicit-4",
    questions: QUESTIONS,
    expiresAt: EXPIRES_AT,
  });

  const reply = await elicitation.answer("oc_chat_4", "0", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  assert.equal(reply, "已取消。");
  assert.equal(calls.elicitations.length, 1);
  assert.deepEqual(calls.elicitations[0]!.answer, {
    type: "cancelled",
    reason: "user cancelled",
  });
  assert.equal(calls.decisions.length, 0);
});

test("an expired mirrored elicitation is dropped", () => {
  const elicitation = new ImElicitationHelper();

  elicitation.captureMirrored("oc_chat_5", {
    sessionKey: "session-1",
    requestId: "req-elicit-5",
    questions: QUESTIONS,
    expiresAt: Date.now() - 1_000,
  });

  assert.equal(elicitation.hasPending("oc_chat_5"), false);
});
