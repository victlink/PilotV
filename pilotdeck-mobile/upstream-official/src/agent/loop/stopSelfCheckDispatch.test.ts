/**
 * End-to-end wiring test for the Stop self-check hook: real HookRuntime +
 * real LifecycleRuntime, no agent loop. Proves the chain
 *
 *   Stop event -> matching callback -> additional_context effect
 *              -> synthetic user message (what AgentLoop pushes back)
 *
 * If this breaks, the self-check silently never fires.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { HookRuntime } from "../../extension/hooks/execution/HookRuntime.js";
import { LifecycleRuntime } from "../../lifecycle/runtime/LifecycleRuntime.js";
import { STOP_SELF_CHECK_HOOK_NAME, createStopSelfCheckHookHandler } from "./stopSelfCheckHook.js";

function buildLifecycle(): LifecycleRuntime {
  const hookRuntime = new HookRuntime({
    Stop: [{ hooks: [{ type: "callback", name: STOP_SELF_CHECK_HOOK_NAME }] }],
  });
  hookRuntime.getCallbackExecutor().register(STOP_SELF_CHECK_HOOK_NAME, createStopSelfCheckHookHandler());
  return new LifecycleRuntime(hookRuntime);
}

function messageText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

test("a premature stop yields one user message the loop can continue on", async () => {
  const lifecycle = buildLifecycle();
  const result = await lifecycle.dispatch({
    event: "Stop",
    baseInput: { sessionId: "s1", transcriptPath: "", cwd: "/tmp/project" },
    payload: {
      stopHookActive: false,
      lastAssistantMessage: "我先看一下现有实现，然后修改登录页。",
      lastUserMessage: "把登录页改成手机可用",
      toolsUsedThisTurn: [],
    },
  });

  assert.equal(result.blockingErrors.length, 0, "must not block (a block becomes agent_unsupported_feature)");
  assert.equal(result.messages.length, 1);
  const message = result.messages[0]!;
  assert.equal(message.role, "user");
  assert.equal(message.metadata?.synthetic, true);
  const text = messageText(message);
  assert.match(text, /<hook_context/);
  assert.match(text, /没有执行任何工具/);
});

test("a finished turn dispatches nothing", async () => {
  const lifecycle = buildLifecycle();
  const result = await lifecycle.dispatch({
    event: "Stop",
    baseInput: { sessionId: "s2", transcriptPath: "", cwd: "/tmp/project" },
    payload: {
      stopHookActive: false,
      lastAssistantMessage: "登录页已改好，npm test 通过。",
      lastUserMessage: "把登录页改成手机可用",
      toolsUsedThisTurn: ["Read", "Edit", "Bash"],
    },
  });

  assert.equal(result.messages.length, 0);
  assert.equal(result.effects.length, 0);
});

test("other hook events never trigger the self-check", async () => {
  const lifecycle = buildLifecycle();
  const result = await lifecycle.dispatch({
    event: "PreToolUse",
    baseInput: { sessionId: "s3", transcriptPath: "", cwd: "/tmp/project" },
    payload: { lastAssistantMessage: "接下来我会补测试。", toolsUsedThisTurn: [] },
  });
  assert.equal(result.messages.length, 0);
});
