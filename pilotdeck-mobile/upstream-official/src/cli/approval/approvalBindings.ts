import { readFileSync } from "node:fs";

import type { ApprovalBindingConfig } from "../../approval/ApprovalRouter.js";

export type ApprovalBindingsLogger = {
  warn?(message: string): void;
};

export type LoadApprovalBindingConfigsOptions = {
  logger?: ApprovalBindingsLogger;
};

type ApprovalBindingsDocument = {
  bindings?: unknown;
};

/**
 * Load IM approval bindings from a standalone JSON file.
 * Missing or malformed files are non-fatal: an empty binding set disables
 * mirroring until the configuration is corrected.
 */
export function loadApprovalBindingConfigs(
  filePath: string,
  options: LoadApprovalBindingConfigsOptions = {},
): ApprovalBindingConfig[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    options.logger?.warn?.(
      `[approval] cannot read bindings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    options.logger?.warn?.(
      `[approval] invalid JSON in bindings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as ApprovalBindingsDocument).bindings)) {
    options.logger?.warn?.(`[approval] bindings file ${filePath} must contain an array property "bindings"`);
    return [];
  }

  const configs: ApprovalBindingConfig[] = [];
  for (const [index, entry] of ((parsed as ApprovalBindingsDocument).bindings as unknown[]).entries()) {
    const config = parseBinding(entry);
    if (!config) {
      options.logger?.warn?.(
        `[approval] skipping invalid binding at ${filePath}:bindings[${index}] (channelKey and chatId are required strings)`,
      );
      continue;
    }
    configs.push(config);
  }
  return configs;
}

function parseBinding(value: unknown): ApprovalBindingConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const channelKey = nonEmptyString(entry.channelKey);
  const chatId = nonEmptyString(entry.chatId);
  if (!channelKey || !chatId) return undefined;

  const chatType = entry.chatType === "dm" || entry.chatType === "group" ? entry.chatType : undefined;
  return {
    channelKey,
    chatId,
    ...(nonEmptyString(entry.interactionKey) ? { interactionKey: nonEmptyString(entry.interactionKey) } : {}),
    ...(chatType ? { chatType } : {}),
    ...optionalStringArray(entry.approverIds, "approverIds"),
    ...optionalStringArray(entry.projectKeys, "projectKeys"),
    ...optionalStringArray(entry.toolNames, "toolNames"),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown, key: "approverIds" | "projectKeys" | "toolNames"):
  Partial<Pick<ApprovalBindingConfig, "approverIds" | "projectKeys" | "toolNames">> {
  if (!Array.isArray(value)) return {};
  const values = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  return values.length > 0 ? { [key]: values } : {};
}
