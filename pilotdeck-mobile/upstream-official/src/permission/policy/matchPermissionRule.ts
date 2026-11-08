import path from "node:path";
import { realpathSync } from "node:fs";
import { hasBashLineContinuation, splitBashCommands } from "../../tool/builtin/bash/parser.js";
import { resolveRealWritePath } from "../../tool/builtin/filesystem/pathSafety.js";
import { parseMcpToolWireName } from "../../mcp/runtime/wireName.js";
import type { PermissionContext, PermissionRule } from "../protocol/types.js";

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const FILE_PATH_PATTERN_TOOLS = new Set(["read_file", "send_attachment", "write_file", "edit_file"]);
/** Tool group that addresses the MCP servers (`mcp:github`). */
const MCP_TOOL_GROUP = "mcp";

export function matchPermissionRule(
  rule: PermissionRule,
  toolName: string,
  input?: unknown,
  context?: PermissionContext,
): boolean {
  if (!matchesToolName(rule, toolName)) {
    return false;
  }

  if (FILE_WRITE_TOOLS.has(toolName) && !rule.pattern) {
    // Project agent prohibitions/approval requirements cover the tool itself,
    // including writes outside the workspace and malformed paths. Only allow
    // grants remain constrained to workspace paths.
    if (rule.source === "project" && rule.behavior !== "allow") return true;
    return isFileInputInsideWorkspace(input, context, resolveWriteRoots(rule, context), rule.behavior === "allow");
  }

  return rule.pattern ? matchRulePattern(rule, toolName, input, context) : true;
}

function matchesToolName(rule: PermissionRule, toolName: string): boolean {
  if (rule.toolName === toolName) return true;
  // A tool group entry (`mcp:github`) addresses one MCP server. On the wire an
  // MCP tool is named `mcp__<server>__<tool>`, so the group has to be matched
  // against the server segment instead of the plain tool name.
  if (rule.toolName === MCP_TOOL_GROUP && rule.pattern) {
    return matchesMcpToolGroup(rule.pattern, toolName);
  }
  return rule.toolName.includes("*") && wildcardToRegExp(rule.toolName).test(toolName);
}

/**
 * Match a tool group scope (`github`, `github:*`, `git*`) against the server
 * segment of an MCP wire name (`mcp__github__create_issue`).
 *
 * The scope only ever addresses the server segment, so a group entry never
 * reaches another server and never reaches a regular tool.
 */
function matchesMcpToolGroup(scope: string, toolName: string): boolean {
  const wire = parseMcpToolWireName(toolName);
  if (!wire) return false;
  const server = normalizeMcpName(wire.serverId);
  const normalizedScope = normalizeMcpScope(scope);
  if (!normalizedScope) return false;
  if (normalizedScope.includes("*")) return wildcardToRegExp(normalizedScope).test(server);
  return server === normalizedScope;
}

/** `github:*` addresses the same server as `github`. */
function normalizeMcpScope(scope: string): string {
  return scope
    .trim()
    .replace(/:\*$/, "")
    .replace(/[^A-Za-z0-9_*]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** MCP names are normalized to `[A-Za-z0-9_]` on the wire. */
function normalizeMcpName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function matchRulePattern(
  rule: PermissionRule,
  toolName: string,
  input: unknown,
  context: PermissionContext | undefined,
): boolean {
  if (!rule.pattern) return true;
  if (toolName === "bash") return matchBashPattern(rule, input);
  if (FILE_PATH_PATTERN_TOOLS.has(toolName)) return matchFilePathPattern(rule.pattern, input, context);
  return true;
}

function matchBashPattern(rule: PermissionRule, input: unknown): boolean {
  const command = readCommand(input);
  if (!command || !rule.pattern) return false;
  const pattern = wildcardToRegExp(rule.pattern.replace(/:\*$/, "*"), "s");
  // Like opencode, evaluate each simple command on its own: an allow rule must
  // cover every command in the script, while a single matching command is
  // enough for an ask or deny rule. Unparseable scripts are never allowed.
  const parsed = splitBashCommands(command);
  if (rule.behavior === "allow") {
    return parsed !== undefined
      && !hasBashLineContinuation(command)
      && !parsed.hasError
      && parsed.commands.length > 0
      && parsed.commands.every((part) => pattern.test(part));
  }
  return pattern.test(command) || (parsed?.commands.some((part) => pattern.test(part)) ?? false);
}

function readCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" ? command.trim() : "";
  }
  return "";
}

function matchFilePathPattern(pattern: string, input: unknown, context: PermissionContext | undefined): boolean {
  const filePath = resolveInputFilePath(input, context);
  return filePath ? wildcardToRegExp(normalizePathForPattern(pattern)).test(normalizePathForPattern(filePath)) : false;
}

function isFileInputInsideWorkspace(
  input: unknown,
  context: PermissionContext | undefined,
  roots: string[],
  resolveSymlinks: boolean,
): boolean {
  const filePath = resolveInputFilePath(input, context);
  if (!filePath || !context) return false;
  if (roots.length === 0) return false;
  if (!roots.some((root) => isPathWithinRoot(filePath, root))) return false;
  if (!resolveSymlinks) return true;
  // A symlink inside the workspace can still point the write elsewhere.
  const realFilePath = resolveRealWritePath(filePath);
  if (!realFilePath) return false;
  return roots.map(safeRealpath).some((root) => isPathWithinRoot(realFilePath, root));
}

/**
 * The directories a file write grant may reach.
 *
 * A project allow grant follows the project write scope: the scope is the
 * boundary, not the working directory. A session that runs inside a project
 * subdirectory still has to be able to write inside the project, so the grant
 * uses the write roots instead of the narrower working directory. Without a
 * write scope the workspace (working directory plus the additional working
 * directories) stays the limit.
 */
function resolveWriteRoots(rule: PermissionRule, context: PermissionContext | undefined): string[] {
  if (rule.source === "project" && rule.behavior === "allow") {
    const writeRoots = context?.rules.writeRoots;
    if (Array.isArray(writeRoots) && writeRoots.length > 0) {
      return writeRoots.map((root) => path.resolve(root));
    }
  }
  if (!context) return [];
  return [context.cwd, ...context.additionalWorkingDirectories].map((root) => path.resolve(root));
}

function safeRealpath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function resolveInputFilePath(input: unknown, context: PermissionContext | undefined): string | undefined {
  const filePath = readFilePath(input);
  if (!filePath || filePath.includes("\0") || !context) return undefined;
  return path.resolve(path.isAbsolute(filePath) ? filePath : path.join(context.cwd, filePath));
}

function readFilePath(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as { file_path?: unknown; filePath?: unknown };
  const filePath = record.file_path ?? record.filePath;
  return typeof filePath === "string" ? filePath.trim() : "";
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePathForPattern(value: string): string {
  return value.replace(/\\/g, "/");
}

function wildcardToRegExp(pattern: string, flags?: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, flags);
}
