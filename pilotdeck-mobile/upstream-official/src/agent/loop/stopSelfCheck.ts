/**
 * Stop self-check ("completeness gate" content layer).
 *
 * The P0 patch in AgentLoop.ts already lets a `Stop` hook continue the turn
 * when it returns messages. This module supplies the actual judgement: at the
 * moment the model stops producing tool calls, decide whether the reply looks
 * like a *finished* answer or like a premature stop, and if it is premature,
 * produce the instruction that pushes the model back to work.
 *
 * Deliberately deterministic — no extra model call. The evidence available at
 * stop time is:
 *   - the final assistant text,
 *   - the last user message (task / acceptance criteria),
 *   - which tools actually ran during this turn,
 *   - whether this is already a hook continuation (`stopHookActive`).
 *
 * Because the loop flags continuations (`stopHookActive: true`), this gate
 * fires at most once per turn; a false positive costs one extra model call,
 * never a wrong final answer. That budget is why the heuristics below can be
 * a little eager, but each rule still requires an explicit textual signal.
 */
import type { CanonicalMessage } from "../../model/index.js";

export type StopSelfCheckApproveReason =
  | "already_continuation"
  | "empty_response"
  | "awaiting_user"
  | "asked_question"
  | "no_signal"
  | "ok";
export type StopSelfCheckContinueReason =
  | "unfinished_marker"
  | "promised_without_action"
  | "claimed_done_without_action"
  | "criteria_unverified";

export type StopSelfCheckResult =
  | { action: "approve"; reason: StopSelfCheckApproveReason }
  | { action: "continue"; reason: StopSelfCheckContinueReason; message: string };

export type StopSelfCheckInput = {
  lastAssistantMessage: string;
  lastUserMessage?: string;
  /** Tool names that actually ran during this turn (empty = text-only turn). */
  toolsUsedThisTurn?: readonly string[];
  /** True when the loop is already continuing because of this hook. */
  stopHookActive?: boolean;
};

/** Explicit "not done yet" wording. */
const UNFINISHED_MARKER = /(?:还需要|还需|尚未|还没(?:有)?(?:完成|改|修|做|跑)|未完成|待完成|待办|未验证|还没验证|TODO|FIXME|(?:still|remain(?:s)?) (?:need|to be)|not yet (?:done|finished|verified))/i;

/** First-person promise to act later ("接下来我会…", "I'll now…"). */
const PROMISE_MARKER = /(?:接下来我|下面我|我这就|我现在(?:去|就)|我先|我先把|我将(?:会)?|我会先|下一步我|接着我|稍后我|马上(?:去|就)|(?:next|then)[, ]+(?:I|we)(?:'ll| will| am going to| are going to)|(?:I|we)(?:'ll| will) (?:now )?(?:start|begin|continue|fix|update|add|implement|refactor|run|check|write|create))/i;

/** Claims the work is complete. */
const COMPLETION_CLAIM = /(?:已完成|完成了|已实现|已修复|已改好|改好了|做好了|已加上|已更新|搞定了|全部完成|都做完了|测试通过|已验证|(?:^|[^a-z])(?:done|finished|completed|all set)(?:[^a-z]|$))/i;

/** Blocked / needs-input reports: ending the turn here is correct. */
const AWAITING_USER = /(?:无法继续|无法完成|被阻塞|阻塞了|缺少(?:权限|凭据|信息|依赖)|需要你(?:提供|确认|授权)|请你(?:确认|提供)|请提供|blocked|cannot proceed|need your (?:input|approval|confirmation))/i;

/** Offers the user follow-up options rather than stopping mid-task. */
const OFFERS_NEXT_STEPS = /(?:接下来你可以|你可以(?:继续|自行|按)|如需|如果要我|需要我(?:继续|再)|要我(?:继续|再)|let me know|if you(?:'d| would) like|would you like me to)/i;

/**
 * Ends by asking the user something. Only the final non-empty line counts —
 * a question mark inside a report body is not a hand-off to the user.
 */
function asksUserQuestion(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  if (/[?？]\s*$/.test(last)) return true;
  return /(?:是否(?:继续|可以|需要)|要不要我|需要我(?:做|继续)吗|你希望我)/.test(text);
}

/**
 * The closing lines of the reply. A promise near the end is what "stops
 * mid-task"; the same phrase early in a full answer ("我先确认一下你的问题…"
 * followed by the actual answer) is not.
 */
function closingLines(text: string, count = 2): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-count).join("\n");
}

/** Imperative work verbs: the user asked for changes, not for an explanation. */
const ACTION_REQUEST = /(?:改|加|新增|删除|修复|修一下|实现|创建|新建|写一?个|重构|优化|部署|上线|调试|排查|测试|跑一下|升级|迁移|替换|接入|补一个|fix|add|implement|create|refactor|deploy|migrate|update|debug|test|write)/i;

const MAX_CRITERIA = 8;
const SCAN_LIMIT = 4000;

