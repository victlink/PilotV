import test from "node:test";
import assert from "node:assert/strict";
import { streamModel, RATE_LIMIT_MAX_RETRIES } from "./streamModel.js";
import { MODEL_RETRY_DEFAULTS } from "../config/retryDefaults.js";

const config = {
  providers: {
    p: {
      id: "p",
      protocol: "openai",
      url: "https://provider.example.test/v1",
      apiKey: "test-key",
      models: {
        m: {
          id: "m",
          capabilities: {
            supportsStreaming: true,
            supportsSystemPrompt: true,
            supportsToolUse: true,
          },
        },
      },
      retry: {
        requestMaxRetries: 5,
        streamMaxRetries: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
      },
    },
  },
} as never;

const request = {
  provider: "p",
  model: "m",
  messages: [],
  stream: true,
} as never;

async function collect(status: number) {
  let calls = 0;
  const progress: Array<{ attempt: number; maxAttempts: number; reason: string }> = [];
  const transport = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "upstream rejected" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as never;
  for await (const _ of streamModel(request, config, {
    fetch: transport,
    onRetryProgress: (p) => progress.push({
      attempt: p.attempt,
      maxAttempts: p.maxAttempts,
      reason: p.reason,
    }),
  })) { /* drain */ }
  return { calls, progress };
}

test("429 keeps the configured cap of 3 in-place retries", async () => {
  assert.equal(MODEL_RETRY_DEFAULTS.rateLimitMaxRetries, 3);
  assert.equal(RATE_LIMIT_MAX_RETRIES, 3);
  const { calls, progress } = await collect(429);
  // 1 initial request + 3 retries; the generic budget would be 6.
  assert.equal(calls, 4);
  assert.equal(progress.length, 3);
  assert.ok(progress.every((p) => p.maxAttempts === 3));
});

test("non-429 failures keep the generic 5-retry budget", async () => {
  const { calls, progress } = await collect(503);
  assert.equal(calls, 6);
  assert.equal(progress.length, 5);
  assert.ok(progress.every((p) => p.maxAttempts === 5));
});
