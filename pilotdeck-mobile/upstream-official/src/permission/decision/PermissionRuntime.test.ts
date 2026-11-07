import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionRuntime } from "./PermissionRuntime.js";
import { toolPolicyToRuleSet } from "../settings.js";
import type { PermissionContext } from "../protocol/types.js";
import type { PilotDeckToolDefinition } from "../../tool/protocol/types.js";

const context = (rules: PermissionContext["rules"]): PermissionContext => ({
  mode: "bypassPermissions",
  rules,
  cwd: process.cwd(),
  additionalWorkingDirectories: [],
  canPrompt: false,
  bypassAvailable: true,
});

const tool: PilotDeckToolDefinition = {
  name: "write_file",
  description: "test",
  kind: "filesystem",
  inputSchema: { type: "object", properties: {} },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async () => ({ content: [] }),
};

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(value);
  return value;
}

process.on("exit", () => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function decideWrite(
  filePath: string,
  rules: PermissionContext["rules"],
  cwd: string,
): Promise<{ type: string }> {
  return new PermissionRuntime().decide(
    tool,
    { file_path: filePath },
    {
      sessionId: "s",
      turnId: "t",
      cwd,
      permissionContext: context(rules),
    } as never,
    "call",
  ) as Promise<{ type: string }>;
}

test("session allow cannot override a deny rule", async () => {
  const decision = await new PermissionRuntime().decide(tool, {}, {
    sessionId: "s",
    turnId: "t",
    cwd: process.cwd(),
    permissionContext: context({
      allow: [{ source: "session", behavior: "allow", toolName: "write_file" }],
      deny: [{ source: "project", behavior: "deny", toolName: "write_file" }],
      ask: [],
    }),
  } as never, "call");
  assert.equal(decision.type, "deny");
});

test("an explicit empty allow list denies even in bypass mode", async () => {
  const decision = await new PermissionRuntime().decide(tool, {}, {
    sessionId: "s",
    turnId: "t",
    cwd: process.cwd(),
    permissionContext: context({ allow: [], deny: [], ask: [], allowList: [] }),
  } as never, "call");
  assert.equal(decision.type, "deny");
});

test("a write inside the project write roots stays allowed", async () => {
  const projectRoot = tempDir("pilotdeck-write-root-");
  const decision = await decideWrite(
    join(projectRoot, "notes.md"),
    { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
    projectRoot,
  );
  assert.equal(decision.type, "allow");
});

test("a write outside the project write roots is denied even in bypass mode", async () => {
  const projectRoot = tempDir("pilotdeck-write-root-");
  const decision = await decideWrite(
    join(projectRoot, "..", "escape.txt"),
    { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
    projectRoot,
  );
  assert.equal(decision.type, "deny");
});

test("a relative write that escapes the project write roots is denied", async () => {
  const projectRoot = tempDir("pilotdeck-write-root-");
  const decision = await decideWrite(
    join("..", "escape.txt"),
    { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
    projectRoot,
  );
  assert.equal(decision.type, "deny");
});

test("a symlink that escapes the project write roots is denied", async (t) => {
  const projectRoot = tempDir("pilotdeck-write-root-");
  const outside = tempDir("pilotdeck-write-outside-");
  try {
    symlinkSync(outside, join(projectRoot, "link"));
  } catch (error) {
    // Creating a symlink on Windows needs elevated privileges or Developer
    // Mode. Skip rather than delete the assertion: on any platform that can
    // create the link, the escape must still be denied.
    if ((error as NodeJS.ErrnoException)?.code === "EPERM") {
      t.skip("platform forbids unprivileged symlink creation");
      return;
    }
    throw error;
  }
  const decision = await decideWrite(
    join(projectRoot, "link", "secret.txt"),
    { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
    projectRoot,
  );
  assert.equal(decision.type, "deny");
});

test("a user allow rule cannot escape the project write roots", async () => {
  const projectRoot = tempDir("pilotdeck-write-root-");
  const decision = await decideWrite(
    join(projectRoot, "..", "escape.txt"),
    {
      allow: [{ source: "user", behavior: "allow", toolName: "write_file" }],
      deny: [],
      ask: [],
      writeRoots: [projectRoot],
    },
    projectRoot,
  );
  assert.equal(decision.type, "deny");
});

test("without write roots the previous behaviour is preserved", async () => {
  const projectRoot = tempDir("pilotdeck-write-root-");
  const decision = await decideWrite(
    join(projectRoot, "..", "escape.txt"),
    { allow: [], deny: [], ask: [] },
    projectRoot,
  );
  assert.equal(decision.type, "allow");
});

test("a project tool policy denies MCP tools, asks for shell tools and confines writes", async () => {
  const projectRoot = tempDir("pilotdeck-policy-");
  const rules = toolPolicyToRuleSet({
    deny: ["mcp*"],
    ask: ["bash", "execute_code"],
    writeRoots: [projectRoot],
  });
  const permissionContext: PermissionContext = {
    mode: "default",
    rules,
    cwd: projectRoot,
    additionalWorkingDirectories: [],
    canPrompt: true,
    bypassAvailable: false,
  };
  const runtime = new PermissionRuntime();
  const runtimeContext = {
    sessionId: "s",
    turnId: "t",
    cwd: projectRoot,
    permissionContext,
  } as never;

  const mcpTool: PilotDeckToolDefinition = {
    ...tool,
    name: "mcp__github__create_issue",
    isReadOnly: () => true,
  };
  const mcpDecision = await runtime.decide(mcpTool, { title: "issue" }, runtimeContext, "call");
  assert.equal(mcpDecision.type, "deny");

  const shellTool: PilotDeckToolDefinition = { ...tool, name: "bash" };
  const shellDecision = await runtime.decide(shellTool, { command: "curl https://example.com" }, runtimeContext, "call");
  assert.equal(shellDecision.type, "ask");

  const writeDecision = await runtime.decide(
    tool,
    { file_path: join(projectRoot, "..", "escape.txt") },
    runtimeContext,
    "call",
  );
  assert.equal(writeDecision.type, "deny");

  const scopedWriteDecision = await runtime.decide(
    tool,
    { file_path: join(projectRoot, "notes.md") },
    runtimeContext,
    "call",
  );
  assert.equal(scopedWriteDecision.type, "ask");
});

test("a project write scope denies the unscopable writers even in bypass mode", async () => {
  const projectRoot = tempDir("pilotdeck-policy-");
  const rules = toolPolicyToRuleSet({
    // The write scope is a boundary: the writers that cannot be path scoped
    // are denied instead of approved. An approval would be auto-approved by
    // `finalizeAsk` in bypass mode and the agent could write anywhere.
    deny: ["bash", "execute_code", "agent", "task_create", "mcp*"],
    // The network approval stays meaningful for the tools that cannot write.
    ask: ["web_fetch", "web_search"],
    writeRoots: [projectRoot],
  });
  const runtime = new PermissionRuntime();
  const permissionContext: PermissionContext = {
    mode: "bypassPermissions",
    rules,
    cwd: projectRoot,
    additionalWorkingDirectories: [],
    canPrompt: false,
    bypassAvailable: true,
  };
  const runtimeContext = {
    sessionId: "s",
    turnId: "t",
    cwd: projectRoot,
    permissionContext,
  } as never;

  for (const name of ["bash", "execute_code", "agent", "task_create"]) {
    const decision = await runtime.decide({ ...tool, name }, {}, runtimeContext, "call");
    assert.equal(decision.type, "deny", `${name} must stay denied in bypass mode`);
  }

  const mcpDecision = await runtime.decide(
    { ...tool, name: "mcp__github__create_issue" },
    { title: "issue" },
    runtimeContext,
    "call",
  );
  assert.equal(mcpDecision.type, "deny");

  // The direct writers stay available, but only inside the project root.
  const scopedWriteDecision = await runtime.decide(
    tool,
    { file_path: join(projectRoot, "notes.md") },
    runtimeContext,
    "call",
  );
  assert.equal(scopedWriteDecision.type, "allow");

  const escapingWriteDecision = await runtime.decide(
    tool,
    { file_path: join(projectRoot, "..", "escape.txt") },
    runtimeContext,
    "call",
  );
  assert.equal(escapingWriteDecision.type, "deny");

  // The network approval is still a real approval in a normal session.
  const defaultContext = {
    sessionId: "s",
    turnId: "t",
    cwd: projectRoot,
    permissionContext: {
      ...permissionContext,
      mode: "default",
      canPrompt: true,
      bypassAvailable: false,
    },
  } as never;
  const networkDecision = await runtime.decide(
    { ...tool, name: "web_fetch" },
    { url: "https://example.com" },
    defaultContext,
    "call",
  );
  assert.equal(networkDecision.type, "ask");

  // Why the scope has to deny instead of approve: an approval for the same
  // unscopable writer is auto-approved in bypass mode.
  const approvalContext = {
    sessionId: "s",
    turnId: "t",
    cwd: projectRoot,
    permissionContext: {
      ...permissionContext,
      rules: toolPolicyToRuleSet({ ask: ["bash"], writeRoots: [projectRoot] }),
    },
  } as never;
  const approvedShellDecision = await runtime.decide(
    { ...tool, name: "bash" },
    { command: "echo hi" },
    approvalContext,
    "call",
  );
  assert.equal(approvedShellDecision.type, "allow");
});

test("a project allow list admits the MCP tools of the listed server only", async () => {
  const projectRoot = tempDir("pilotdeck-allow-list-");
  const rules = toolPolicyToRuleSet({
    allow: ["mcp:github", "read_file"],
    writeRoots: [projectRoot],
  });
  const runtime = new PermissionRuntime();
  const runtimeContext = {
    sessionId: "s",
    turnId: "t",
    cwd: projectRoot,
    permissionContext: {
      mode: "default",
      rules,
      cwd: projectRoot,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: false,
    },
  } as never;

  const githubTool: PilotDeckToolDefinition = {
    ...tool,
    name: "mcp__github__create_issue",
    isReadOnly: () => true,
  };
  const githubDecision = await runtime.decide(githubTool, { title: "issue" }, runtimeContext, "call");
  assert.equal(githubDecision.type, "allow");

  const gitlabTool: PilotDeckToolDefinition = {
    ...tool,
    name: "mcp__gitlab__create_issue",
    isReadOnly: () => true,
  };
  const gitlabDecision = await runtime.decide(gitlabTool, { title: "issue" }, runtimeContext, "call");
  assert.equal(gitlabDecision.type, "deny");

  const unrelatedTool: PilotDeckToolDefinition = { ...tool, name: "write_file" };
  const unrelatedDecision = await runtime.decide(unrelatedTool, {}, runtimeContext, "call");
  assert.equal(unrelatedDecision.type, "deny");
});

test("a project allow list admits writes inside the project scope from a project subdirectory", async () => {
  const projectRoot = tempDir("pilotdeck-allow-list-");
  const cwd = join(projectRoot, "src");
  const rules = toolPolicyToRuleSet({
    allow: ["write_file"],
    writeRoots: [projectRoot],
  });
  const decision = await new PermissionRuntime().decide(
    tool,
    { file_path: join(projectRoot, "notes.md") },
    {
      sessionId: "s",
      turnId: "t",
      cwd,
      permissionContext: {
        mode: "bypassPermissions",
        rules,
        cwd,
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: true,
      },
    } as never,
    "call",
  );
  assert.equal(decision.type, "allow");
});

test("a project allow list denies writes outside the project scope from a project subdirectory", async () => {
  const projectRoot = tempDir("pilotdeck-allow-list-");
  const cwd = join(projectRoot, "src");
  const rules = toolPolicyToRuleSet({
    allow: ["write_file"],
    writeRoots: [projectRoot],
  });
  const decision = await new PermissionRuntime().decide(
    tool,
    { file_path: join(projectRoot, "..", "escape.md") },
    {
      sessionId: "s",
      turnId: "t",
      cwd,
      permissionContext: {
        mode: "bypassPermissions",
        rules,
        cwd,
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: true,
      },
    } as never,
    "call",
  );
  assert.equal(decision.type, "deny");
});
