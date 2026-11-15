import test from "node:test";
import assert from "node:assert/strict";
import { createRouterRuntime } from "./RouterRuntime.js";
import { ProviderHealthTracker } from "./health/ProviderHealthTracker.js";
import type { RouterEvent } from "./protocol/events.js";
import type { ModelRuntime } from "../model/index.js";

const PRIMARY = { id: "p/primary", provider: "p", model: "primary" };
const BACKUP = { id: "p/backup", provider: "p", model: "backup" };

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    scenarios: { default: PRIMARY },
    fallback: {
      default: [BACKUP],
      maxFallbacks: 3,
      ...((overrides.fallback as Record<string, unknown>) ?? {}),
    },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    ...overrides,
  } as never;
}

function rateLimitError(provider: string, retryAfterMs = 1_000) {
  return {
    type: "error",
    error: {
      provider,
      protocol: "openai",
      code: "rate_limit_error",
      message: "Rate limit exceeded",
      retryable: true,
      retryAfterMs,
    },
  };
}

function serverError(provider: string) {
  return {
    type: "error",
    error: {
      provider,
      protocol: "openai",
      code: "server_error",
      message: "upstream failed",
      retryable: true,
    },
  };
}

function successEvent() {
  return { type: "text_delta", text: "ok" };
}

type Harness = {
  router: ReturnType<typeof createRouterRuntime>;
  seen: string[];
  events: RouterEvent[];
  setPrimaryRateLimited: (value: boolean) => void;
  setPrimaryError: (kind: "rate_limit" | "server") => void;
  advance: (ms: number) => void;
};

function makeHarness(opts: {
  config?: Record<string, unknown>;
  now: () => Date;
  advance: (ms: number) => void;
  primaryInitiallyLimited?: boolean;
}): Harness {
  const seen: string[] = [];
  const events: RouterEvent[] = [];
  let primaryRateLimited = opts.primaryInitiallyLimited ?? true;
  let primaryErrorKind: "rate_limit" | "server" = "rate_limit";

  const runtime = {
    getCapabilities: () => ({}),
    getMultimodal: () => undefined,
    getProviderProtocol: () => "openai",
    async *stream(request: { provider: string; model: string }) {
      seen.push(`${request.provider}/${request.model}`);
      if (request.model === "primary" && primaryRateLimited) {
        yield primaryErrorKind === "rate_limit"
          ? rateLimitError(request.provider)
          : serverError(request.provider);
        return;
      }
      yield successEvent();
    },
  } as unknown as ModelRuntime;

  const router = createRouterRuntime(makeConfig(opts.config), {
    modelRuntime: runtime,
    events: { emit: (event) => events.push(event) },
    now: opts.now,
  });

  return {
    router,
    seen,
    events,
    setPrimaryRateLimited: (value) => { primaryRateLimited = value; },
    setPrimaryError: (kind) => { primaryErrorKind = kind; },
    advance: opts.advance,
  };
}

function makeRequest(provider = "p", model = "primary") {
  return { provider, model, messages: [], stream: true } as never;
}

async function runTurn(h: Harness) {
  for await (const _ of h.router.stream(makeRequest(), {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
  })) {
    // drain
  }
}

test("429 → fallback → cooldown → half-open probe → switch back to primary", async () => {
  let clock = 0;
  const h = makeHarness({ now: () => new Date(clock), advance: (ms) => { clock += ms; } });
  try {
    // Turn 1: primary is rate limited, fallback serves the turn.
    await runTurn(h);
    assert.deepEqual(h.seen, ["p/primary", "p/backup"]);
    assert.ok(h.events.some((e) => e.type === "pilotdeck_router_fallback"));

    // Turn 2 (still inside cooldown): decide() must skip the limited primary
    // entirely instead of eating a guaranteed 429 on every turn.
    h.seen.length = 0;
    await runTurn(h);
    assert.deepEqual(h.seen, ["p/backup"]);
    const decision = h.events.filter((e) => e.type === "pilotdeck_router_decision").at(-1);
    assert.equal(decision?.type, "pilotdeck_router_decision");
    if (decision?.type === "pilotdeck_router_decision") {
      assert.equal(decision.decision.model, "backup");
      assert.ok(decision.decision.mutations.providerHealthRerouted);
    }
    assert.ok(h.events.some((e) => e.type === "pilotdeck_router_provider_cooldown"));

    // Cooldown elapses: exactly one half-open probe is allowed to hit primary.
    h.advance(31_000);
    h.setPrimaryRateLimited(false);
    h.seen.length = 0;
    await runTurn(h);
    assert.deepEqual(h.seen, ["p/primary"]);
    assert.ok(
      h.events.some(
        (e) => e.type === "pilotdeck_router_provider_recovered" && e.restoredAsPrimary,
      ),
    );

    // Turn 4: healthy again, no health reroute mutation.
    h.seen.length = 0;
    await runTurn(h);
    assert.deepEqual(h.seen, ["p/primary"]);
    const lastDecision = h.events.filter((e) => e.type === "pilotdeck_router_decision").at(-1);
    if (lastDecision?.type === "pilotdeck_router_decision") {
      assert.equal(lastDecision.decision.mutations.providerHealthRerouted, undefined);
    }
  } finally {
    await h.router.shutdown();
  }
});

