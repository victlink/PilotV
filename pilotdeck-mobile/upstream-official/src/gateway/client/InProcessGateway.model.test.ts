import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { InProcessGateway } from "./InProcessGateway.js";
import { SessionRouter } from "../SessionRouter.js";
import type { ExplicitModelSelection, GatewaySubmitTurnInput } from "../protocol/types.js";
import { AgentSession } from "../../agent/session/AgentSession.js";
import { TurnRunner } from "../../agent/turn/TurnRunner.js";
import { AgentLoop } from "../../agent/loop/AgentLoop.js";
import { createRouterRuntime } from "../../router/RouterRuntime.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../model/index.js";
import { JsonlTranscriptWriter } from "../../session/transcript/JsonlTranscriptWriter.js";
import { ToolRegistry } from "../../tool/registry/ToolRegistry.js";
import { ToolRuntime } from "../../tool/execution/ToolRuntime.js";
import { ConcurrentToolScheduler } from "../../tool/scheduler/ConcurrentToolScheduler.js";
import { createDelegateProjectTasksTool } from "../../tool/builtin/delegateProjectTasks.js";
import { createAgentTool } from "../../tool/builtin/agent.js";
import { PermissionRuntime } from "../../permission/index.js";

const fixed: ExplicitModelSelection = { mode: "model", provider: "fixture", model: "fixed" };
const routed = { id: "fixture/routed", provider: "fixture", model: "routed" };
const fallback = { id: "fixture/fallback", provider: "fixture", model: "fallback" };

for (const scenario of ["fixed", "saved", "legacy", "auto", "routed", "failure", "solo", "savedSolo", "team"] as const) {
  test(`${scenario}: model runtime sees the expected main and child targets`, async () => {
    const cwd = process.env.WORKSPACES_ROOT!;
    const advertisedTools: string[][] = [];
    const requests: [string, string, string][] = [];
    const modelRuntime = {
      getProviderProtocol: () => "openai",
      getCapabilities: () => ({}),
      getMultimodal: () => undefined,
      async *stream(request: CanonicalModelRequest, options: { requestContext: { sessionId: string } }): AsyncGenerator<CanonicalModelEvent> {
        const child = options.requestContext.sessionId.includes("::sub::");
        advertisedTools.push(request.tools?.map(tool => tool.name) ?? []);
        requests.push([child ? "child" : "main", request.provider, request.model]);
        if (scenario === "failure" && child && request.model === fixed.model) {
          yield { type: "error", error: { provider: request.provider, model: request.model, protocol: "openai", code: "model_not_found", message: "fixture unavailable", retryable: false } };
          return;
        }
        yield { type: "message_start", role: "assistant" };
        if (requests.length === 1) {
          yield { type: "tool_call_end", toolCall: { id: "fork", name: scenario === "team" ? "delegate_project_tasks" : scenario === "savedSolo" ? "subagent" : "agent", input: scenario === "team" ? { tasks: [{ id: "inspect", memberId: "worker", directive: "Inspect fixture", dependsOn: [] }] } : { description: "Inspect fixture", prompt: "Summarize the fixture" } } };
          yield { type: "message_end", finishReason: "tool_call" };
        } else {
          yield { type: "text_delta", text: "Fixture response" };
          yield { type: "message_end", finishReason: "stop" };
        }
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as ModelRuntime;
    const router = createRouterRuntime({
      scenarios: { default: routed },
      fallback: { default: [fallback] },
      transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    }, { modelRuntime });
    const registry = new ToolRegistry();
    registry.register(createAgentTool());
    registry.register(createDelegateProjectTasksTool());
    const scheduler = new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry);
    const loop = new AgentLoop({
      provider: "fixture", model: "main-default", cwd, permissionMode: "default",
      subagentModel: { provider: "fixture", model: "child-default" },
      permissionContext: { mode: "default", rules: { allow: [], deny: [], ask: [] }, cwd, additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false },
    }, { router, tools: { registry, scheduler } });
    const sessionKey = `web:s_model_${scenario}`;
    const transcriptPath = join(cwd, `${scenario}.jsonl`);
    const transcript = new JsonlTranscriptWriter({ path: transcriptPath });
    const turnRunner = new TurnRunner(loop, transcript, undefined, undefined, undefined, { cwd, transcriptPath, collectFileArtifacts: false });
    const sessions = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => new AgentSession({ sessionId: sessionKey, turnRunner, cwd }) });
    const gateway = new InProcessGateway(sessions, scenario === "saved" || scenario === "routed" ? {
      resolveTurnModelSelection: async () => ({ selection: fixed, source: scenario === "saved" ? "session" : "router" }),
    } : scenario === "savedSolo" ? { resolveSavedSoloMode: async () => true }
      : scenario === "team" ? { resolveProjectTaskAuthority: async () => ({ projectRoot: cwd,
          members: [{ id: "worker", briefing: "Read-only project worker", toolPolicy: { allow: ['read_file'] } }],
          resolveMember: async id => ({ id, briefing: "Read-only project worker", toolPolicy: { allow: ['read_file'] } }) }) } : {});
    const input: GatewaySubmitTurnInput = { sessionKey, projectKey: cwd, channelKey: "web", message: "Run fixture", maxTurns: 3 };
    if (scenario === "fixed" || scenario === "failure" || scenario === "team") input.modelSelection = fixed;
    if (scenario === "solo") input.executionMode = "solo";
    if (scenario === "savedSolo") input.executionMode = "autoSplit";
    if (scenario === "auto") input.modelSelection = { mode: "auto" };
    if (scenario === "legacy") input.modelOverride = fixed;
    const events = [];
    try {
      for await (const event of gateway.submitTurn(input)) events.push(event);
      if (scenario === "solo" || scenario === "savedSolo") {
        assert.deepEqual(advertisedTools, [[], []]);
        assert.deepEqual(requests.map(([scope]) => scope), ["main", "main"]);
        const denied = events.find(event => event.type === "tool_call_finished");
        assert.equal(denied?.ok, false);
        assert.match(denied?.resultPreview ?? "", /solo/i);
        return;
      }
      if (scenario === "team") {
        assert.deepEqual(advertisedTools, [["delegate_project_tasks"], [], ["delegate_project_tasks"]]);
      }
      const main = scenario === "auto" ? "routed" : "fixed";
      const child = scenario === "auto" || scenario === "routed" ? "routed" : "fixed";
      assert.deepEqual(requests, [["main", "fixture", main], ["child", "fixture", child], ["main", "fixture", main]]);
      const fork = events.find(event => event.type === "tool_call_finished");
      assert.equal(fork?.ok, scenario !== "failure");
      if (scenario === "failure") assert.match(fork?.resultPreview ?? "", /fixture unavailable/);
    } finally {
      await sessions.shutdown();
      await transcript.close();
      await router.shutdown();
    }
  });
}
