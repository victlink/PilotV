/**
 * Stop self-check hook — the callback that plugs `assessStopSelfCheck` into the
 * lifecycle hook system.
 *
 * Registration lives in `cli/createLocalGateway.ts`: when
 * `PILOTV_STOP_SELF_CHECK=1`, every session's hook runtime gets
 * `{ type: "callback", name: STOP_SELF_CHECK_HOOK_NAME }` under `Stop`.
 *
 * Contract: returning `specific.additionalContext` makes the lifecycle runtime
 * emit an `additional_context` effect, which becomes a synthetic user message.
 * The P0 gate in AgentLoop.ts then continues the same turn instead of ending
 * it — so the message is what actually pushes the model back to work.
 */
import type { CallbackHookHandler } from "../../extension/hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookOutput } from "../../extension/hooks/protocol/output.js";
import { assessStopSelfCheck } from "./stopSelfCheck.js";

export const STOP_SELF_CHECK_HOOK_NAME = "pilotv_stop_self_check";

/** Env switch read by the gateway when it registers per-session hooks. */
export const STOP_SELF_CHECK_ENV = "PILOTV_STOP_SELF_CHECK";

export function isStopSelfCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[STOP_SELF_CHECK_ENV];
  if (raw === undefined) return false;
  return !/^(?:0|false|off|no)$/i.test(raw.trim());
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function createStopSelfCheckHookHandler(): CallbackHookHandler {
  return async ({ hookInput }): Promise<PilotDeckHookOutput> => {
    const result = assessStopSelfCheck({
      lastAssistantMessage: typeof hookInput.lastAssistantMessage === "string" ? hookInput.lastAssistantMessage : "",
      lastUserMessage: typeof hookInput.lastUserMessage === "string" ? hookInput.lastUserMessage : undefined,
      toolsUsedThisTurn: readStringArray(hookInput.toolsUsedThisTurn),
      stopHookActive: hookInput.stopHookActive === true,
    });

    if (result.action !== "continue") {
      return { type: "sync", suppressOutput: true };
    }

    return {
      type: "sync",
      suppressOutput: true,
      systemMessage: `[自检] 检测到提前收尾（${result.reason}），已让模型继续执行。`,
      specific: {
        hookEventName: "Stop",
        additionalContext: result.message,
      },
    };
  };
}