test("health state is shared across sessions of the same runtime", async () => {
  let clock = 0;
  const h = makeHarness({ now: () => new Date(clock), advance: (ms) => { clock += ms; } });
  try {
    await runTurn(h);
    h.seen.length = 0;
    for await (const _ of h.router.stream(makeRequest(), {
      sessionId: "another-session",
      turnId: "t2",
      isMainAgent: true,
    })) { /* drain */ }
    assert.deepEqual(h.seen, ["p/backup"]);
  } finally {
    await h.router.shutdown();
  }
});

test("half-open allows exactly one probe and recovers only on success", () => {
  let clock = 0;
  const tracker = new ProviderHealthTracker({
    now: () => clock,
    openDurationMs: 1_000,
    maxCooldownMs: 60_000,
  });
  tracker.recordFailure("p/primary", { code: "rate_limit_error", retryAfterMs: 1_000 });
  assert.equal(tracker.getState("p/primary"), "open");
  assert.equal(tracker.isCoolingDown("p/primary"), true);
  assert.equal(tracker.tryAcquireProbe("p/primary"), false);

  clock = 1_001;
  assert.equal(tracker.getState("p/primary"), "half_open");
  assert.equal(tracker.tryAcquireProbe("p/primary"), true);
  assert.equal(tracker.tryAcquireProbe("p/primary"), false);
  assert.equal(tracker.recordSuccess("p/primary"), true);
  assert.equal(tracker.getState("p/primary"), "healthy");

  // A failed probe re-opens the circuit with a refreshed cooldown.
  tracker.recordFailure("p/primary", { code: "rate_limit_error", retryAfterMs: 2_000 });
  assert.equal(tracker.getState("p/primary"), "open");
  tracker.recordFailure("p/primary", { code: "rate_limit_error" });
  assert.equal(tracker.getState("p/primary"), "open");
});

test("a stale half-open probe cannot wedge the circuit", () => {
  let clock = 0;
  const tracker = new ProviderHealthTracker({
    now: () => clock,
    openDurationMs: 1_000,
    probeTimeoutMs: 5_000,
  });
  tracker.recordFailure("p/primary", { code: "rate_limit_error" });
  clock = 1_001;
  assert.equal(tracker.tryAcquireProbe("p/primary"), true);
  assert.equal(tracker.tryAcquireProbe("p/primary"), false);
  clock += 5_001;
  assert.equal(tracker.tryAcquireProbe("p/primary"), true);
});

async function runExplicit(errorKind: "rate_limit" | "server", allow: boolean) {
  const seen: string[] = [];
  const runtime = {
    getCapabilities: () => ({}),
    getMultimodal: () => undefined,
    getProviderProtocol: () => "openai",
    async *stream(request: { provider: string; model: string }) {
      seen.push(`${request.provider}/${request.model}`);
      if (request.model === "fixed") {
        yield errorKind === "rate_limit" ? rateLimitError(request.provider) : serverError(request.provider);
        return;
      }
      yield successEvent();
    },
  } as unknown as ModelRuntime;
  const router = createRouterRuntime(
    makeConfig({ fallback: { default: [BACKUP], allowFallbackOnRateLimit: allow } }),
    { modelRuntime: runtime },
  );
  try {
    for await (const _ of router.execute(
      {
        provider: "p",
        model: "fixed",
        scenarioType: "explicit",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "explicit",
        mutations: {},
      },
      makeRequest("p", "fixed"),
      { sessionId: "s", turnId: "t" },
    )) { /* drain */ }
  } finally {
    await router.shutdown();
  }
  return seen;
}

test("explicit fixed model never drifts by default", async () => {
  assert.deepEqual(await runExplicit("rate_limit", false), ["p/fixed"]);
});

test("explicit fixed model may drift on 429 when opted in", async () => {
  assert.deepEqual(await runExplicit("rate_limit", true), ["p/fixed", "p/backup"]);
});

test("explicit fixed model still refuses non-429 fallback when opted in", async () => {
  assert.deepEqual(await runExplicit("server", true), ["p/fixed"]);
});
