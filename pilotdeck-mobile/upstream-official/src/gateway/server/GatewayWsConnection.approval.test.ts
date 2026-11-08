import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWebPermissionDecisionParams } from "./GatewayWsConnection.js";

test("web permission decisions force web origin and trim actor", () => {
  // The websocket entry point authenticates a token, not a user: it has no
  // authenticated user identity, so the actor it forwards is whatever the
  // client reported — `actorSource` must say so explicitly, otherwise the
  // audit trail would claim a channel-verified identity.
  const result = normalizeWebPermissionDecisionParams({
    sessionKey: "s",
    requestId: "r",
    decision: "allow",
    origin: "im",
    actor: "  Alice  ",
    remember: true,
    reason: "ok",
  });
  assert.deepEqual(result, {
    sessionKey: "s", requestId: "r", decision: "allow", origin: "web",
    actor: "Alice", actorSource: "client_reported", remember: true, reason: "ok",
  });
});

test("web permission decisions are always marked as client reported", () => {
  // Even without an actor the provenance is fixed: the WS entry point can
  // never authenticate the sender, so the decision must not be trusted as a
  // channel identity.
  const result = normalizeWebPermissionDecisionParams({
    sessionKey: "s",
    requestId: "r",
    decision: "deny",
  });
  assert.equal(result.actorSource, "client_reported");
  assert.equal(result.origin, "web");
});

test("web permission decisions clear blank or overlong actors", () => {
  assert.equal(normalizeWebPermissionDecisionParams({ sessionKey: "s", requestId: "r", decision: "deny", actor: "   " }).actor, undefined);
  assert.equal(normalizeWebPermissionDecisionParams({ sessionKey: "s", requestId: "r", decision: "deny", actor: "x".repeat(129) }).actor, undefined);
});

test("web permission decisions reject invalid decisions", () => {
  assert.throws(() => normalizeWebPermissionDecisionParams({ sessionKey: "s", requestId: "r", decision: "maybe" }), /allow or deny/);
});
