/**
 * Subagent tool-visibility rule (C2 §6.2 scoping).
 */

import type { SubagentDefinition } from "./builtinSubagentTypes.js";

/**
 * Whether a subagent may see a given tool.
 *
 * Extracted from `buildScopedRegistry` because each exclusion here encodes a
 * decision that is invisible at the call site, and the interesting one is
 * recent: `ask_user_question` used to be stripped unconditionally, which is
 * correct only when there is no elicitation channel to route to. With a
 * channel, stripping it means a blocked subagent cannot ask and will guess
 * instead — and a confident guess from a subagent is much more expensive than
 * one question.
 *
 * Note `ask_user_question` is itself read-only, so allowing it does not weaken
 * the read-only guarantee of the explore / plan / verify presets.
 */
export function isToolAllowedForSubagent(
  toolName: string,
  definition: Pick<SubagentDefinition, "allowedTools">,
  context: { hasElicitationChannel: boolean },
): boolean {
  const allowedSet = new Set(definition.allowedTools);
  const wildcard = allowedSet.has("*");
  if (!wildcard && !allowedSet.has(toolName)) return false;

  if (toolName === "enter_plan_mode" || toolName === "exit_plan_mode") return false;
  // Subagents must not nest-fork: the depth cap is the backstop, the registry
  // removal is what stops the model from trying.
  if (toolName === "agent") return false;
  // Always-On tools need a RunContext that does not exist inside a subagent.
  if (toolName.startsWith("always_on_")) return false;
  if (toolName === "ask_user_question") return context.hasElicitationChannel;
  return true;
}