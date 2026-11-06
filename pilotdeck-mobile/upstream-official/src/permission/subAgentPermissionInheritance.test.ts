import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubAgentSession } from "../agent/sub/SubAgentSession.js";
import type { SubagentDefinition } from "../agent/sub/builtinSubagentTypes.js";
import type { AgentRuntimeConfig } from "../agent/runtime/AgentRuntimeConfig.js";
import type { PermissionContext } from "./protocol/types.js";

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(value);
  return value;
}

process.on("exit", () => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const definition: SubagentDefinition = {
  id: "general-purpose",
  description: "test subagent",
  allowedTools: ["*"],
  omitProjectInstructions: false,
  omitGitStatus: false,
  isReadOnly: false,
  systemPromptSuffix: "",
};

/**
 * Load the subagent session lazily.
 *
 * The session pulls in the optional model SDKs. When those are not installed
 * the inheritance cannot be observed, so the tests are skipped instead of
 * failing on an unrelated module resolution error.
 */
async function loadSubAgentSession(): Promise<typeof SubAgentSession | undefined> {
  try {
    const module = await import("../agent/sub/SubAgentSession.js");
    return module.SubAgentSession;
  } catch {
    return undefined;
  }
}

/** Build the config the child session runs with. */
function childConfig(
  SubAgentSessionCtor: typeof SubAgentSession,
  rules: PermissionContext["rules"],
  cwd: string,
): AgentRuntimeConfig {
  const parentConfig = {
    provider: "openai",
    model: "test-model",
    cwd,
    permissionMode: "default",
    runMode: "default",
    systemPrompt: "",
    permissionContext: {
      mode: "default",
      rules,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
    },
  } as unknown as AgentRuntimeConfig;

  const session = new SubAgentSessionCtor({
    definition,
    directive: "do the work",
    parentConfig,
    parentDependencies: {} as never,
    parentSessionId: "s",
    parentTurnId: "t",
    subagentSessionId: "sub",
    subagentId: "sub-1",
  });

  return (session as unknown as { buildConfig(): AgentRuntimeConfig }).buildConfig();
}

test("a child subagent inherits the project write scope", async (t) => {
  const SubAgentSessionCtor = await loadSubAgentSession();
  if (!SubAgentSessionCtor) {
    t.skip("SubAgentSession is not loadable (optional model SDK dependencies are missing)");
    return;
  }

  const projectRoot = tempDir("pilotdeck-subagent-");
  const config = childConfig(
    SubAgentSessionCtor,
    { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
    projectRoot,
  );

  assert.deepEqual(config.permissionContext.rules.writeRoots, [projectRoot]);
});

test("a child subagent inherits the project allow list", async (t) => {
  const SubAgentSessionCtor = await loadSubAgentSession();
  if (!SubAgentSessionCtor) {
    t.skip("SubAgentSession is not loadable (optional model SDK dependencies are missing)");
    return;
  }

  const projectRoot = tempDir("pilotdeck-subagent-");
  const allowList = [{ source: "project" as const, behavior: "allow" as const, toolName: "read_file" }];
  const config = childConfig(SubAgentSessionCtor, { allow: [], deny: [], ask: [], allowList }, projectRoot);

  assert.deepEqual(config.permissionContext.rules.allowList, allowList);
});

test("a child subagent keeps an absent write scope absent", async (t) => {
  const SubAgentSessionCtor = await loadSubAgentSession();
  if (!SubAgentSessionCtor) {
    t.skip("SubAgentSession is not loadable (optional model SDK dependencies are missing)");
    return;
  }

  const projectRoot = tempDir("pilotdeck-subagent-");
  const config = childConfig(SubAgentSessionCtor, { allow: [], deny: [], ask: [] }, projectRoot);

  assert.equal(config.permissionContext.rules.writeRoots, undefined);
});
