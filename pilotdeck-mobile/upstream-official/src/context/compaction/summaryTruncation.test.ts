import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMessage, CanonicalModelEvent } from "../../model/index.js";
import { CompactionEngine, COMPACT_MAX_OUTPUT_TOKENS } from "./CompactionEngine.js";

// Regression guard for defect A in docs/HANDOFF-Windows-20261105.md section 2.2.
// A summary that hits the output token limit used to throw, which made full
// compaction fail, tripped the summary-failure cooldown and let the session grow
// forever (observed: 2.8 MB / 146 messages / 86k tokens, repeating
// full_compaction_no_summary) until the gateway died. COMPACT_MAX_OUTPUT_TOKENS
// is only 4000, so a truncated summary is an expected everyday outcome, not an
// error: the partial text must be kept and compaction must complete.

const text = (role: "user" | "assistant", value: string): CanonicalMessage => ({
  role,
  content: [{ type: "text", text: value }],
});

const history = (): CanonicalMessage[] =>
  Array.from({ length: 40 }, (_, index) =>
    text(index % 2 ? "assistant" : "user", `message ${index}: ${"detail ".repeat(40)}`),
  );

const HEADING = (name: string) => `## ${name}\nsome content`;

/** Full markdown summary, but stopped early by the provider (finishReason length). */
function fakeModel(finishReason: "length" | "stop"): {
  model: { stream(): AsyncIterable<CanonicalModelEvent> };
  requests: number;
} {
  const state = { requests: 0 };
  return {
    requests: state.requests,
    model: {
      async *stream() {
        state.requests += 1;
        for (const heading of ["Objective", "Current State", "Completed", "Remaining"]) {
          yield { type: "text_delta", text: `${HEADING(heading)}\n` };
        }
        if (finishReason === "length") {
          // Cut off mid-sentence, exactly like a token-limit stop.
          yield { type: "text_delta", text: "\n## Decisions\nwe decided tha" };
        } else {
          for (const heading of ["Decisions", "Files And Artifacts", "Tool Findings", "Errors And Recovery"]) {
            yield { type: "text_delta", text: `${HEADING(heading)}\n` };
          }
        }
        yield { type: "message_end", finishReason: finishReason as never };
      },
    },
  };
}

const engineFor = (finishReason: "length" | "stop") => {
  const fake = fakeModel(finishReason);
  return {
    fake,
    engine: new CompactionEngine({
      model: fake.model,
      provider: "test",
      model_: "test-model",
      maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
    }),
  };
};

test("truncated summary is accepted so compaction still completes", async () => {
  const { engine } = engineFor("length");
  const result = await engine.run({ trigger: "manual", messages: history() });

  assert.equal(result.error, undefined, `compaction failed: ${result.error}`);
  assert.equal(result.summaryGenerated, true, "partial summary must count as generated");
  assert.ok(result.summaryMessage, "summary message must be written");

  const summaryText = result.summaryMessage!.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  assert.ok(summaryText.includes("we decided tha"), "partial text must be preserved");
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "compact_summary_failed"),
    false,
    "a truncated summary must not be reported as a failure",
  );
});

test("a clean summary is unaffected by the truncation tolerance", async () => {
  const { engine } = engineFor("stop");
  const result = await engine.run({ trigger: "manual", messages: history() });
  assert.equal(result.error, undefined);
  assert.equal(result.summaryGenerated, true);
});

test("truncation does not arm the summary-failure cooldown", async () => {
  const { engine } = engineFor("length");
  const first = await engine.run({ trigger: "manual", messages: history() });
  assert.equal(first.summaryGenerated, true);

  // A second pass must still reach the model. Before the fix the first failure
  // armed a cooldown, so every later pass silently degraded to no summary.
  const second = await engine.run({ trigger: "auto", messages: history() });
  assert.equal(second.error, undefined, `second pass failed: ${second.error}`);
  assert.equal(second.summaryGenerated, true, "cooldown must not be armed by a truncated summary");
});

test("empty model output is still a real failure", async () => {
  const engine = new CompactionEngine({
    model: {
      async *stream() {
        yield { type: "message_end", finishReason: "stop" } as CanonicalModelEvent;
      },
    },
    provider: "test",
    model_: "test-model",
  });
  const result = await engine.run({ trigger: "manual", messages: history() });
  assert.equal(result.summaryGenerated, false, "empty output must not count as a summary");
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "compact_summary_failed"),
    "empty output must be reported",
  );
});