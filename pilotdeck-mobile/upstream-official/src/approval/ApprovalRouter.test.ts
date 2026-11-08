import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalRouter } from "./ApprovalRouter.js";
import type { ApprovalRecord } from "./types.js";

function router(): ApprovalRouter {
  return new ApprovalRouter({
    center: {} as never,
    gateway: {} as never,
    resolveChannel: () => undefined,
    bindingConfigs: () => [],
  });
}

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "a1",
    kind: "permission",
    sessionKey: "session/source-1",
    requestId: "request-1",
    toolName: "read_file",
    originChannelKey: "web",
    risk: "low",
    state: "pending",
    summary: "synthetic",
    payloadPreview: '{"path":"src/app.ts"}',
    payloadRedacted: false,
    createdAt: 1,
    expiresAt: 1_900_000_000_000,
    bindings: [],
    deliveries: [],
    ...overrides,
  };
}

test("permission prompt identifies project, decision, redacted payload, and source session", () => {
  const prompt = router().formatPrompt(record({ projectKey: "project-key", projectName: "可信项目" }));
  assert.match(prompt, /项目：可信项目/);
  assert.match(prompt, /项目标识：project-key/);
  assert.match(prompt, /来源会话：session\/source-1/);
  assert.match(prompt, /回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝/);
  assert.match(prompt, /src\/app\.ts/);
});

test("missing project context is explicit and never inferred", () => {
  const prompt = router().formatPrompt(record());
  assert.match(prompt, /项目：未关联项目/);
  assert.match(prompt, /项目标识：未关联项目/);
  assert.match(prompt, /来源会话：session\/source-1/);
});

test("elicitation prompt keeps choices and does not use permission allow wording", () => {
  const prompt = router().formatPrompt(record({
    kind: "elicitation",
    toolName: "ask_user_question",
    projectKey: "p1",
    payloadPreview: '{"question":"Mode?","options":[{"label":"Safe","description":"Read only"},{"label":"Fast","description":"More access"}]}',
  }));
  assert.match(prompt, /项目标识：p1/);
  assert.match(prompt, /来源会话：session\/source-1/);
  assert.match(prompt, /Safe/);
  assert.match(prompt, /Fast/);
  assert.doesNotMatch(prompt, /允许一次/);
});

test("route carries project fields with compatibility fallback", async () => {
  const delivered: Record<string, unknown>[] = [];
  const r = new ApprovalRouter({
    center: {
      auditEvent: async () => undefined,
      recordDelivery: async () => undefined,
    } as never,
    gateway: {} as never,
    resolveChannel: () => ({ routeApprovalPrompt: async (route) => { delivered.push(route); return true; } }),
    bindingConfigs: () => [],
  });
  const rec = record({ bindings: [{ channelKey: "im", chatId: "chat" }], projectKey: "p1", projectName: "Project One" });
  assert.equal(await r.route(rec), true);
  assert.equal(delivered[0]?.projectKey, "p1");
  assert.equal(delivered[0]?.projectName, "Project One");
});
