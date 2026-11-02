import path from "node:path";
import { realpathSync } from "node:fs";
import { isPathWithinRoot, resolveRealWritePath } from "../../tool/builtin/filesystem/pathSafety.js";
import type { PermissionContext } from "../protocol/types.js";

/**
 * Filesystem write tools and the input fields that carry their target path.
 * Only these tools can be confined to a directory: every other writer runs
 * arbitrary code and is handled by the policy layer instead.
 */
const WRITE_PATH_FIELDS = new Map<string, string[]>([
  ["write_file", ["file_path", "filePath"]],
  ["edit_file", ["file_path", "filePath"]],
  ["edit_notebook", ["notebook_path", "notebookPath"]],
]);

type WriteRoot = {
  /** Absolute path as configured. */
  lexical: string;
  /** Absolute path with symlinks resolved, used for the containment check. */
  real: string;
};

/**
 * Check a tool call against the write scope of the active permission rules.
 *
 * Returns a message when the call must be denied, or `undefined` when the
 * call is inside the write scope (or the tool is not path scoped). The check
 * is intentionally fail closed: a write whose target path cannot be read or
 * resolved is treated as a violation.
 */
export function findWriteScopeViolation(
  toolName: string,
  input: unknown,
  context: PermissionContext,
): string | undefined {
  const roots = normalizeRoots(context.rules.writeRoots);
  if (roots.length === 0) return undefined;
  const fields = WRITE_PATH_FIELDS.get(toolName);
  if (!fields) return undefined;

  const raw = readPath(input, fields);
  if (!raw) {
    return `${toolName} cannot be authorized: the target path is missing.`;
  }
  if (raw.includes("\0")) {
    return `${toolName} cannot be authorized: the target path is invalid.`;
  }

  const absolute = path.resolve(path.isAbsolute(raw) ? raw : path.join(context.cwd, raw));
  // Writes follow symlinks, so the scope has to hold for the path the OS
  // writes to, not only for the literal path the caller supplied.
  const real = resolveRealWritePath(absolute);
  if (!real) {
    return `${toolName} cannot be authorized: the target path could not be resolved safely.`;
  }
  if (roots.some((root) => isPathWithinRoot(real, root.real) || isPathWithinRoot(real, root.lexical))) {
    return undefined;
  }
  return `${toolName} cannot write ${raw}: it resolves outside the allowed write scope (${roots
    .map((root) => root.lexical)
    .join(", ")}).`;
}

function normalizeRoots(value: unknown): WriteRoot[] {
  if (!Array.isArray(value)) return [];
  const roots: WriteRoot[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.includes("\0")) continue;
    const lexical = path.resolve(trimmed);
    if (seen.has(lexical)) continue;
    seen.add(lexical);
    roots.push({ lexical, real: safeRealpath(lexical) });
  }
  return roots;
}

function safeRealpath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function readPath(input: unknown, fields: string[]): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
