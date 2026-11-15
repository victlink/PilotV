# Model routing

Chooses model routes and orchestrates provider health, fallback chains and configured routing policy.

Entry points: [index.ts](index.ts), [RouterRuntime.ts](RouterRuntime.ts), [runFallbackChain.ts](fallback/runFallbackChain.ts).

Honor explicit request selections and reference validation before applying automatic routing or fallback.

Turn cancellation reaches judge requests and retry delays. Optional execution callbacks project resolved context for each selected/fallback model and finalize it after routing patches and media conversion. Cache identity follows the final request; provider changes never reuse another model's plan. Callers without these callbacks retain the ordinary canonical-request interface.

Task classification and legacy subagent tags read actual user requests through the shared model-message predicate. Request-only memory, artifact indexes, date notices and other synthetic context remain available to the answering model without selecting its routing tier or subagent identity. Synthetic context alone does not activate sticky routing; actual conversation history retains that behavior.

## Rate-limit recovery

Provider/model health is tracked process-wide (not per session) by `ProviderHealthTracker`. A 429 opens the circuit immediately and records a cooldown from the provider's `Retry-After` (capped at five minutes; otherwise 30s). While the circuit is open, `decide()` routes straight to a healthy configured fallback instead of re-hitting the limited model on every turn, and the session sticky still remembers the operator-configured primary.

When the cooldown elapses the circuit moves to `half_open`; exactly one probe request is allowed through to the original model. A successful probe restores `healthy` and emits `pilotdeck_router_provider_recovered` (surfaced in the chat as a switch-back status); a failed probe re-opens the circuit. A stale probe is released after 60s so an aborted turn cannot wedge recovery. Cooldown skips and switch-backs are also recorded as `pilotdeck_router_provider_cooldown` events and `mutations.providerHealthRerouted`.

An explicitly fixed model never drifts by default. `router.fallback.allowFallbackOnRateLimit: true` opts it into the fallback chain for 429 only; all other errors still return as-is. In-place retries for 429 are capped at 3 in `model/streaming/streamModel.ts` so fallback is not delayed by the generic 5-retry budget.

Tests: [RateLimitRecovery.test.ts](RateLimitRecovery.test.ts), [tests/router](../../tests/router). See the [test guide](../../docs/testing.md) for runner selection.
