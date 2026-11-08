import test from "node:test";
import assert from "node:assert/strict";
import type { Gateway } from "../../../gateway/index.js";
import type { GatewayPermissionDecisionInput } from "../../../gateway/protocol/types.js";
import { ImPermissionHelper } from "./ImPermissionHelper.js";

/**
 * B2 — a refused decision must be reported to the chat truthfully.
 *
 * The IM answer path used to answer "已允许一次，继续执行。" even when the
 * gateway refused the decision; the chat then believed that the tool call
 * was authorized. The refusal reason is now part of the answer (contract §4).
 */

const EXPIRES_AT = Date.UTC(2031, 0, 2, 3, 4, 5);

type Decision = GatewayPermissionDecisionInput;

function createGateway(result: { delivered: boolean; reason?: string }): {
  gateway: Gateway;
  calls: Decision[];
} {
  const calls: Decision[] = [];
  const gateway = {
    permissionDecide: async (input: Decision) => {
      calls.push(input);
      return result;
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

test("B2/T4: a refused IM decision is reported with its reason and never as a grant", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway({ delivered: false, reason: "risk_not_im_decidable" });

  helper.captureMirrored("chat-refused", {
    sessionKey: "session-refused",
    requestId: "req-refused",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  const answer = await helper.answerWithState("chat-refused", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  assert.equal(calls.length, 1);
  assert.equal(answer?.canAdvance, false, "a refused decision must not advance the turn");
  assert.equal(answer?.text, "权限请求未通过：risk_not_im_decidable");
  // The chat must never be told that the permission was granted.
  assert.doesNotMatch(answer?.text ?? "", /已允许/);
  assert.doesNotMatch(answer?.text ?? "", /继续执行/);
});

test("B2/T4: a refused IM decision without a reason stays truthful", async () => {
  const helper = new ImPermissionHelper();
  const { gateway } = createGateway({ delivered: false });

  helper.captureMirrored("chat-no-reason", {
    sessionKey: "session-no-reason",
    requestId: "req-no-reason",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  const answer = await helper.answerWithState("chat-no-reason", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  assert.equal(answer?.canAdvance, false);
  assert.equal(answer?.text, "权限请求已失效，已跳过，继续处理。");
  assert.doesNotMatch(answer?.text ?? "", /已允许/);
});
