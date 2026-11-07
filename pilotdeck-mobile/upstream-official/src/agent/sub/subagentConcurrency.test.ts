import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  acquireSubagentSlot,
  createSubagentGate,
  resolveSubagentConcurrency,
} from "./subagentConcurrency.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("resolveSubagentConcurrency: env strings, fallbacks, and 0 meaning unlimited", () => {
  assert.equal(resolveSubagentConcurrency("5"), 5);
  assert.equal(resolveSubagentConcurrency(2), 2);
  assert.equal(resolveSubagentConcurrency("0"), 0, "0 = explicitly unlimited");
  assert.equal(resolveSubagentConcurrency(0), 0);
  assert.equal(resolveSubagentConcurrency(undefined), DEFAULT_SUBAGENT_CONCURRENCY);
  // A typo must not turn into NaN and silently disable the gate.
  assert.equal(resolveSubagentConcurrency("three"), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency(""), DEFAULT_SUBAGENT_CONCURRENCY, "blank is unset, not unlimited");
  assert.equal(resolveSubagentConcurrency("   "), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency(-1), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency(NaN), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency(2.9), 2, "fractional floors down");
});

test("gate caps concurrent acquisitions at the limit", async () => {
  const gate = createSubagentGate(2);
  const a = await gate.acquire();
  const b = await gate.acquire();
  assert.equal(gate.running(), 2);

  let thirdStarted = false;
  const third = gate.acquire().then((slot) => {
    thirdStarted = true;
    return slot;
  });
  await tick();
  assert.equal(thirdStarted, false, "third must wait");
  assert.equal(gate.pending(), 1);

  a.release();
  const c = await third;
  assert.equal(thirdStarted, true);
  assert.equal(gate.pending(), 0);
  assert.equal(gate.running(), 2, "released slot got reused");
  b.release();
  c.release();
  assert.equal(gate.running(), 0);
});

test("gate serves waiters in arrival order", async () => {
  const gate = createSubagentGate(1);
  const order: string[] = [];
  const first = await gate.acquire();
  const waiters = ["x", "y", "z"].map(async (name) => {
    const slot = await gate.acquire();
    order.push(name);
    return slot;
  });
  await tick();
  assert.deepEqual(order, [], "all three are queued");
  first.release();
  const s1 = await waiters[0];
  // Releasing must let the next in line in, one at a time.
  s1.release();
  const s2 = await waiters[1];
  s2.release();
  const s3 = await waiters[2];
  s3.release();
  assert.deepEqual(order, ["x", "y", "z"]);
});

test("gate: limit <= 0 means unlimited, not blocked", async () => {
  const gate = createSubagentGate(0);
  const slots = await Promise.all([gate.acquire(), gate.acquire(), gate.acquire(), gate.acquire()]);
  assert.equal(gate.running(), 4);
  assert.equal(gate.pending(), 0);
  slots.forEach((slot) => slot.release());
  assert.equal(gate.running(), 0);
});

test("gate re-reads the limit per acquire (settings change at runtime)", async () => {
  let configured = 1;
  const gate = createSubagentGate(() => configured);
  const first = await gate.acquire();
  let secondIn = false;
  const second = gate.acquire().then((slot) => {
    secondIn = true;
    return slot;
  });
  await tick();
  assert.equal(secondIn, false);

  configured = 3; // operator raises the cap while a waiter is queued
  gate.refresh(); // the host calls this from its settings-change path
  const secondSlot = await second;
  assert.equal(secondIn, true, "the raised limit must admit the queued waiter");
  first.release();
  secondSlot.release();
});

test("gate: an aborted waiter must not consume a slot or stall the queue", async () => {
  const gate = createSubagentGate(1);
  const held = await gate.acquire();

  const abortedController = new AbortController();
  const aborted = gate.acquire({ signal: abortedController.signal });
  const queued = new AbortController();
  const survivor = gate.acquire({ signal: queued.signal });

  await tick();
  assert.equal(gate.pending(), 2);
  abortedController.abort();
  await assert.rejects(() => aborted, /aborted/);
  assert.equal(gate.pending(), 1, "the cancelled waiter left the queue");
  assert.equal(gate.running(), 1, "a cancelled waiter never took a slot");

  held.release();
  const slot = await survivor; // would deadlock if the gate had lost its turn
  assert.equal(gate.running(), 1);
  slot.release();
  assert.equal(gate.running(), 0);
});

test("gate: acquiring with an already-aborted signal rejects immediately", async () => {
  const gate = createSubagentGate(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => gate.acquire({ signal: controller.signal }), /aborted/);
  assert.equal(gate.running(), 0);
});

test("gate: a release storm never drives running() negative", async () => {
  const gate = createSubagentGate(2);
  const a = await gate.acquire();
  a.release();
  a.release();
  a.release();
  assert.equal(gate.running(), 0);
  // Still usable afterwards.
  const b = await gate.acquire();
  assert.equal(gate.running(), 1);
  b.release();
});

