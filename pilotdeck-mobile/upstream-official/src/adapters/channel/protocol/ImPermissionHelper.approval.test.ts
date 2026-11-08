import test from "node:test";
import assert from "node:assert/strict";
import type { Gateway, GatewayEvent } from "../../../gateway/index.js";
import type { GatewayPermissionDecisionInput } from "../../../gateway/protocol/types.js";
import { ImPermissionHelper } from "./ImPermissionHelper.js";

const EXPIRES_AT = Date.UTC(2031, 0, 2, 3, 4, 5);
const EXPIRY_TEXT = new Date(EXPIRES_AT).toLocaleString("zh-CN", { hour12: false });

type Decision = GatewayPermissionDecisionInput;

function createGateway(): { gateway: Gateway; calls: Decision[] } {
  const calls: Decision[] = [];
  const gateway = {
    permissionDecide: async (input: Decision) => {
      calls.push(input);
      return { delivered: true };
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

function ownedEvent(
  requestId: string,
  toolName = "bash",
): GatewayEvent & { type: "permission_request" } {
  return {
    type: "permission_request",
    requestId,
    toolName,
    payload: { command: "ls" },
  };
}

test("a mirrored approval reply is decided with the actor and the im origin", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-1", {
    sessionKey: "session-1",
    requestId: "req-1",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  const answer = await helper.answerWithState("chat-1", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  assert.equal(answer?.canAdvance, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionKey, "session-1");
  assert.equal(calls[0]!.requestId, "req-1");
  assert.equal(calls[0]!.decision, "allow");
  assert.equal(calls[0]!.actor, "ou_alice");
  assert.equal(calls[0]!.origin, "im");
  assert.equal(calls[0]!.remember, false);
});

test("a mirrored approval reply of 0 denies the request", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-deny", {
    sessionKey: "session-deny",
    requestId: "req-deny",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  await helper.answerWithState("chat-deny", "0", gateway, { actor: "ou_bob", origin: "im" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.decision, "deny");
  assert.equal(calls[0]!.actor, "ou_bob");
  assert.equal(calls[0]!.origin, "im");
});

test("a mirrored approval reply of 2 remembers the session grant", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-session", {
    sessionKey: "session-2",
    requestId: "req-2",
    toolName: "write_file",
    expiresAt: EXPIRES_AT,
  });

  await helper.answerWithState("chat-session", "2", gateway, { actor: "ou_carol", origin: "im" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.decision, "allow");
  assert.equal(calls[0]!.remember, true);
  assert.equal(calls[0]!.origin, "im");
});

test("a reply in a chat without a registered request never reaches the gateway", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  const answer = await helper.answerWithState("chat-unknown", "1", gateway, {
    actor: "ou_dave",
    origin: "im",
  });

  assert.equal(answer, undefined);
  assert.equal(calls.length, 0);
});

test("a reply without an explicit origin is reported as an IM decision", async () => {
  // The origin is *always* reported: an answer that arrived through a chat
  // adapter is an IM decision even when the caller does not spell the origin
  // out. Without it the approval center would treat the answer as a Web
  // decision and the channel binding check would never run.
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-legacy", {
    sessionKey: "session-legacy",
    requestId: "req-legacy",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  await helper.answerWithState("chat-legacy", "1", gateway);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.origin, "im");
  // The helper was built without a channel, so there is no channel to report:
  // a missing channel must stay missing instead of becoming "".
  assert.equal("channelKey" in calls[0]!, false);
  // The chat the answer came from is always reported — the binding check
  // compares the answering chat against the bound one.
  assert.equal(calls[0]!.chatId, "chat-legacy");
  // The actor is never invented: without an explicit actor the decision has
  // no identity at all.
  assert.equal("actor" in calls[0]!, false);
  // The channel adapter verified the sender, so the provenance is the
  // channel identity even though the actor itself is missing.
  assert.equal(calls[0]!.actorSource, "channel_identity");
});

