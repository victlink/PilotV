/**
 * Unified approval center (统一授权中心) — state machine + persistence.
 *
 * Responsibilities:
 *  - Register every pending decision exactly once (idempotent per
 *    session + requestId, and per explicit idempotency key).
 *  - Keep the record durable across restarts: a pending record that survives
 *    a restart is cancelled, because the turn that asked for it is gone.
 *  - Apply authorization rules before a decision is accepted
 *    (see {@link ApprovalCenter.checkImBinding}).
 *  - Expire pending records on a TTL and audit every transition.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ApprovalActorSource,
  ApprovalAuditAction,
  ApprovalAuditEntry,
  ApprovalBinding,
  ApprovalDecisionSource,
  ApprovalKind,
  ApprovalRecord,
  ApprovalRisk,
} from "./types.js";

const STATE_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 200;

export type ApprovalCenterOptions = {
  /** Directory that holds the persisted state and the audit trail. */
  storeDir: string;
  now?: () => number;
  uuid?: () => string;
  defaultTtlMs?: number;
  maxRecords?: number;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

export type ApprovalRegisterInput = {
  kind: ApprovalKind;
  sessionKey: string;
  requestId: string;
  toolName: string;
  projectKey?: string;
  originChannelKey: string;
  risk: ApprovalRisk;
  summary: string;
  payloadPreview: string;
  payloadRedacted?: boolean;
  bindings?: ApprovalBinding[];
  ttlMs?: number;
  idempotencyKey?: string;
};

export type ApprovalResolveInput = {
  approvalId?: string;
  requestId?: string;
  sessionKey?: string;
  decision: "allow" | "deny";
  actor: string;
  source: ApprovalDecisionSource;
  channelKey?: string;
  /** Chat the answer came from (IM channels only). */
  chatId?: string;
  /** Provenance of `actor` — see {@link ApprovalActorSource}. */
  actorSource?: ApprovalActorSource;
  remember?: boolean;
  reason?: string;
};

export type ApprovalResolveResult = {
  applied: boolean;
  reason?: string;
  record?: ApprovalRecord;
};

