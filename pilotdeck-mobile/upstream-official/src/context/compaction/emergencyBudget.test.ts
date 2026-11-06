import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMessage } from "../../model/index.js";
import { truncateHeadPreservingCheckpointToBudget } from "./CompactionEngine.js";

const text = (role: "user" | "assistant", value: string): CanonicalMessage => ({ role, content: [{ type: "text", text: value }] });
const estimate = (messages: CanonicalMessage[]) => messages.reduce((sum, message) => sum + message.content.reduce((n, block) => n + (block.type === "text" ? block.text.length : 0), 0), 0);

test("emergency trim fits token budget even when last tenth of messages is heavy", () => {
  const messages: CanonicalMessage[] = Array.from({ length: 100 }, (_, i) => text(i % 2 ? "assistant" : "user", i < 90 ? "old" : "X".repeat(1000)));
  messages.push(text("user", "current request"));
  const trimmed = truncateHeadPreservingCheckpointToBudget(messages, 3000, estimate);
  assert.ok(estimate(trimmed) <= 3000);
  assert.equal(trimmed.at(-1)?.content[0]?.type, "text");
  assert.equal((trimmed.at(-1)?.content[0] as { text: string }).text, "current request");
});

test("emergency trim retains paired tool calls and results", () => {
  const messages: CanonicalMessage[] = [
    text("user", "current request"),
    { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "search", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }] },
    text("assistant", "X".repeat(1000)),
    text("user", "latest request"),
  ];
  const trimmed = truncateHeadPreservingCheckpointToBudget(messages, 30, estimate);
  assert.deepEqual(trimmed, [messages[4]]);
});
