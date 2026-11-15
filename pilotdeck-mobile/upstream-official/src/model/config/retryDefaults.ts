// Browser-safe defaults shared by the model runtime and its settings editor.
export const MODEL_RETRY_DEFAULTS = Object.freeze({
  requestMaxRetries: 5,
  streamMaxRetries: 5,
  // A 429 is a deterministic quota signal, not a blip: retrying the same
  // limited model five times only delays the router's fallback. Cap it at 3.
  rateLimitMaxRetries: 3,
  streamIdleTimeoutMs: 600_000,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: 0.1,
});
