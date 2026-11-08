import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "../model/ModelRuntime.js";
import type { GatewayEvent } from "../gateway/protocol/types.js";
import type { InProcessGateway } from "../gateway/client/InProcessGateway.js";
import { createLocalGateway } from "./createLocalGateway.js";

/**
 * B1 — the approval center is assembled *under* the gateway, not in the
 * process that happens to talk to it. These tests drive a real
 * `createLocalGateway()` instance: a permission request raised during a
 * turn must show up in the center and in the audit trail, and the pending
 * approvals of a session must converge when the turn ends.
 */

const SESSION_KEY = "web:s_approval_b1";
const REQUEST_ID = "req-approval-b1";

const CONFIG_YAML = [
  "schemaVersion: 1",
  "model:",
  "  providers:",
  "    test:",
  "      protocol: openai",
  "      url: http://127.0.0.1:9/v1",
  "      apiKey: sk-test",
  "      models:",
  "        test-model: {}",
  "agent:",
  "  model: test/test-model",
  "",
].join("\n");

type AuditEntry = {
  at: number;
  approvalId: string;
  action: string;
  actor?: string;
  actorSource?: string;
  channelKey?: string;
  detail?: string;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

/**
 * A model that parks until the test releases it. The turn therefore stays
 * open long enough to raise a permission request, and ends deterministically
 * when the gate opens.
 */
function createFakeModel(): { model: ModelRuntime; release: () => void } {
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const model = {
    async *stream(): AsyncGenerator<never> {
      yield { type: "request_started", provider: "test", model: "test-model" } as never;
      yield { type: "message_start", role: "assistant" } as never;
      await gate;
      yield { type: "text_delta", text: "done" } as never;
      yield { type: "message_end", finishReason: "stop" } as never;
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } as never;
    },
    async complete(): Promise<never> {
      throw new Error("complete() is not used by this test");
    },
    getCapabilities: () => ({ text: true, tools: true, vision: false, reasoning: false }),
    getMultimodal: () => ({ inputModalities: ["text"], outputModalities: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:9/v1",
  } as unknown as ModelRuntime;
  return { model, release: () => open?.() };
}

type Harness = {
  gateway: InProcessGateway;
  center: import("../approval/ApprovalCenter.js").ApprovalCenter;
  projectRoot: string;
  release: () => void;
  audit(): Promise<AuditEntry[]>;
  dispose(): Promise<void>;
};

async function createHarness(): Promise<Harness> {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-approval-b1-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-approval-b1-project-"));
  await writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG_YAML);
  await mkdir(join(pilotHome, "projects", "approval-b1"), { recursive: true });
  await writeFile(join(pilotHome, "projects", "approval-b1", ".cwd"), projectRoot);

  const { model, release } = createFakeModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    env: { PILOTDECK_HOME: pilotHome },
    __testModelFactory: () => model,
  });
  await local.approvalReady;
  const runtime = local.approvalRuntime;
  assert.ok(runtime, "the approval runtime must be attached to the local gateway");

  return {
    gateway: local.gateway as unknown as InProcessGateway,
    center: runtime.center,
    projectRoot,
    release,
    audit: async () => {
      const raw = await readFile(runtime.center.auditFilePath, "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditEntry);
    },
    dispose: async () => {
      release();
      local.dispose();
      await delay(20);
      await rm(pilotHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** Start a turn and keep it open. */
function startTurn(harness: Harness): { events: GatewayEvent[]; done: Promise<void> } {
  const events: GatewayEvent[] = [];
  const turn = harness.gateway.submitTurn({
    sessionKey: SESSION_KEY,
    channelKey: "web",
    message: "hello",
    projectKey: harness.projectRoot,
  });
  const done = (async () => {
    try {
      for await (const event of turn) events.push(event);
    } catch {
      // A failing turn is fine: the convergence assertion is about the
      // approval center, not about the agent loop.
    }
  })();
  return { events, done };
}

test("B1/T1: a permission request of a local gateway reaches the approval center and is audited", async () => {
  const harness = await createHarness();
  try {
    const { done } = startTurn(harness);

    const event: GatewayEvent = {
      type: "permission_request",
      requestId: REQUEST_ID,
      toolName: "bash",
      payload: { command: "ls" },
    };
    // The event sink only exists while the turn is in flight.
    await waitFor(
      () => (harness.gateway.emitForSession(SESSION_KEY, event) ? true : undefined),
      "the turn to install its event sink",
    );

    const record = await waitFor(
      () => harness.center.findByRequestId(REQUEST_ID, SESSION_KEY),
      "the approval center to register the request",
    );
    assert.equal(record.state, "pending");
    assert.equal(record.sessionKey, SESSION_KEY);
    assert.equal(record.toolName, "bash");

    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.some((entry) => entry.action === "registered") ? entries : undefined;
      },
      "the registered audit entry",
    );
    const registered = audit.find((entry) => entry.action === "registered")!;
    assert.equal(registered.approvalId, record.id);

    // A Web decision is answered through the bus and resolves the record.
    harness.gateway.getPermissionBus().register(SESSION_KEY, {
      requestId: REQUEST_ID,
      toolCallId: `call-${REQUEST_ID}`,
      toolName: "bash",
      resolve: () => undefined,
      reject: () => undefined,
    });
    const decision = await harness.gateway.permissionDecide({
      sessionKey: SESSION_KEY,
      requestId: REQUEST_ID,
      decision: "allow",
      actor: "alice",
      origin: "web",
      actorSource: "client_reported",
    });
    assert.equal(decision.delivered, true);

    const decided = await waitFor(
      () => {
        const current = harness.center.findByRequestId(REQUEST_ID, SESSION_KEY);
        return current && current.state === "approved" ? current : undefined;
      },
      "the record to become approved",
    );
    assert.equal(decided.decision?.actor, "alice");
    assert.equal(decided.decision?.actorSource, "client_reported");
    assert.equal(decided.decision?.source, "web");

    harness.release();
    await done;
  } finally {
    await harness.dispose();
  }
});

test("B1/T3: the end of a turn cancels the pending approvals of that session", async () => {
  const harness = await createHarness();
  try {
    const { done } = startTurn(harness);

    const event: GatewayEvent = {
      type: "permission_request",
      requestId: REQUEST_ID,
      toolName: "bash",
      payload: { command: "ls" },
    };
    await waitFor(
      () => (harness.gateway.emitForSession(SESSION_KEY, event) ? true : undefined),
      "the turn to install its event sink",
    );
    await waitFor(
      () => harness.center.findByRequestId(REQUEST_ID, SESSION_KEY),
      "the approval center to register the request",
    );

    // The turn ends: the pending approval must not stay pending forever.
    harness.release();
    await done;

    const cancelled = await waitFor(
      () => {
        const current = harness.center.findByRequestId(REQUEST_ID, SESSION_KEY);
        return current && current.state === "cancelled" ? current : undefined;
      },
      "the pending approval to be cancelled with the turn",
    );
    assert.equal(cancelled.reason, "turn_ended");

    const audit = await waitFor(
      async () => {
        const entries = await harness.audit();
        return entries.some((entry) => entry.action === "cancelled") ? entries : undefined;
      },
      "the cancelled audit entry",
    );
    const cancelledEntry = audit.find((entry) => entry.action === "cancelled")!;
    assert.equal(cancelledEntry.detail, "turn_ended");
  } finally {
    await harness.dispose();
  }
});
