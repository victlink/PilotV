import assert from "node:assert/strict";
import test from "node:test";

import { assessStopSelfCheck, extractAcceptanceCriteria, lastUserPromptText } from "./stopSelfCheck.js";

function userMessage(text: string, metadata?: Record<string, unknown>) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], metadata };
}

test("lastUserPromptText: skips hook context and transient prompts", () => {
  const messages = [
    userMessage("把登录页改成手机可用"),
    { role: "assistant" as const, content: [{ type: "text" as const, text: "好的" }] },
    userMessage('<hook_context source="callback">\n[自检] 继续\n</hook_context>', { synthetic: true, purpose: "hook_context" }),
    userMessage("Output token limit hit. Resume directly", { synthetic: true, transient: true }),
  ];
  assert.equal(lastUserPromptText(messages), "把登录页改成手机可用");
});

test("lastUserPromptText: falls back to undefined when there is no prompt", () => {
  assert.equal(lastUserPromptText([]), undefined);
  assert.equal(lastUserPromptText([
    userMessage('<hook_context source="callback">x</hook_context>', { purpose: "hook_context" }),
  ]), undefined);
});

test("extractAcceptanceCriteria: bulleted block, numbered list, and inline form", () => {
  assert.deepEqual(
    extractAcceptanceCriteria("把登录页改成手机可用\n完成条件：\n- 320px 下无横向滚动\n2. npm test 通过\n\n顺便看看配色"),
    ["320px 下无横向滚动", "npm test 通过"],
  );
  assert.deepEqual(extractAcceptanceCriteria("做登录页，验收：320px 下不出现横向滚动"), ["320px 下不出现横向滚动"]);
  assert.deepEqual(extractAcceptanceCriteria("把登录页改一下"), []);
  assert.deepEqual(extractAcceptanceCriteria(undefined), []);
});

test("approves when the turn is already a hook continuation", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "接下来我会补测试",
    toolsUsedThisTurn: [],
    stopHookActive: true,
  });
  assert.equal(result.action, "approve");
  assert.equal(result.reason, "already_continuation");
});

test("approves empty replies (handled by the empty-output recovery path)", () => {
  assert.equal(assessStopSelfCheck({ lastAssistantMessage: "   " }).action, "approve");
});

test("approves when the model is waiting on the user", () => {
  for (const text of [
    "这个目录需要管理员权限，我无法继续，请提供授权。",
    "以上是分析结果，需要我继续改代码吗？",
    "改完了，接下来你可以自行部署。如需我帮忙，随时说。",
  ]) {
    const result = assessStopSelfCheck({ lastAssistantMessage: text, toolsUsedThisTurn: [] });
    assert.equal(result.action, "approve", text);
  }
});

test("a question mark inside a report body is not a hand-off", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "为什么这里会慢？原因是 N+1 查询。\n接下来我会把批量查询补上。",
    toolsUsedThisTurn: [],
  });
  assert.equal(result.action, "continue");
  assert.equal(result.reason, "promised_without_action");
});

test("continues on an explicit unfinished marker", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "已经把路由改好了，但单元测试还没跑。",
    toolsUsedThisTurn: ["Edit"],
  });
  assert.equal(result.action, "continue");
  assert.equal(result.reason, "unfinished_marker");
  assert.match(result.message, /未完成项/);
});

test("continues when the reply only describes a plan and no tool ran", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "我先看一下现有实现，然后修改登录页并补齐测试。",
    lastUserMessage: "把登录页改成手机可用",
    toolsUsedThisTurn: [],
  });
  assert.equal(result.action, "continue");
  assert.equal(result.reason, "promised_without_action");
});

test("a plan that did run tools is left alone (work is in progress)", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "已经读完三个文件，接下来我会改样式。",
    lastUserMessage: "把登录页改成手机可用",
    toolsUsedThisTurn: ["Read", "Read", "Read"],
  });
  assert.equal(result.action, "approve");
});

test("continues when the reply claims done but nothing ran", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "登录页已经改好了，全部完成。",
    lastUserMessage: "把登录页改成手机可用",
    toolsUsedThisTurn: [],
  });
  assert.equal(result.action, "continue");
  assert.equal(result.reason, "claimed_done_without_action");
});

test("a completion claim after real work is approved", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "登录页已改好，npm test 通过。",
    lastUserMessage: "把登录页改成手机可用",
    toolsUsedThisTurn: ["Read", "Edit", "Bash"],
  });
  assert.equal(result.action, "approve");
});

test("continues once when stated criteria were never confirmed", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "我把布局调整了一下，你看看效果。",
    lastUserMessage: "做登录页\n完成条件：\n- 320px 下无横向滚动\n- npm test 通过",
    toolsUsedThisTurn: ["Edit"],
  });
  assert.equal(result.action, "continue");
  assert.equal(result.reason, "criteria_unverified");
  assert.match(result.message, /320px 下无横向滚动/);
  assert.match(result.message, /npm test 通过/);
});

test("criteria already confirmed are approved", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "已完成：320px 下无横向滚动（截图见上），npm test 通过（12 passed）。",
    lastUserMessage: "做登录页\n完成条件：\n- 320px 下无横向滚动\n- npm test 通过",
    toolsUsedThisTurn: ["Edit", "Bash"],
  });
  assert.equal(result.action, "approve");
});

test("plain Q&A turns are approved", () => {
  const result = assessStopSelfCheck({
    lastAssistantMessage: "这个函数负责把用户输入规范化后写入缓存。",
    lastUserMessage: "这个函数是干嘛的",
    toolsUsedThisTurn: ["Read"],
  });
  assert.equal(result.action, "approve");
});
