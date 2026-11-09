import test from "node:test";
import assert from "node:assert/strict";
import type { Gateway } from "../protocol/types.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import type { TextWebSocketConnection } from "./websocket.js";
import {
  GatewayWsConnection,
  WEB_PERMISSION_DECISION_REASONS,
  WebPermissionDecisionValidationError,
  normalizeWebPermissionDecisionParams,
} from "./GatewayWsConnection.js";

/**
 * B2/B3 — the websocket entry point of the approval center.
 *
 * B2: a decision that the gateway refused must reach the browser with the
 *      *reason*, not as an anonymous `delivered: false`.
 * B3: the payload is validated for real, and a browser can never claim an
 *      IM identity (`origin` is pinned to `web`, `actorSource` to
 *      `client_reported`).
 */

type FakeSocket = {
  connection: TextWebSocketConnection;
  sent: string[];
  deliver(message: string): void;
  responses(): Array<{ id: string; ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>;
};

function createSocket(): FakeSocket {
  const sent: string[] = [];
  let onMessage: ((message: string) => void) | undefined;
  const connection = {
    onMessage(handler: (message: string) => void): void {
      onMessage = handler;
    },
    onClose(): void {},
    sendText(text: string): void {
      sent.push(text);
    },
    close(): void {},
  } as unknown as TextWebSocketConnection;
  return {
    connection,
    sent,
    deliver(message: string): void {
      onMessage?.(message);
    },
    responses() {
      return sent
        .map((text) => JSON.parse(text) as { type: string; id?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } })
        .filter((frame) => frame.type === "response")
        .map((frame) => ({
          id: frame.id ?? "",
          ok: frame.ok ?? false,
          result: frame.result,
          error: frame.error,
        }));
    },
  };
}

function hello(socket: FakeSocket): void {
  socket.deliver(
    JSON.stringify({
      type: "hello",
      protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
      clientName: "web",
      clientVersion: "test",
      token: "test-token",
    }),
  );
}

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function createConnection(
  socket: FakeSocket,
  permissionDecide: Gateway["permissionDecide"],
): GatewayWsConnection {
  const gateway = {
    describeServer: () => ({
      mode: "in_process",
      sessionCount: 0,
      capabilities: {} as never,
    }),
    permissionDecide,
  } as unknown as Gateway;
  return new GatewayWsConnection(socket.connection, {
    gateway,
    token: "test-token",
    serverVersion: "test",
  });
}

/* ------------------------------------------------------------------ *
 * B3 — input validation
 * ------------------------------------------------------------------ */

test("B3/T5: a missing sessionKey is refused with a readable reason", () => {
  assert.throws(
    () => normalizeWebPermissionDecisionParams({ requestId: "r", decision: "allow" }),
    (error: unknown) =>
      error instanceof WebPermissionDecisionValidationError &&
      error.reason === WEB_PERMISSION_DECISION_REASONS.invalidSessionKey &&
      /sessionKey/.test(error.message),
  );
});

test("B3/T5: a missing requestId is refused with a readable reason", () => {
  assert.throws(
    () => normalizeWebPermissionDecisionParams({ sessionKey: "s", decision: "allow" }),
    (error: unknown) =>
      error instanceof WebPermissionDecisionValidationError &&
      error.reason === WEB_PERMISSION_DECISION_REASONS.invalidRequestId &&
      /requestId/.test(error.message),
  );
});

test("B3/T5: an unknown decision is refused with a readable reason", () => {
  assert.throws(
    () => normalizeWebPermissionDecisionParams({ sessionKey: "s", requestId: "r", decision: "maybe" }),
    (error: unknown) =>
      error instanceof WebPermissionDecisionValidationError &&
      error.reason === WEB_PERMISSION_DECISION_REASONS.invalidDecision &&
      /allow or deny/.test(error.message),
  );
});

test("B3/T5: a browser cannot claim an IM identity", () => {
  const result = normalizeWebPermissionDecisionParams({
    sessionKey: "s",
    requestId: "r",
    decision: "allow",
    origin: "im",
    channelKey: "feishu",
    chatId: "chat-1",
    actorSource: "channel_identity",
    actor: "alice",
  });
  assert.equal(result.origin, "web");
  assert.equal(result.actorSource, "client_reported");
  assert.equal((result as { channelKey?: string }).channelKey, undefined);
  assert.equal((result as { chatId?: string }).chatId, undefined);
});

/* ------------------------------------------------------------------ *
 * B2 — the refusal reason reaches the browser
 * ------------------------------------------------------------------ */

test("B2/T4: the websocket layer returns the refusal reason of the gateway", async () => {
  const socket = createSocket();
  const seen: unknown[] = [];
  createConnection(socket, async (input) => {
    seen.push(input);
    return { delivered: false, reason: "risk_not_im_decidable" };
  });
  hello(socket);
  socket.deliver(
    JSON.stringify({
      type: "request",
      id: "req-1",
      method: "permission_decide",
      params: { sessionKey: "s", requestId: "r", decision: "allow", actor: "alice" },
    }),
  );
  await delay(20);

  const responses = socket.responses();
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.ok, true);
  assert.deepEqual(responses[0]!.result, { delivered: false, reason: "risk_not_im_decidable" });
  // The forwarded decision keeps the web provenance.
  assert.deepEqual(seen[0], {
    sessionKey: "s",
    requestId: "r",
    decision: "allow",
    actor: "alice",
    actorSource: "client_reported",
    origin: "web",
  });
});

test("B2/T4: an invalid payload is answered with a reason code instead of an exception", async () => {
  const socket = createSocket();
  createConnection(socket, async () => {
    throw new Error("the gateway must not be reached");
  });
  hello(socket);
  socket.deliver(
    JSON.stringify({
      type: "request",
      id: "req-2",
      method: "permission_decide",
      params: { requestId: "r", decision: "allow" },
    }),
  );
  await delay(20);

  const responses = socket.responses();
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.ok, true);
  assert.deepEqual(responses[0]!.result, {
    delivered: false,
    reason: WEB_PERMISSION_DECISION_REASONS.invalidSessionKey,
  });
});