/**
 * Extract acceptance criteria the user wrote explicitly. Mirrors the bridge's
 * `extractAcceptance` (ui/server/services/commanderLoop.js) so the in-turn gate
 * and the outer commander loop read the same list.
 */
export function extractAcceptanceCriteria(text: string | undefined): string[] {
  const source = String(text ?? "");
  if (!source.trim()) return [];
  const lines = source.split(/\r?\n/);
  const marker = /(?:完成条件|验收标准|验收条件|验收|acceptance(?:\s+criteria)?)\s*[:：]/i;
  const start = lines.findIndex((line) => marker.test(line));
  if (start === -1) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.、)])\s+(.*\S)\s*$/);
    if (bullet) {
      items.push(bullet[1].replace(/^\[[ xX]\]\s*/, "").trim());
      continue;
    }
    if (!line.trim()) continue;
    break;
  }
  if (items.length === 0) {
    // Inline form: "做登录页，验收：320px 下不出现横向滚动" — keep only the
    // text after the marker, not the whole sentence.
    const match = lines[start]!.match(marker);
    const inline = match
      ? lines[start]!.slice((match.index ?? 0) + match[0].length).trim().replace(/^[，,、]\s*/, "")
      : "";
    if (inline) items.push(inline);
  }
  return items.filter(Boolean).slice(0, MAX_CRITERIA);
}

function tail(text: string): string {
  return text.length > SCAN_LIMIT ? text.slice(-SCAN_LIMIT) : text;
}

/**
 * Text of the most recent *real* user prompt, for the Stop self-check payload.
 * Skips system-injected messages (hook context, transient recovery prompts)
 * so the hook judges the task, not its own nudge.
 */
export function lastUserPromptText(messages: readonly CanonicalMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (message.metadata?.purpose === "hook_context") continue;
    if (message.metadata?.transient) continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function continueWith(reason: StopSelfCheckContinueReason, message: string): StopSelfCheckResult {
  return { action: "continue", reason, message };
}

/**
 * Decide whether the model stopped too early. Rules are ordered; the first
 * matching rule wins.
 */
export function assessStopSelfCheck(input: StopSelfCheckInput): StopSelfCheckResult {
  const text = tail(String(input.lastAssistantMessage ?? "").trim());

  // The hook already pushed the loop forward once this turn. Repeating the
  // same nudge only burns tokens; let the outer layers (commander loop /
  // user) decide.
  if (input.stopHookActive) return { action: "approve", reason: "already_continuation" };
  if (!text) return { action: "approve", reason: "empty_response" };

  // Ending the turn is correct when the model is waiting on a human.
  if (AWAITING_USER.test(text)) return { action: "approve", reason: "awaiting_user" };
  if (OFFERS_NEXT_STEPS.test(text)) return { action: "approve", reason: "awaiting_user" };
  if (asksUserQuestion(text)) return { action: "approve", reason: "asked_question" };

  const tools = input.toolsUsedThisTurn ?? [];
  const toolsCount = tools.length;
  const criteria = extractAcceptanceCriteria(input.lastUserMessage);
  const userWantsWork = criteria.length > 0 || ACTION_REQUEST.test(String(input.lastUserMessage ?? ""));
  const claimsDone = COMPLETION_CLAIM.test(text);

  // 1. The model said something is still outstanding, then stopped anyway.
  if (UNFINISHED_MARKER.test(text)) {
    return continueWith("unfinished_marker", [
      "[自检] 你的上一条回复里说明还有未完成项，但本轮已经收尾。",
      "请立刻继续把这些项做完（用工具实际执行），完成后逐条给出结果与证据；不要在回复里只描述计划。",
    ].join("\n"));
  }

  // 2. A plan with no action behind it — the classic premature stop.
  if (PROMISE_MARKER.test(closingLines(text)) && toolsCount === 0) {
    return continueWith("promised_without_action", [
      "[自检] 你上一条回复只描述了下一步要做什么，但本轮没有执行任何工具，任务实际没有推进。",
      "请现在就动手执行你刚说的步骤，直接调用工具完成，不要重复描述计划。",
    ].join("\n"));
  }

  // 3. "Done" with zero tool activity on a turn the user expected work from.
  if (claimsDone && toolsCount === 0 && userWantsWork) {
    return continueWith("claimed_done_without_action", [
      "[自检] 你声明任务已完成，但本轮没有执行任何工具，没有可核对的实际改动。",
      "请实际执行所需操作（读文件确认现状、改代码、跑验证），再给出带证据的完成说明。",
    ].join("\n"));
  }

  // 4. The user wrote explicit acceptance criteria, the turn ended without
  //    saying whether they are met. Ask for a per-item verdict once.
  if (criteria.length > 0 && !claimsDone) {
    return continueWith("criteria_unverified", [
      "[自检] 用户给出了完成条件，但你的回复没有逐条确认是否满足：",
      ...criteria.map((item, index) => `${index + 1}. ${item}`),
      "请逐条对照：已满足的给出证据（文件、命令输出、测试结果），未满足的立刻继续做。",
    ].join("\n"));
  }

  return { action: "approve", reason: "ok" };
}
