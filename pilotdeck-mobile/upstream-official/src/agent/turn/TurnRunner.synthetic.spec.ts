import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput } from "../protocol/input.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopRunResult,
  AgentLoopSeedState,
} from "../loop/AgentLoop.js";
import { InMemoryTranscriptWriter } from "../../session/transcript/InMemoryTranscriptWriter.js";
import { TurnInputProcessor } from "./TurnInputProcessor.js";
import { TurnRunner, type TurnRunnerOptions, type TurnRunnerResult } from "./TurnRunner.js";

/**
 * Regression coverage for the synthetic project-review turn.
 *
 * The automatic reviewer submits the turn with an empty user text and a
 * synthetic `project_agent_review_request` message. The empty user message
 * carries no information, so it must not reach the transcript or the model
 * request, while the synthetic request must survive untouched.
 */

/** Records the messages every turn hands to the agent loop. */
class RecordingAgentLoop {
  readonly turns: AgentLoopInput[] = [];

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.turns.push(input);
    const result: AgentTurnResult = {
      type: "success",
      sessionId: input.sessionId,
      turnId: input.turnId,
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.001Z",
    };
    yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
    return { result, messages: input.messages };
  }

  snapshotFileState(): AgentLoopSeedState {
    return {};
  }
}

type RunOutcome = {
  events: AgentEvent[];
  result: TurnRunnerResult;
  transcript: InMemoryTranscriptWriter;
  loop: RecordingAgentLoop;
};

async function runTurn(options: Partial<TurnRunnerOptions> = {}): Promise<RunOutcome> {
  const loop = new RecordingAgentLoop();
  const transcript = new InMemoryTranscriptWriter();
  const runner = new TurnRunner(
    loop as unknown as AgentLoop,
    transcript,
    new TurnInputProcessor(),
    () => new Date("2026-01-01T00:00:00.000Z"),
    undefined,
    { cwd: tmpdir(), transcriptPath: "", collectFileArtifacts: false },
  );

  const events: AgentEvent[] = [];
  const iterator = runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "" },
    ...options,
  });
  let step = await iterator.next();
  while (!step.done) {
    events.push(step.value);
    step = await iterator.next();
  }

  return { events, result: step.value, transcript, loop };
}

function acceptedInputMessages(transcript: InMemoryTranscriptWriter): CanonicalMessage[] {
  const entry = transcript.entries.find((item) => item.type === "accepted_input");
  assert.ok(entry, "the turn must record an accepted_input entry");
  return entry.type === "accepted_input" ? entry.messages : [];
}

function userTexts(messages: CanonicalMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text") texts.push(block.text);
    }
  }
  return texts;
}

function reviewRequest(): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "请审查上一轮的项目结果。" }],
    metadata: { synthetic: true, purpose: "project_agent_review_request" },
  };
}

test("a synthetic project review turn does not record an empty user message", async () => {
  const synthetic = reviewRequest();
  const outcome = await runTurn({
    input: { type: "text", text: "" },
    syntheticMessages: [synthetic],
  });

  assert.deepEqual(acceptedInputMessages(outcome.transcript), [synthetic]);
  assert.deepEqual(userTexts(acceptedInputMessages(outcome.transcript)), ["请审查上一轮的项目结果。"]);
});

test("a synthetic project review turn does not send an empty user message to the model", async () => {
  const synthetic = reviewRequest();
  const history: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "先做第一步。" }] },
  ];
  const outcome = await runTurn({
    messages: history,
    input: { type: "text", text: "" },
    syntheticMessages: [synthetic],
  });

  assert.equal(outcome.loop.turns.length, 1);
  const modelMessages = outcome.loop.turns[0].messages;
  assert.deepEqual(modelMessages, [...history, synthetic]);
  assert.deepEqual(userTexts(modelMessages), ["先做第一步。", "请审查上一轮的项目结果。"]);
});

test("the synthetic review request keeps its synthetic marker", async () => {
  const synthetic = reviewRequest();
  const outcome = await runTurn({
    input: { type: "text", text: "" },
    syntheticMessages: [synthetic],
  });

  const recorded = acceptedInputMessages(outcome.transcript);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].metadata?.synthetic, true);
  assert.equal(recorded[0].metadata?.purpose, "project_agent_review_request");
});

test("an ordinary empty input still records the empty user message", async () => {
  const outcome = await runTurn({ input: { type: "text", text: "" } });

  assert.deepEqual(acceptedInputMessages(outcome.transcript), [
    { role: "user", content: [{ type: "text", text: "" }] },
  ]);
  assert.deepEqual(userTexts(outcome.loop.turns[0].messages), [""]);
});

test("a non-empty user input keeps its user message next to the synthetic review", async () => {
  const synthetic = reviewRequest();
  const outcome = await runTurn({
    input: { type: "text", text: "开始审查" },
    syntheticMessages: [synthetic],
  });

  assert.deepEqual(acceptedInputMessages(outcome.transcript), [
    { role: "user", content: [{ type: "text", text: "开始审查" }] },
    synthetic,
  ]);
});

test("an attachment turn keeps its attachment blocks", async () => {
  const synthetic = reviewRequest();
  const attachment: CanonicalMessage = {
    role: "user",
    content: [
      { type: "text", text: "" },
      { type: "image", source: "base64", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
  };
  const outcome = await runTurn({
    input: { type: "blocks", content: attachment.content },
    syntheticMessages: [synthetic],
  });

  assert.deepEqual(acceptedInputMessages(outcome.transcript), [attachment, synthetic]);
});

test("a synthetic message with another purpose keeps the ordinary empty user message", async () => {
  const channelHint: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: "请把结果交付给用户。" }],
    metadata: { synthetic: true, purpose: "channel_hint" },
  };
  const outcome = await runTurn({
    input: { type: "text", text: "" },
    syntheticMessages: [channelHint],
  });

  assert.deepEqual(acceptedInputMessages(outcome.transcript), [
    { role: "user", content: [{ type: "text", text: "" }] },
    channelHint,
  ]);
});