export class ApprovalCenter {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly defaultTtlMs: number;
  private readonly maxRecords: number;
  private readonly logger: NonNullable<ApprovalCenterOptions["logger"]>;
  private readonly statePath: string;
  private readonly auditPath: string;
  private readonly records = new Map<string, ApprovalRecord>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: ApprovalCenterOptions) {
    this.now = options.now ?? (() => Date.now());
    this.uuid = options.uuid ?? randomUUID;
    this.defaultTtlMs = Math.max(1_000, options.defaultTtlMs ?? DEFAULT_TTL_MS);
    this.maxRecords = Math.max(10, options.maxRecords ?? DEFAULT_MAX_RECORDS);
    this.logger = options.logger ?? {};
    this.statePath = join(options.storeDir, "approvals.json");
    this.auditPath = join(options.storeDir, "approvals.audit.jsonl");
  }

  get storeDir(): string {
    return dirname(this.statePath);
  }

  get auditFilePath(): string {
    return this.auditPath;
  }

  /** Load persisted state. Pending records cannot survive a restart. */
  async init(): Promise<void> {
    // The store holds approval decisions and audit entries: the directory is
    // created for the owner only (0700). An already existing directory is
    // left untouched — a running instance must not have its permissions
    // rewritten underneath it.
    await mkdir(this.storeDir, { recursive: true, mode: 0o700 });
    await this.loadState();
  }

  get(id: string): ApprovalRecord | undefined {
    return this.records.get(id);
  }

  findByRequestId(requestId: string, sessionKey?: string): ApprovalRecord | undefined {
    for (const record of this.records.values()) {
      if (record.requestId !== requestId) continue;
      if (sessionKey && record.sessionKey !== sessionKey) continue;
      return record;
    }
    return undefined;
  }

  findByIdempotencyKey(key: string): ApprovalRecord | undefined {
    for (const record of this.records.values()) {
      if (record.idempotencyKey === key) return record;
    }
    return undefined;
  }

  listPending(): ApprovalRecord[] {
    return [...this.records.values()].filter((record) => record.state === "pending");
  }

  listRecent(limit = 50): ApprovalRecord[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit));
  }

  /**
   * Register a pending decision. Registering the same request twice returns
   * the existing record so a replayed event cannot spam the chat channel.
   */
  async register(input: ApprovalRegisterInput): Promise<ApprovalRecord> {
    const existing = this.findByRequestId(input.requestId, input.sessionKey);
    if (existing) return existing;
    if (input.idempotencyKey) {
      const byKey = this.findByIdempotencyKey(input.idempotencyKey);
      if (byKey) return byKey;
    }
    const now = this.now();
    const ttl = Math.max(1_000, input.ttlMs ?? this.defaultTtlMs);
    const record: ApprovalRecord = {
      id: this.uuid(),
      kind: input.kind,
      sessionKey: input.sessionKey,
      requestId: input.requestId,
      toolName: input.toolName,
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      originChannelKey: input.originChannelKey,
      risk: input.risk,
      state: "pending",
      summary: input.summary,
      payloadPreview: input.payloadPreview,
      payloadRedacted: input.payloadRedacted ?? false,
      createdAt: now,
      expiresAt: now + ttl,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      bindings: input.bindings ?? [],
      deliveries: [],
    };
    this.records.set(record.id, record);
    await this.auditEvent({
      approvalId: record.id,
      action: "registered",
      detail: `${record.kind}:${record.toolName}:${record.risk}`,
    });
    await this.persist();
    return record;
  }

  /**
   * True when the decision comes from the channel that raised the request.
   *
   * Such a decision is answered in the channel's own native prompt (the
   * numbered 1/2/0 menu). That prompt is the native authorization interface
   * the contract keeps high risk requests in, so it is not a mirrored
   * decision and must not be judged by the IM binding rules.
   */
  isNativeChannelDecision(record: ApprovalRecord, channelKey?: string): boolean {
    if (!channelKey) return false;
    return record.originChannelKey === channelKey;
  }

  /**
   * Authorization rules for a decision that arrives from a chat channel.
   * Returns a rejection reason, or undefined when the decision is allowed.
   *
   * Contract §4: an IM answer must hit a binding (channel + chat + optional
   * approver whitelist). `chatId` is only compared when the binding declares
   * one — a binding without a chat accepts an answer from any chat of that
   * channel (contract §5 makes the chat optional in the binding config).
   */
  checkImBinding(
    record: ApprovalRecord,
    input: { channelKey?: string; chatId?: string; actor?: string },
  ): string | undefined {
    const channelKey = input.channelKey;
    if (!channelKey) return "im_decision_without_channel";
    const binding = record.bindings.find((entry) => entry.channelKey === channelKey);
    if (!binding) return "channel_not_bound";
    if (binding.chatId) {
      const chatId = input.chatId?.trim();
      if (!chatId) return "im_decision_without_chat";
      if (chatId !== binding.chatId) return "chat_not_bound";
    }
    const approverIds = binding.approverIds;
    if (approverIds && approverIds.length > 0) {
      const actor = input.actor?.trim();
      if (!actor || !approverIds.includes(actor)) return "approver_not_allowed";
    }
    return undefined;
  }

  /** Apply a decision. Only the first decision for a record wins. */
  async resolve(input: ApprovalResolveInput): Promise<ApprovalResolveResult> {
    const record = input.approvalId
      ? this.records.get(input.approvalId)
      : this.findByRequestId(input.requestId ?? "", input.sessionKey);
    if (!record) return { applied: false, reason: "unknown_approval" };
    if (record.state !== "pending") {
      return { applied: false, reason: `already_${record.state}`, record };
    }
    const now = this.now();
    if (record.expiresAt <= now) {
      record.state = "expired";
      record.reason = "expired";
      await this.auditEvent({
        approvalId: record.id,
        action: "decision_rejected",
        actor: input.actor,
        channelKey: input.channelKey,
        detail: "expired",
      });
      await this.persist();
      return { applied: false, reason: "expired", record };
    }
    const nativeDecision = this.isNativeChannelDecision(record, input.channelKey);
    if (input.decision === "allow" && input.source === "im" && !nativeDecision) {
      const rejection = this.checkImBinding(record, {
        channelKey: input.channelKey,
        chatId: input.chatId,
        actor: input.actor,
      });
      if (rejection) {
        await this.auditEvent({
          approvalId: record.id,
          action: "decision_rejected",
          actor: input.actor,
          actorSource: input.actorSource,
          channelKey: input.channelKey,
          detail: rejection,
        });
        await this.persist();
        return { applied: false, reason: rejection, record };
      }
    }
    record.state = input.decision === "allow" ? "approved" : "denied";
    record.decision = {
      decision: input.decision,
      actor: input.actor,
      source: input.source,
      channelKey: input.channelKey,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.actorSource ? { actorSource: input.actorSource } : {}),
      at: now,
      remember: input.remember,
      reason: input.reason,
    };
    if (input.reason) record.reason = input.reason;
    await this.auditEvent({
      approvalId: record.id,
      action: "decided",
      actor: input.actor,
      actorSource: input.actorSource,
      channelKey: input.channelKey,
      detail: `${input.decision}:${input.source}:tool=${record.toolName}`,
    });
    await this.persist();
    return { applied: true, record };
  }

  /** Mark every pending record of a session as cancelled (turn ended). */
  async cancelSession(sessionKey: string, reason = "session_closed"): Promise<ApprovalRecord[]> {
    const cancelled: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.sessionKey !== sessionKey) continue;
      if (record.state !== "pending") continue;
      record.state = "cancelled";
      record.reason = reason;
      cancelled.push(record);
      await this.auditEvent({
        approvalId: record.id,
        action: "cancelled",
        actor: "system",
        detail: reason,
      });
    }
    if (cancelled.length > 0) await this.persist();
    return cancelled;
  }

  /** Expire pending records whose TTL elapsed. */
  async expireDue(now = this.now()): Promise<ApprovalRecord[]> {
    const expired: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state !== "pending") continue;
      if (record.expiresAt > now) continue;
      record.state = "expired";
      record.reason = "expired";
      expired.push(record);
      await this.auditEvent({ approvalId: record.id, action: "expired", detail: "ttl elapsed" });
    }
    if (expired.length > 0) await this.persist();
    return expired;
  }

  /** Record a delivery attempt to a chat channel. */
  async recordDelivery(
    approvalId: string,
    delivery: { channelKey: string; chatId: string; ok: boolean; error?: string },
  ): Promise<void> {
    const record = this.records.get(approvalId);
    if (!record) return;
    record.deliveries.push({ ...delivery, at: this.now() });
    await this.auditEvent({
      approvalId,
      action: delivery.ok ? "delivered" : "delivery_failed",
      channelKey: delivery.channelKey,
      detail: delivery.error,
    });
    await this.persist();
  }

  /** Append an audit entry (used by the router and the gateway bridge). */
  async auditEvent(entry: {
    approvalId: string;
    action: ApprovalAuditAction;
    actor?: string;
    actorSource?: ApprovalActorSource;
    channelKey?: string;
    detail?: string;
  }): Promise<void> {
    const full: ApprovalAuditEntry = {
      at: this.now(),
      approvalId: entry.approvalId,
      action: entry.action,
      ...(entry.actor ? { actor: entry.actor } : {}),
      ...(entry.actorSource ? { actorSource: entry.actorSource } : {}),
      ...(entry.channelKey ? { channelKey: entry.channelKey } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    };
    try {
      await mkdir(this.storeDir, { recursive: true, mode: 0o700 });
      // `mode` only applies when the file is created; an existing audit file
      // keeps the permissions it already has.
      await appendFile(this.auditPath, `${JSON.stringify(full)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      this.logger.warn?.(
        `[approval] failed to append audit entry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async loadState(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const backup = `${this.statePath}.corrupt-${this.now()}`;
      await rename(this.statePath, backup).catch(() => undefined);
      this.logger.warn?.(`[approval] state file unreadable, moved to ${backup}`);
      await this.auditEvent({
        approvalId: "-",
        action: "state_reset",
        detail: `corrupt state moved to ${backup}`,
      });
      return;
    }
    const records = readRecordArray(parsed);
    for (const record of records.records) this.records.set(record.id, record);
    if (records.dropped > 0) {
      // A malformed record is never dropped silently — it is reported in the
      // audit trail so the gap is visible.
      this.logger.warn?.(`[approval] dropped ${records.dropped} malformed state record(s)`);
      await this.auditEvent({
        approvalId: "-",
        action: "state_reset",
        detail: `dropped ${records.dropped} malformed record(s)`,
      });
    }
    let invalidated = 0;
    for (const record of this.records.values()) {
      if (record.state !== "pending") continue;
      record.state = "cancelled";
      record.reason = "process_restart";
      invalidated += 1;
      await this.auditEvent({
        approvalId: record.id,
        action: "cancelled",
        detail: "process_restart",
      });
    }
    // The in-memory state and the file must agree: a record that survived a
    // restart is cancelled, and that cancellation has to reach the disk.
    if (invalidated > 0 || records.dropped > 0) await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = {
      version: STATE_VERSION,
      updatedAt: this.now(),
      records: [...this.records.values()].slice(-this.maxRecords),
    };
    this.persistChain = this.persistChain
      .then(async () => {
        // A per-process temp name: two PilotV processes must never write
        // to the same temporary file and clobber each other's snapshot.
        const tmp = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
        // The state file is created for the owner only (0600); the rename
        // keeps that mode, so the snapshot never becomes world readable.
        await writeFile(tmp, JSON.stringify(snapshot, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(tmp, this.statePath);
      })
      .catch((error: unknown) => {
        this.logger.error?.(
          `[approval] failed to persist state: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return this.persistChain;
  }
}

function readRecordArray(parsed: unknown): { records: ApprovalRecord[]; dropped: number } {
  if (!parsed || typeof parsed !== "object") return { records: [], dropped: 0 };
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return { records: [], dropped: 0 };
  const kept = records.filter((entry): entry is ApprovalRecord => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<ApprovalRecord>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.requestId === "string" &&
      typeof candidate.sessionKey === "string" &&
      typeof candidate.state === "string"
    );
  });
  return { records: kept, dropped: records.length - kept.length };
}
