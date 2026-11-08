/**
 * B4/T6 — the *audit trail* of a decision that was answered in the Web UI.
 *
 * `webDecisionAttribution.approval.test.ts` proves that the web bridge
 * forwards the client reported identity and that it never fabricates one.
 * This file closes the remaining gap: the identity must also survive the
 * whole chain into the audit file — and when the browser reported *no*
 * identity, the audit entry must stay empty instead of being filled with a
 * placeholder that looks like an answer.
 *
 * The chain under test is the shipped one:
 *
 *   ui/server/pilotdeck-bridge.js  →  InProcessGateway.permissionDecide
 *     → approval decision guard     → approval decision sink
 *       → ApprovalCenter.resolve    → audit file (JSON lines)
 *
 * The web bridge cannot be imported by the node test runner (it installs a
 * global proxy and talks to a real gateway), so its *real* function source is
 * extracted from the shipped file and executed inside a `vm` whose
 * `ensureGateway` / `sessionState` point at the real in-process gateway.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ApprovalCenter } from "../../approval/ApprovalCenter.js";
import { ApprovalRouter } from "../../approval/ApprovalRouter.js";
import { InProcessGateway } from "../client/InProcessGateway.js";
import type { SessionRouter } from "../SessionRouter.js";
import { createApprovalBridge } from "./createApprovalBridge.js";

const BRIDGE_FILE = findBridgeFile();

function findBridgeFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 8; level += 1) {
    const candidate = resolvePath(dir, "ui/server/pilotdeck-bridge.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("ui/server/pilotdeck-bridge.js not found");
}

function skipString(source: string, index: number): number {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function skipTrivia(source: string, index: number): number {
  const character = source[index];
  if (character === '"' || character === "'" || character === "`") {
    return skipString(source, index);
  }
  if (character === "/" && source[index + 1] === "/") {
    const end = source.indexOf("\n", index);
    return end === -1 ? source.length : end + 1;
  }
  if (character === "/" && source[index + 1] === "*") {
    const end = source.indexOf("*/", index + 2);
    return end === -1 ? source.length : end + 2;
  }
  return index;
}

function matchBrace(source: string, start: number): number {
  let depth = 0;
  let cursor = start;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"' || character === "'" || character === "`" || character === "/") {
      const next = skipTrivia(source, cursor);
      if (next > cursor) {
        cursor = next;
        continue;
      }
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  throw new Error("unbalanced braces");
}

function extractFunctionSource(source: string, name: string): string {
  const marker = `export async function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} not found in ${BRIDGE_FILE}`);
  const paramsStart = source.indexOf("(", start);
  assert.notEqual(paramsStart, -1, `signature of ${name} not found`);
  let cursor = paramsStart;
  let depth = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    const next = skipTrivia(source, cursor);
    if (next > cursor) {
      cursor = next;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        break;
      }
    }
    cursor += 1;
  }
  const bodyStart = source.indexOf("{", cursor);
  assert.notEqual(bodyStart, -1, `body of ${name} not found`);
  const bodyEnd = matchBrace(source, bodyStart);
  return source.slice(start, bodyEnd + 1);
}

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

type AuditEntry = {
  action: string;
  actor?: string;
  actorSource?: string;
  channelKey?: string;
  detail?: string;
};