test("the helper reports its own channel key with every decision", async () => {
  const helper = new ImPermissionHelper({ channelKey: "feishu" });
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-channel", {
    sessionKey: "session-channel",
    requestId: "req-channel",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  await helper.answerWithState("chat-channel", "1", gateway, { actor: "ou_alice" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.channelKey, "feishu");
  assert.equal(calls[0]!.chatId, "chat-channel");
  assert.equal(calls[0]!.origin, "im");
  assert.equal(calls[0]!.actorSource, "channel_identity");
});

test("the chat the answer comes from can be overridden explicitly", async () => {
  // `MirroredPermissionRequest` has no chatId field: the mirrored entry is
  // registered under the chat it was delivered to. Only the answer options
  // can point the decision at a different chat.
  const helper = new ImPermissionHelper({ channelKey: "feishu" });
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-x", {
    sessionKey: "session-x",
    requestId: "req-x",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  await helper.answerWithState("chat-x", "1", gateway, {
    actor: "ou_alice",
    chatId: "oc_123",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.chatId, "oc_123");
  assert.equal(calls[0]!.channelKey, "feishu");
});

test("the mirrored prompt names the tool and the expiry", () => {
  const helper = new ImPermissionHelper();

  const prompt = helper.captureMirrored("chat-prompt", {
    sessionKey: "session-prompt",
    requestId: "req-prompt",
    toolName: "bash",
    payload: { command: "ls" },
    expiresAt: EXPIRES_AT,
  });

  assert.ok(prompt);
  assert.ok(prompt.includes("bash"), "mirrored prompt must name the tool");
  assert.ok(prompt.includes(EXPIRY_TEXT), "mirrored prompt must carry the expiry");
  assert.ok(prompt.includes("回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。"));
});

test("a mirrored prompt supplied by the router is used verbatim", () => {
  const helper = new ImPermissionHelper();
  const routerPrompt = [
    "【PilotDeck 授权请求】bash",
    "风险等级：中",
    "请求编号：req-router",
    "会话：session-router",
    `有效期至：${EXPIRY_TEXT}`,
    "",
    "请求内容：",
    "(已脱敏)",
    "",
    "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
  ].join("\n");

  helper.captureMirrored("chat-router", {
    sessionKey: "session-router",
    requestId: "req-router",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
    prompt: routerPrompt,
  });

  assert.equal(helper.formatPending("chat-router"), routerPrompt);
});

test("the channel owned prompt text is unchanged by the mirrored support", () => {
  const helper = new ImPermissionHelper();

  const prompt = helper.capture("chat-owned", "session-owned", ownedEvent("req-owned"));

  assert.equal(
    prompt,
    [
      "工具 bash 需要权限才能继续执行。",
      "",
      "请求内容：",
      JSON.stringify({ command: "ls" }, null, 2),
      "",
      "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
    ].join("\n"),
  );
});

test("a mirrored request and a channel owned request share one pending queue", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.capture("chat-shared", "session-owned", ownedEvent("req-owned"));
  helper.confirmInitialPrompt("chat-shared", true, "req-owned");
  helper.captureMirrored("chat-shared", {
    sessionKey: "session-mirrored",
    requestId: "req-mirrored",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  const owned = await helper.answerWithState("chat-shared", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });
  assert.equal(owned?.canAdvance, true);
  assert.equal(calls[0]!.requestId, "req-owned");

  // The channel delivers the next queued prompt before the next reply arrives.
  const nextPrompt = helper.takeNextPrompt("chat-shared", owned!.answerToken);
  assert.ok(nextPrompt);
  assert.ok(nextPrompt.includes("bash"));
  helper.confirmNextPrompt(
    "chat-shared",
    true,
    helper.getPromptRequestId("chat-shared", owned!.answerToken),
    owned!.answerToken,
  );

  const mirrored = await helper.answerWithState("chat-shared", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });
  assert.equal(mirrored?.canAdvance, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.requestId, "req-mirrored");
  assert.equal(calls[1]!.sessionKey, "session-mirrored");
  assert.equal(calls[1]!.actor, "ou_alice");
  assert.equal(calls[1]!.origin, "im");
});

test("removeMirrored only drops the mirrored request and keeps the queue clean", () => {
  const helper = new ImPermissionHelper();

  helper.captureMirrored("chat-remove", {
    sessionKey: "session-remove",
    requestId: "req-remove",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });
  assert.equal(helper.hasPending("chat-remove"), true);
  assert.equal(helper.hasMirroredPending("chat-remove"), true);

  helper.removeMirrored("chat-remove", "req-remove");
  assert.equal(helper.hasPending("chat-remove"), false);
  assert.equal(helper.hasMirroredPending("chat-remove"), false);
});

test("a reply only consumes the request whose prompt was delivered last", async () => {
  // The chat received a mirrored prompt first and a channel owned request
  // afterwards. The reply belongs to the prompt the user is actually looking
  // at — the mirrored one — and the channel owned request stays queued.
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  const mirroredPrompt = helper.captureMirrored("chat-order", {
    sessionKey: "session-mirrored",
    requestId: "req-mirrored",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });
  assert.ok(mirroredPrompt, "the first request of a chat delivers its prompt");
  // The second request does not deliver a prompt: the chat already looks at
  // the first one.
  assert.equal(
    helper.capture("chat-order", "session-owned", ownedEvent("req-owned")),
    undefined,
  );

  const answer = await helper.answerWithState("chat-order", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  assert.equal(answer?.canAdvance, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.requestId, "req-mirrored");
  assert.equal(calls[0]!.sessionKey, "session-mirrored");

  // The channel owned request was not swallowed by the reply.
  assert.equal(helper.hasPending("chat-order"), true);
  const queued = helper.formatPending("chat-order");
  assert.ok(queued);
  assert.ok(queued.includes("bash"));
});

test("the other request of the chat stays queued after the reply", async () => {
  // Mirror image of the case above: the channel owned prompt was delivered
  // first, so the reply answers it and the mirrored request stays pending.
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.capture("chat-queue", "session-owned", ownedEvent("req-owned"));
  helper.confirmInitialPrompt("chat-queue", true, "req-owned");
  helper.captureMirrored("chat-queue", {
    sessionKey: "session-mirrored",
    requestId: "req-mirrored",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  await helper.answerWithState("chat-queue", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.requestId, "req-owned");
  // The mirrored request is still there — the reply did not consume it.
  assert.equal(helper.hasMirroredPending("chat-queue"), true);
  assert.equal(helper.hasPending("chat-queue"), true);
});

test("an expired mirrored request is dropped and does not swallow the next message", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-expired", {
    sessionKey: "session-expired",
    requestId: "req-expired",
    toolName: "bash",
    expiresAt: Date.now() - 1_000,
  });

  // The adapters poll `hasPending` before routing an inbound message; that
  // poll is what drops the stale entry.
  assert.equal(helper.hasMirroredPending("chat-expired"), false);
  assert.equal(helper.hasPending("chat-expired"), false);

  // The ordinary message of the chat must not be eaten by the stale request.
  const answer = await helper.answerWithState("chat-expired", "今天天气不错", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  assert.equal(answer, undefined);
  assert.equal(calls.length, 0);
});

test("an expired mirrored request does not hide a live one", async () => {
  const helper = new ImPermissionHelper();
  const { gateway, calls } = createGateway();

  helper.captureMirrored("chat-mixed", {
    sessionKey: "session-expired",
    requestId: "req-expired",
    toolName: "bash",
    expiresAt: Date.now() - 1_000,
  });
  helper.captureMirrored("chat-mixed", {
    sessionKey: "session-live",
    requestId: "req-live",
    toolName: "bash",
    expiresAt: EXPIRES_AT,
  });

  assert.equal(helper.hasMirroredPending("chat-mixed"), true);

  await helper.answerWithState("chat-mixed", "1", gateway, {
    actor: "ou_alice",
    origin: "im",
  });

  // The reply belongs to the live request, never to the expired one.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.requestId, "req-live");
  assert.equal(calls[0]!.sessionKey, "session-live");
});
