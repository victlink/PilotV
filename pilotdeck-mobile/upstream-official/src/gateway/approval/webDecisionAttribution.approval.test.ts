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

/**
 * B4 — the identity of the person who answered in the Web UI must reach the
 * audit trail, and it must be labelled as *client reported* because the
 * browser identity was never verified against a channel (contract §6).
 *
 * The web bridge (`ui/server/pilotdeck-bridge.js`) cannot be imported by the
 * node test runner — the module installs a global proxy, imports TypeScript
 * sources and talks to a real gateway. The test therefore extracts the
 * *real* function source of the production file and runs it inside a `vm`
 * with stubbed `ensureGateway` / `sessionState`, so the assertions still
 * exercise the shipped implementation and not a copy of it.
 */

const BRIDGE_FILE = findBridgeFile();

/**
 * Locate `ui/server/pilotdeck-bridge.js` — the test runs from `dist/` as
 * well as from `src/`, so the lookup walks up until the file is found.
 */
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

/** Skip over a string literal (single, double or backtick quoted). */
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

/**
 * Skip a string literal or a comment. The production source contains
 * apostrophes inside comments (`we don't know`), which must not be mistaken
 * for the start of a string literal.
 */
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

/** Index of the `}` that closes the `{` at `start`. */
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

/**
 * Extract the source of a top level `export async function <name>` block.
 * The parameter list may contain braces (`options = {}`), so the body is
 * located behind the closing parenthesis of the signature.
 */
function extractFunctionSource(source: string, name: string): string {
  const marker = `export async function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} not found in ${BRIDGE_FILE}`);
  const paramsStart = source.indexOf("(", start);
  assert.notEqual(paramsStart, -1, `signature of ${name} not found`);
  // Skip the parameter list.
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

type DecidedInput = {
  sessionKey: string;
  requestId: string;
  decision: string;
  remember?: boolean;
  reason?: string;
  origin: string;
  actor?: string;
  actorSource: string;
};

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

async function loadBridgeDecider(): Promise<{
  decide: (
    requestId: string,
    decision: string,
    options?: { actor?: string; remember?: boolean; reason?: string },
  ) => Promise<boolean>;
  calls: DecidedInput[];
}> {
  const source = await readFile(BRIDGE_FILE, "utf8");
  const functionSource = extractFunctionSource(source, "decidePermissionViaGateway");
  const calls: DecidedInput[] = [];
  const context = vm.createContext({
    console: { warn: () => undefined },
    ensureGateway: async () => ({
      permissionDecide: async (input: DecidedInput) => {
        calls.push(input);
        return { delivered: true };
      },
    }),
    sessionState: new Map([["sess-1", { sessionKey: "sess-1" }]]),
  });
  new vm.Script(
    `${functionSource.replace(/^export /, "")};globalThis.__decide = decidePermissionViaGateway;`,
  ).runInContext(context);
  const decide = (context as unknown as { __decide: typeof context.__decide }).__decide;
  return { decide, calls };
}

test("B4/T6: the web bridge forwards the client reported identity with the client_reported provenance", async () => {
  const { decide, calls } = await loadBridgeDecider();

  const delivered = await decide("req-1", "allow", { actor: "  alice  " });

  assert.equal(delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.actor, "alice");
  assert.equal(calls[0]!.actorSource, "client_reported");
  assert.equal(calls[0]!.origin, "web");
});

test("B4/T6: the web bridge never fabricates an identity and never claims a channel verified one", async () => {
  const { decide, calls } = await loadBridgeDecider();

  const delivered = await decide("req-2", "deny", {});

  assert.equal(delivered, true);
  assert.equal(calls.length, 1);
  assert.equal("actor" in calls[0]!, false, "a missing identity must stay missing");
  assert.equal(calls[0]!.actorSource, "client_reported");
  assert.equal(calls[0]!.origin, "web");
  assert.notEqual(calls[0]!.actorSource, "channel_identity");
});

test("B4/T6: the audit trail attributes the decision to the client reported identity", async () => {
  const storeDir = await mkdtemp(resolvePath(tmpdir(), "pilotdeck-web-attribution-"));
  const center = new ApprovalCenter({ storeDir });
  await center.init();

  const stubRouter = {
    beginTurn: () => false,
    endTurn: () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(stubRouter, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => "web-attribution-1",
  });
  const router = new ApprovalRouter({
    center,
    gateway,
    resolveChannel: () => undefined,
    bindingConfigs: () => [],
  });
  const bridge = createApprovalBridge({ center, router, gateway });

  try {
    await center.register({
      kind: "permission",
      sessionKey: "sess-web",
      requestId: "req-web",
      toolName: "read_file",
      originChannelKey: "web",
      risk: "low",
      summary: "synthetic approval request",
      payloadPreview: "(synthetic)",
      bindings: [],
    });
    gateway.getPermissionBus().register("sess-web", {
      requestId: "req-web",
      toolCallId: "call-req-web",
      toolName: "read_file",
      resolve: () => undefined,
      reject: () => undefined,
    });

    const result = await gateway.permissionDecide({
      sessionKey: "sess-web",
      requestId: "req-web",
      decision: "allow",
      actor: "alice",
      origin: "web",
      actorSource: "client_reported",
    });

    assert.equal(result.delivered, true);

    const raw = await readFile(center.auditFilePath, "utf8").catch(() => "");
    const entries = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { action: string; actor?: string; actorSource?: string });
    // The decision sink resolves the record asynchronously.
    const decided = await waitFor(
      async () => {
        const current = await readFile(center.auditFilePath, "utf8").catch(() => "");
        return current
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as { action: string; actor?: string; actorSource?: string })
          .find((entry) => entry.action === "decided");
      },
      "the decided audit entry",
    );
    assert.ok(decided, `no "decided" audit entry in ${raw}`);
    assert.equal(decided!.actor, "alice");
    assert.equal(decided!.actorSource, "client_reported");
    assert.equal(entries.filter((entry) => entry.action === "registered").length, 1);
  } finally {
    bridge.stop();
    await rm(storeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
