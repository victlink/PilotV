import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchPermissionRule } from "./matchPermissionRule.js";
import { permissionEntryToRule } from "../settings.js";
import type { PermissionContext } from "../protocol/types.js";

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(value);
  return value;
}

process.on("exit", () => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    mode: "default",
    rules: { allow: [], deny: [], ask: [] },
    cwd: process.cwd(),
    additionalWorkingDirectories: [],
    canPrompt: false,
    bypassAvailable: false,
    ...overrides,
  };
}

test("an MCP group entry matches the wire name of its own server", () => {
  const rule = permissionEntryToRule("mcp:github", "allow", "project");

  assert.equal(matchPermissionRule(rule, "mcp__github__create_issue"), true);
  assert.equal(matchPermissionRule(rule, "mcp__github__get_issue"), true);
});

test("an MCP group entry does not match a different MCP server", () => {
  const rule = permissionEntryToRule("mcp:github", "allow", "project");

  assert.equal(matchPermissionRule(rule, "mcp__gitlab__create_issue"), false);
  assert.equal(matchPermissionRule(rule, "mcp__github_extra__create_issue"), false);
});

test("an MCP group entry does not match a regular tool", () => {
  const rule = permissionEntryToRule("mcp:github", "allow", "project");

  assert.equal(matchPermissionRule(rule, "read_file"), false);
  assert.equal(matchPermissionRule(rule, "write_file"), false);
  assert.equal(matchPermissionRule(rule, "bash"), false);
});

test("an MCP group entry does not widen a sibling group entry", () => {
  const github = permissionEntryToRule("mcp:github", "allow", "project");
  const gitlab = permissionEntryToRule("mcp:gitlab", "allow", "project");

  assert.equal(matchPermissionRule(gitlab, "mcp__github__create_issue"), false);
  assert.equal(matchPermissionRule(gitlab, "mcp__gitlab__create_issue"), true);
  assert.equal(matchPermissionRule(github, "mcp__github__create_issue"), true);
});

test("a scoped MCP group entry only matches its own server", () => {
  const rule = permissionEntryToRule("mcp:github:*", "allow", "project");

  assert.equal(matchPermissionRule(rule, "mcp__github__create_issue"), true);
  assert.equal(matchPermissionRule(rule, "mcp__gitlab__create_issue"), false);
});

test("the MCP wildcard entry keeps covering every MCP tool", () => {
  const rule = permissionEntryToRule("mcp*", "deny", "project");

  assert.equal(matchPermissionRule(rule, "mcp__github__create_issue"), true);
  assert.equal(matchPermissionRule(rule, "mcp__gitlab__create_issue"), true);
});

test("a bash scoped pattern is not affected by the MCP group matching", () => {
  const rule = permissionEntryToRule("bash:git log:*", "allow", "project");

  assert.equal(matchPermissionRule(rule, "bash", { command: "git log --oneline" }), true);
  assert.equal(matchPermissionRule(rule, "bash", { command: "rm -rf /" }), false);
  assert.equal(matchPermissionRule(rule, "mcp__github__create_issue"), false);
});

test("a project allow grant follows the project write scope instead of the working directory", () => {
  const projectRoot = tempDir("pilotdeck-write-scope-");
  const cwd = join(projectRoot, "src");
  const rule = permissionEntryToRule("write_file", "allow", "project");
  const ctx = context({
    cwd,
    rules: { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
  });

  assert.equal(
    matchPermissionRule(rule, "write_file", { file_path: join(projectRoot, "notes.md") }, ctx),
    true,
  );
  assert.equal(
    matchPermissionRule(
      permissionEntryToRule("edit_file", "allow", "project"),
      "edit_file",
      { file_path: join(cwd, "notes.md") },
      ctx,
    ),
    true,
  );
});

test("a project allow grant does not reach outside the project write scope", () => {
  const projectRoot = tempDir("pilotdeck-write-scope-");
  const cwd = join(projectRoot, "src");
  const rule = permissionEntryToRule("write_file", "allow", "project");
  const ctx = context({
    cwd,
    rules: { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
  });

  assert.equal(
    matchPermissionRule(rule, "write_file", { file_path: join(projectRoot, "..", "escape.md") }, ctx),
    false,
  );
});

test("a project allow grant without a write scope keeps the working directory as the limit", () => {
  const projectRoot = tempDir("pilotdeck-write-scope-");
  const cwd = join(projectRoot, "src");
  const rule = permissionEntryToRule("write_file", "allow", "project");
  const ctx = context({ cwd });

  assert.equal(
    matchPermissionRule(rule, "write_file", { file_path: join(cwd, "notes.md") }, ctx),
    true,
  );
  assert.equal(
    matchPermissionRule(rule, "write_file", { file_path: join(projectRoot, "notes.md") }, ctx),
    false,
  );
});

test("a user allow grant keeps the working directory as the limit", () => {
  const projectRoot = tempDir("pilotdeck-write-scope-");
  const cwd = join(projectRoot, "src");
  const rule = permissionEntryToRule("write_file", "allow", "user");
  const ctx = context({
    cwd,
    rules: { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
  });

  assert.equal(
    matchPermissionRule(rule, "write_file", { file_path: join(cwd, "notes.md") }, ctx),
    true,
  );
  assert.equal(
    matchPermissionRule(rule, "write_file", { file_path: join(projectRoot, "notes.md") }, ctx),
    false,
  );
});

test("a project deny grant still covers writes outside the scope", () => {
  const projectRoot = tempDir("pilotdeck-write-scope-");
  const cwd = join(projectRoot, "src");
  const rule = permissionEntryToRule("write_file", "deny", "project");
  const ctx = context({
    cwd,
    rules: { allow: [], deny: [], ask: [], writeRoots: [projectRoot] },
  });

  assert.equal(
    matchPermissionRule(rule, "write_file", { file_path: join(projectRoot, "..", "escape.md") }, ctx),
    true,
  );
});
