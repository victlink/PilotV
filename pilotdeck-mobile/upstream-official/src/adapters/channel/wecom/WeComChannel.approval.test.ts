import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalPromptRoute } from "../../../approval/ApprovalRouter.js";
import { ApprovalCenter } from "../../../approval/ApprovalCenter.js";
import { ApprovalRouter } from "../../../approval/ApprovalRouter.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { WeComChannel } from "./WeComChannel.js";

const EXPIRES_AT = Date.UTC(2031, 0, 2, 3, 4, 5);
const EXPIRY_TEXT = new Date(EXPIRES_AT).toLocaleString("zh-CN", { hour12: false });

function buildRoute(overrides: Partial<ApprovalPromptRoute> = {}): ApprovalPromptRoute {
  return {
    kind: "permission",
    chatId: "wecom_chat_1",
    chatType: "dm",
    sessionKey: "session-1",
    requestId: "req-1",
    toolName: "bash",
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

function permissionsOf(channel: WeComChannel): ImPermissionHelper {
  return (channel as unknown as { permissions: ImPermissionHelper }).permissions;
}

test("wecom mirrors an approval prompt and registers the pending request", async () => {
  const sent: { chatId: string; text: string }[] = [];
  const channel = new WeComChannel({
    send: async (chatId, text) => {
      sent.push({ chatId, text });
      return true;
    },
  });

  const route = buildRoute();
  const delivered = await channel.routeApprovalPrompt(route);

  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, "wecom_chat_1");
  assert.ok(sent[0]!.text.includes("bash"), "the prompt must name the tool");
  assert.ok(sent[0]!.text.includes(EXPIRY_TEXT), "the prompt must carry the expiry");
  assert.equal(permissionsOf(channel).hasPending("wecom_chat_1"), true);
  assert.equal(permissionsOf(channel).hasMirroredPending("wecom_chat_1"), true);
});

test("wecom reports a failed delivery and leaves no dangling pending request", async () => {
  const channel = new WeComChannel({
    send: async () => false,
  });

  const delivered = await channel.routeApprovalPrompt(buildRoute());

  assert.equal(delivered, false);
  assert.equal(permissionsOf(channel).hasPending("wecom_chat_1"), false);
  assert.equal(permissionsOf(channel).hasMirroredPending("wecom_chat_1"), false);
});

test("wecom reports a failed delivery when the bot is not connected", async () => {
  const channel = new WeComChannel();

  const delivered = await channel.routeApprovalPrompt(buildRoute());

  assert.equal(delivered, false);
  assert.equal(permissionsOf(channel).hasPending("wecom_chat_1"), false);
});

test("wecom keeps the channel key used by the approval router", () => {
  const channel = new WeComChannel();
  assert.equal(channel.channelKey, "wecom");
});

test("a wecom group delivery failure leaves no dangling entry and keeps the record pending", async () => {
  // A WeCom group chat has no `reply_req_id`, so the prompt cannot be sent
  // as a proactive message: the send returns false. The mirrored entry must
  // not dangle (otherwise the chat would wait for an answer that can never
  // arrive), the center must record the failed delivery, and the request
  // itself must stay pending so the Web side can still approve it.
  const storeDir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-wecom-"));
  const center = new ApprovalCenter({ storeDir });
  await center.init();

  try {
    const channel = new WeComChannel({
      send: async () => false,
    });
    const router = new ApprovalRouter({
      center,
      gateway: {
        permissionDecide: async () => ({ delivered: false }),
        respondElicitation: async () => ({ delivered: false }),
      },
      resolveChannel: (channelKey) => (channelKey === "wecom" ? channel : undefined),
      bindingConfigs: () => [],
    });

    const record = await center.register({
      kind: "permission",
      sessionKey: "session-1",
      requestId: "req-wecom-1",
      toolName: "bash",
      originChannelKey: "web",
      risk: "medium",
      summary: "synthetic",
      payloadPreview: "(synthetic)",
      bindings: [{ channelKey: "wecom", chatId: "wecom_chat_1" }],
    });

    const delivered = await router.route(record);

    assert.equal(delivered, false);
    // No dangling mirrored entry in the chat.
    assert.equal(permissionsOf(channel).hasPending("wecom_chat_1"), false);
    assert.equal(permissionsOf(channel).hasMirroredPending("wecom_chat_1"), false);
    // The Web side still sees the request.
    assert.equal(center.get(record.id)?.state, "pending");
    assert.equal(center.get(record.id)?.decision, undefined);

    const raw = await readFile(center.auditFilePath, "utf8").catch(() => "");
    const audit = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { action: string; approvalId: string; channelKey?: string });
    const failed = audit.find((entry) => entry.action === "delivery_failed");
    assert.ok(failed, "the failed delivery must be audited");
    assert.equal(failed!.approvalId, record.id);
    assert.equal(failed!.channelKey, "wecom");
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
