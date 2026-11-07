import test from "node:test";
import assert from "node:assert/strict";

import { mapAgentEvent } from "./InProcessGateway.js";
import type { AgentEvent } from "../../agent/index.js";

type Frame = { type: string; event?: string; detail?: Record<string, unknown>; runId?: string };

const QUEUED: AgentEvent = {
  type: "subagent_queued",
  sessionId: "sess-1",
  turnId: "turn-1",
  subagentId: "sub-1",
  subagentType: "explore",
  toolCallId: "call-1",
  running: 3,
  pending: 1,
  limit: 3,
};

test("gateway: a fork waiting for a slot reaches the UI as agent_status", () => {
  const frames = mapAgentEvent(QUEUED, "run-1") as unknown as Frame[];
  assert.equal(frames.length, 1, "queued must produce exactly one frame");
  const frame = frames[0];
  assert.equal(frame.type, "agent_status");
  assert.equal(frame.event, "subagent_queued");
  assert.equal(frame.runId, "run-1");
  assert.equal(frame.detail?.subagentId, "sub-1");
  assert.equal(frame.detail?.subagentType, "explore");
  assert.equal(frame.detail?.toolCallId, "call-1");
  assert.equal(frame.detail?.running, 3);
  assert.equal(frame.detail?.pending, 1);
  assert.equal(frame.detail?.limit, 3);
});

test("gateway: the queue depth survives the trip, it is not hardcoded", () => {
  const frames = mapAgentEvent(
    { ...QUEUED, running: 1, pending: 7, limit: 8 } as AgentEvent,
    "run-2",
  ) as unknown as Frame[];
  assert.equal(frames[0].detail?.running, 1);
  assert.equal(frames[0].detail?.pending, 7);
  assert.equal(frames[0].detail?.limit, 8);
});

test("gateway: unmapped internal events still stay in-process", () => {
  const elicitation = mapAgentEvent(
    {
      type: "elicitation_requested",
      sessionId: "sess-1",
      turnId: "turn-1",
      elicitationId: "elicit-1",
      toolCallId: "call-1",
      question: "which one",
      options: [],
    } as unknown as AgentEvent,
    "run-1",
  );
  assert.deepEqual(elicitation, [], "the default arm must keep swallowing unmapped events");
});