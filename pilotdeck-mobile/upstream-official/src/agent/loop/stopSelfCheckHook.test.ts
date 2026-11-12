import assert from "node:assert/strict";
import test from "node:test";

import type { PilotDeckHookInput } from "../../extension/hooks/protocol/input.js";
import {
  STOP_SELF_CHECK_ENV,
  createStopSelfCheckHookHandler,
  isStopSelfCheckEnabled,
} from "./stopSelfCheckHook.js";

function stopInput(payload: Record<string, unknown>): PilotDeckHookInput {
  return {
    hookEventName: "Stop",
    sessionId: "session-1",
    transcriptPath: "",
    cwd: "/tmp/project",
    ...payload,
  };
}

test("env switch: off unless explicitly enabled", () => {
  assert.equal(isStopSelfCheckEnabled({}), false, "unset stays off");
  assert.equal(isStopSelfCheckEnabled({ [STOP_SELF_CHECK_ENV]: "1" }), true);
  assert.equal(isStopSelfCheckEnabled({ [STOP_SELF_CHECK_ENV]: "true" }), true);
  assert.equal(isStopSelfCheckEnabled({ [STOP_SELF_CHECK_ENV]: "0" }), false);
  assert.equal(isStopSelfCheckEnabled({ [STOP_SELF_CHECK_ENV]: "off" }), false);
});

test("premature stop becomes an additionalContext effect, not a block", async () => {
  const handler = createStopSelfCheckHookHandler();
  const output = await handler({
    hookInput: stopInput({
      lastAssistantMessage: "我先看一下现有实现，然后修改登录页。",
      lastUserMessage: "把登录页改成手机可用",
      toolsUsedThisTurn: [],
      stopHookActive: false,
    }),
  });

  assert.ok(output && typeof output === "object" && output.type === "sync");
  const specific = (output as { specific?: { hookEventName?: string; additionalContext?: string } }).specific;
  assert.equal(specific?.hookEventName, "Stop");
  assert.match(specific?.additionalContext ?? "", /没有执行任何工具/);
  // A block output would be turned into agent_unsupported_feature by the loop.
  assert.equal((output as { decision?: string }).decision, undefined);
});

test("a finished reply produces no context", async () => {
  const handler = createStopSelfCheckHookHandler();
  const output = await handler({
    hookInput: stopInput({
      lastAssistantMessage: "登录页已改好，npm test 通过。",
      lastUserMessage: "把登录页改成手机可用",
      toolsUsedThisTurn: ["Read", "Edit", "Bash"],
      stopHookActive: false,
    }),
  });
  assert.equal((output as { specific?: unknown }).specific, undefined);
});

test("continuation rounds are left alone", async () => {
  const handler = createStopSelfCheckHookHandler();
  const output = await handler({
    hookInput: stopInput({
      lastAssistantMessage: "接下来我会补测试。",
      lastUserMessage: "把登录页改成手机可用",
      toolsUsedThisTurn: [],
      stopHookActive: true,
    }),
  });
  assert.equal((output as { specific?: unknown }).specific, undefined);
});

test("missing or malformed payload fields do not throw", async () => {
  const handler = createStopSelfCheckHookHandler();
  const output = await handler({ hookInput: stopInput({}) });
  assert.equal((output as { type?: string }).type, "sync");

  const malformed = await handler({
    hookInput: stopInput({ lastAssistantMessage: 42, toolsUsedThisTurn: ["Read", 7, "", "Edit"] }),
  });
  assert.equal((malformed as { type?: string }).type, "sync");
});
