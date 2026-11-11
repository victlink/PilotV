import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalPromptRoute } from "../../../approval/ApprovalRouter.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { FeishuChannel } from "./FeishuChannel.js";

const EXPIRES_AT = Date.UTC(2031, 0, 2, 3, 4, 5);
const EXPIRY_TEXT = new Date(EXPIRES_AT).toLocaleString("zh-CN", { hour12: false });

function buildRoute(overrides: Partial<ApprovalPromptRoute> = {}): ApprovalPromptRoute {
  return {
    kind: "permission",
    chatId: "oc_chat_1",
    chatType: "dm",
    sessionKey: "session-1",
    requestId: "req-1",
    toolName: "bash",
    projectKey: "project-1",
    projectName: "Project One",
    risk: "medium",
    expiresAt: EXPIRES_AT,
    prompt: [
      "【PilotDeck 授权请求】bash",
      "风险等级：中",
      "请求编号：req-1",
      "会话：session-1",
      `有效期至：${EXPIRY_TEXT}`,
      "",
      "请求内容：",
      "(已脱敏)",
      "",
      "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
    ].join("\n"),
    ...overrides,
  };
}

function permissionsOf(channel: FeishuChannel): ImPermissionHelper {
  return (channel as unknown as { permissions: ImPermissionHelper }).permissions;
}

function elicitationOf(channel: FeishuChannel): ImElicitationHelper {
  return (channel as unknown as { elicitation: ImElicitationHelper }).elicitation;
}

test("feishu mirrors an approval prompt and registers the pending request", async () => {
  const sent: { chatId: string; text: string }[] = [];
  const channel = new FeishuChannel({
    send: async (message) => {
      sent.push({ chatId: message.chatId, text: message.text });
    },
  });

  const route = buildRoute();
  const delivered = await channel.routeApprovalPrompt(route);

  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, "oc_chat_1");
  assert.ok(sent[0]!.text.includes("bash"), "the prompt must name the tool");
  assert.ok(sent[0]!.text.includes(EXPIRY_TEXT), "the prompt must carry the expiry");
  assert.equal(permissionsOf(channel).hasPending("oc_chat_1"), true);
  assert.equal(permissionsOf(channel).hasMirroredPending("oc_chat_1"), true);
});

test("feishu reports a failed delivery and leaves no dangling pending request", async () => {
  const channel = new FeishuChannel({
    send: async () => {
      throw new Error("network down");
    },
  });

  const delivered = await channel.routeApprovalPrompt(buildRoute());

  assert.equal(delivered, false);
  assert.equal(permissionsOf(channel).hasPending("oc_chat_1"), false);
  assert.equal(permissionsOf(channel).hasMirroredPending("oc_chat_1"), false);
});

test("feishu keeps the channel key used by the approval router", () => {
  const channel = new FeishuChannel();
  assert.equal(channel.channelKey, "feishu");
});

test("feishu routes an elicitation into the elicitation queue, never the permission queue", async () => {
  const sent: { chatId: string; text: string }[] = [];
  const channel = new FeishuChannel({
    send: async (message) => {
      sent.push({ chatId: message.chatId, text: message.text });
    },
  });

  const delivered = await channel.routeApprovalPrompt(
    buildRoute({
      kind: "elicitation",
      requestId: "req-elicit-1",
      questions: [
        {
          question: "要继续部署吗？",
          header: "部署确认",
          options: [{ label: "继续", description: "立即部署" }],
        },
      ],
    }),
  );

  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  // The question is in the elicitation queue ...
  assert.equal(elicitationOf(channel).hasPending("oc_chat_1"), true);
  // ... and the permission queue knows nothing about the request id.
  assert.equal(permissionsOf(channel).hasPending("oc_chat_1"), false);
  assert.equal(permissionsOf(channel).hasMirroredPending("oc_chat_1"), false);
  // The delivered text is the question, not an authorization prompt.
  assert.equal(sent[0]!.text.includes("允许一次"), false);
  assert.equal(sent[0]!.text.includes("允许本会话"), false);
  assert.equal(sent[0]!.text.includes("拒绝"), false);
  assert.ok(sent[0]!.text.includes("要继续部署吗？"));
});