async function readAudit(path: string): Promise<AuditEntry[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Load the *real* `decidePermissionViaGateway` of the shipped web bridge and
 * point it at the given gateway / session.
 */
async function loadBridgeDecider(gateway: {
  permissionDecide: (input: unknown) => Promise<{ delivered: boolean }>;
}, sessionKey: string): Promise<{
  decide: (
    requestId: string,
    decision: string,
    options?: { actor?: string; remember?: boolean; reason?: string },
  ) => Promise<boolean>;
}> {
  const source = await readFile(BRIDGE_FILE, "utf8");
  const functionSource = extractFunctionSource(source, "decidePermissionViaGateway");
  const context = vm.createContext({
    console: { warn: () => undefined },
    ensureGateway: async () => gateway,
    sessionState: new Map([[sessionKey, { sessionKey }]]),
  });
  new vm.Script(
    `${functionSource.replace(/^export /, "")};globalThis.__decide = decidePermissionViaGateway;`,
  ).runInContext(context);
  const decide = (context as unknown as {
    __decide: (
      requestId: string,
      decision: string,
      options?: { actor?: string; remember?: boolean; reason?: string },
    ) => Promise<boolean>;
  }).__decide;
  return { decide };
}

type Harness = {
  center: ApprovalCenter;
  gateway: InProcessGateway;
  audit: () => Promise<AuditEntry[]>;
  dispose: () => Promise<void>;
};

async function createHarness(): Promise<Harness> {
  const storeDir = await mkdtemp(resolvePath(tmpdir(), "pilotdeck-web-noactor-"));
  const center = new ApprovalCenter({ storeDir });
  await center.init();

  const stubRouter = {
    beginTurn: () => false,
    endTurn: () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(stubRouter, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => "web-noactor",
  });
  const router = new ApprovalRouter({
    center,
    gateway,
    resolveChannel: () => undefined,
    bindingConfigs: () => [],
  });
  const bridge = createApprovalBridge({ center, router, gateway });

  return {
    center,
    gateway,
    audit: () => readAudit(center.auditFilePath),
    dispose: async () => {
      bridge.stop();
      await rm(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

async function registerPending(
  harness: Harness,
  sessionKey: string,
  requestId: string,
): Promise<void> {
  await harness.center.register({
    kind: "permission",
    sessionKey,
    requestId,
    toolName: "read_file",
    originChannelKey: "web",
    risk: "low",
    summary: "synthetic approval request",
    payloadPreview: "(synthetic)",
    bindings: [],
  });
  harness.gateway.getPermissionBus().register(sessionKey, {
    requestId,
    toolCallId: `call-${requestId}`,
    toolName: "read_file",
    resolve: () => undefined,
    reject: () => undefined,
  });
}

test("B4/T6: the audit trail names the client reported identity of the web answer", async () => {
  const harness = await createHarness();
  const sessionKey = "sess-web-actor";
  try {
    await registerPending(harness, sessionKey, "req-web-actor");
    const { decide } = await loadBridgeDecider(
      harness.gateway as unknown as {
        permissionDecide: (input: unknown) => Promise<{ delivered: boolean }>;
      },
      sessionKey,
    );

    const delivered = await decide("req-web-actor", "allow", { actor: "  alice  " });
    assert.equal(delivered, true);

    const decided = await waitFor(
      async () => (await harness.audit()).find((entry) => entry.action === "decided"),
      "the decided audit entry",
    );
    assert.equal(decided.actor, "alice");
    assert.equal(decided.actorSource, "client_reported");
  } finally {
    await harness.dispose();
  }
});

test("B4/T6: an unauthenticated web answer leaves the answering identity empty in the audit trail", async () => {
  const harness = await createHarness();
  const sessionKey = "sess-web-noactor";
  try {
    await registerPending(harness, sessionKey, "req-web-noactor");
    const { decide } = await loadBridgeDecider(
      harness.gateway as unknown as {
        permissionDecide: (input: unknown) => Promise<{ delivered: boolean }>;
      },
      sessionKey,
    );

    // No identity was reported by the browser — the decision must still be
    // applied, but the audit trail must not invent an answerer.
    const delivered = await decide("req-web-noactor", "allow", {});
    assert.equal(delivered, true);

    const decided = await waitFor(
      async () => (await harness.audit()).find((entry) => entry.action === "decided"),
      "the decided audit entry",
    );
    assert.equal(
      decided.actor ?? "",
      "",
      "a missing identity must stay empty in the audit trail",
    );
    assert.equal(decided.actorSource, "client_reported");
  } finally {
    await harness.dispose();
  }
});