test("gate: 20 concurrent acquires with limit 3 never exceed 3 in flight", async () => {
  const gate = createSubagentGate(3);
  let inFlight = 0;
  let peak = 0;
  const jobs = Array.from({ length: 20 }, async () => {
    const slot = await gate.acquire();
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
    slot.release();
  });
  await Promise.all(jobs);
  assert.equal(peak, 3, `peak concurrency was ${peak}`);
  assert.equal(gate.running(), 0);
  assert.equal(gate.pending(), 0);
});

test("gate reports its effective limit for diagnostics", () => {
  assert.equal(createSubagentGate(4).limit(), 4);
  assert.equal(createSubagentGate(() => 7).limit(), 7);
});

test("gate: refresh() with an unchanged limit wakes nobody it should not", async () => {
  const gate = createSubagentGate(1);
  const held = await gate.acquire();
  let woke = false;
  const waiting = gate.acquire().then((slot) => {
    woke = true;
    return slot;
  });
  await tick();
  gate.refresh();
  gate.refresh();
  await tick();
  assert.equal(woke, false, "still at the limit: refresh must not over-admit");
  held.release();
  const slot = await waiting;
  assert.equal(woke, true);
  slot.release();
});

test("acquireSubagentSlot: no gate means no wait and no slot to release", async () => {
  assert.equal(await acquireSubagentSlot(undefined), null);
  let notified = 0;
  const slot = await acquireSubagentSlot(undefined, { onQueued: () => { notified += 1; } });
  assert.equal(slot, null);
  assert.equal(notified, 0, "nothing was queued, so nothing to announce");
});

test("acquireSubagentSlot: an immediately available slot must not announce a queue", async () => {
  const gate = createSubagentGate(2);
  const notices: { running: number; pending: number; limit: number }[] = [];
  const slot = await acquireSubagentSlot(gate, { onQueued: (state) => notices.push(state) });
  assert.ok(slot);
  assert.deepEqual(notices, [], "starting at once must not look like queueing");
  slot!.release();
});

test("acquireSubagentSlot: a real wait announces the queue exactly once, before running", async () => {
  const gate = createSubagentGate(1);
  const held = await acquireSubagentSlot(gate);
  assert.ok(held);

  const notices: { running: number; pending: number; limit: number }[] = [];
  let started = false;
  const waiting = acquireSubagentSlot(gate, {
    onQueued: (state) => notices.push(state),
  }).then((slot) => {
    started = true;
    return slot;
  });

  await tick();
  assert.equal(started, false);
  assert.equal(notices.length, 1, "one queued subagent is one notice, not one per poll");
  assert.deepEqual(notices[0], { running: 1, pending: 1, limit: 1 },
    "the count must include the caller: a UI saying 0 waiting while one waits is a lie");

  held!.release();
  const slot = await waiting;
  assert.equal(started, true);
  assert.equal(notices.length, 1, "getting the slot must not re-announce");
  slot!.release();
});

test("acquireSubagentSlot: cancel while queued rejects and leaves the pool intact", async () => {
  const gate = createSubagentGate(1);
  const held = await acquireSubagentSlot(gate);
  const controller = new AbortController();
  let notices = 0;
  const waiting = acquireSubagentSlot(gate, {
    signal: controller.signal,
    onQueued: () => { notices += 1; },
  });
  await tick();
  assert.equal(notices, 1);
  controller.abort();
  await assert.rejects(() => waiting, /aborted/);
  assert.equal(gate.running(), 1, "only the holder has a slot");
  held!.release();
  assert.equal(gate.running(), 0);
  // Pool still usable: a leaked slot here would eventually freeze all forking.
  const next = await acquireSubagentSlot(gate);
  assert.ok(next);
  next!.release();
});

test("acquireSubagentSlot: three forks on a limit-2 pool run two, then the third", async () => {
  const gate = createSubagentGate(2);
  const order: number[] = [];
  const queuedNotices: number[] = [];
  const jobs = [1, 2, 3].map(async (id) => {
    const slot = await acquireSubagentSlot(gate, {
      onQueued: (state) => queuedNotices.push(state.pending),
    });
    order.push(id);
    await tick();
    order.push(-id);
    slot!.release();
  });
  await Promise.all(jobs);
  // order entries are +id on start and -id on finish.
  assert.deepEqual(order.slice(0, 2), [1, 2], "the first two start immediately");
  assert.deepEqual(queuedNotices, [1], "only the third ever waited");
  // The real invariant is not "third starts after both finish" — it starts the
  // moment ANY slot frees. Walk the log and assert in-flight never exceeded 2.
  let inFlight = 0;
  let peak = 0;
  for (const entry of order) {
    if (entry > 0) { inFlight += 1; peak = Math.max(peak, inFlight); }
    else inFlight -= 1;
    assert.ok(inFlight <= 2, `limit-2 pool went over: ${order.join(',')}`);
  }
  assert.equal(peak, 2, `peak was ${peak}, expected 2`);
  assert.ok(order.indexOf(3) > order.indexOf(-1),
    `the third fork must wait for a slot to free: ${order.join(',')}`);
  assert.equal(order[order.length - 1], -3, "and it is the last to finish");
  assert.equal(gate.running(), 0);
});
