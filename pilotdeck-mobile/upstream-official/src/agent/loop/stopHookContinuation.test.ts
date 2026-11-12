import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STOP_HOOK_CONTINUATIONS, shouldContinueAfterStopHook } from "./stopHookContinuation.js";

test("continues only when the Stop hook produced messages", () => {
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 0,
    continuationCount: 0,
    turnCount: 1,
    aborted: false,
  }), false, "no messages means a normal end of turn");
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 2,
    continuationCount: 0,
    turnCount: 1,
    aborted: false,
  }), true, "messages from the hook request another iteration");
});

test("never continues after an abort", () => {
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 3,
    continuationCount: 0,
    turnCount: 1,
    aborted: true,
  }), false);
});

test("hard-caps chatty hooks even when maxTurns is unset", () => {
  // maxTurns undefined is the common case in this codebase; the hook must
  // not be able to loop forever.
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 1,
    continuationCount: MAX_STOP_HOOK_CONTINUATIONS,
    turnCount: 99,
    aborted: false,
  }), false, "cap reached");
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 1,
    continuationCount: MAX_STOP_HOOK_CONTINUATIONS - 1,
    turnCount: 99,
    aborted: false,
  }), true, "still below the cap");
  assert.ok(MAX_STOP_HOOK_CONTINUATIONS >= 1 && MAX_STOP_HOOK_CONTINUATIONS <= 5, "cap stays small");
});

test("respects maxTurns when the caller set one", () => {
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 1,
    continuationCount: 0,
    turnCount: 5,
    maxTurns: 5,
    aborted: false,
  }), false, "turn budget exhausted");
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 1,
    continuationCount: 0,
    turnCount: 4,
    maxTurns: 5,
    aborted: false,
  }), true, "one iteration left");
});

test("maxTurns=0 is treated as a real budget, not as unset", () => {
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 1,
    continuationCount: 0,
    turnCount: 1,
    maxTurns: 0,
    aborted: false,
  }), false, "0 budget means no hook continuation");
});

test("abort wins over everything else", () => {
  assert.equal(shouldContinueAfterStopHook({
    hookMessageCount: 1,
    continuationCount: 0,
    turnCount: 1,
    aborted: true,
  }), false);
});
