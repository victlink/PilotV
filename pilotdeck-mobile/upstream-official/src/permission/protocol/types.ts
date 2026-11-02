export type PermissionMode = "default" | "plan" | "bypassPermissions";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export type PermissionRuleSource = "user" | "project" | "session" | "policy" | "cli";

export type PermissionRule = {
  source: PermissionRuleSource;
  behavior: PermissionRuleBehavior;
  toolName: string;
  pattern?: string;
};

export type PermissionRuleSet = {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
  /**
   * Exclusive allow list. When present and non-empty, only tools matching one
   * of these rules may run; every other tool is denied. Used by the project
   * agent tool authorization (`toolAccess: "allow-list"`).
   */
  /**
   * Exclusive allow list. Presence is significant: `[]` denies every tool;
   * `undefined` means unrestricted.
   */
  allowList?: PermissionRule[];
  /**
   * Absolute directories that confine filesystem writes. When present, a
   * filesystem write tool may only write inside one of these roots; writes
   * that resolve outside them are denied. This is a hard boundary: session
   * grants, user allow rules and bypass mode cannot escape it.
   */
  writeRoots?: string[];
};

export type PermissionContext = {
  mode: PermissionMode;
  rules: PermissionRuleSet;
  cwd: string;
  additionalWorkingDirectories: string[];
  canPrompt: boolean;
  bypassAvailable: boolean;
  /** Absolute path of the current writable plan directory. */
  planDirectoryPath?: string;
};

export type PermissionDecisionReason =
  | { type: "mode"; mode: PermissionMode; message: string }
  | { type: "rule"; behavior: PermissionRuleBehavior; rule: PermissionRule; message: string }
  | { type: "tool"; toolName: string; message: string }
  | { type: "safety"; message: string }
  | { type: "runtime"; message: string };

export type PermissionRequest = {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  reason: PermissionDecisionReason;
  options: PermissionRequestOption[];
  metadata?: Record<string, unknown>;
};

export type PermissionRequestOption =
  | { id: "allow_once"; label: string }
  | { id: "allow_session"; label: string; rules?: PermissionRule[] }
  | { id: "deny"; label: string }
  | { id: "cancel"; label: string };

export type PermissionDecision =
  | {
      type: "allow";
      reason: PermissionDecisionReason;
      updatedInput?: unknown;
    }
  | {
      type: "deny";
      reason: PermissionDecisionReason;
      message: string;
    }
  | {
      type: "ask";
      reason: PermissionDecisionReason;
      request: PermissionRequest;
    }
  | {
      type: "cancel";
      reason: PermissionDecisionReason;
      message: string;
    };

export type PermissionResult = PermissionDecision | { type: "passthrough"; reason?: PermissionDecisionReason };

export function emptyPermissionRuleSet(): PermissionRuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
  };
}

export function createDefaultPermissionContext(options: {
  cwd: string;
  mode?: PermissionMode;
  canPrompt?: boolean;
  bypassAvailable?: boolean;
  additionalWorkingDirectories?: string[];
  planDirectoryPath?: string;
  rules?: Partial<PermissionRuleSet>;
}): PermissionContext {
  return {
    mode: options.mode ?? "default",
    canPrompt: options.canPrompt ?? false,
    bypassAvailable: options.bypassAvailable ?? false,
    cwd: options.cwd,
    additionalWorkingDirectories: options.additionalWorkingDirectories ?? [],
    ...(options.planDirectoryPath ? { planDirectoryPath: options.planDirectoryPath } : {}),
    rules: {
      ...emptyPermissionRuleSet(),
      ...options.rules,
    },
  };
}
