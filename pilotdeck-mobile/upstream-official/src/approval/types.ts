/**
 * Unified approval contract shared by the Web UI and the chat channels.
 *
 * Every decision that must be confirmed (tool permission, agent elicitation)
 * is represented by one record. The record carries the request identity, the
 * risk level, the expiry, the decision and the audit trail, so the same
 * request can be answered from any channel without losing state.
 */

export type ApprovalDecisionSource = "web" | "im" | "system" | "api";

/**
 * Where the identity in the audit trail came from.
 *
 * `channel_identity` — the adapter verified the sender (Feishu open_id,
 * WeCom userid); it is the channel account, not a person.
 * `client_reported` — the value was asserted by the client and was not
 * authenticated by the server (the WebSocket entry point only compares a
 * token, it has no user identity).
 */
export type ApprovalActorSource = "channel_identity" | "client_reported";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";

export type ApprovalKind = "permission" | "elicitation";

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type ApprovalAuditAction =
  | "registered"
  | "routed"
  | "delivered"
  | "delivery_failed"
  | "decided"
  | "decision_rejected"
  | "decision_blocked"
  | "expired"
  | "cancelled"
  | "high_risk_blocked"
  | "state_reset";

export type ApprovalAuditEntry = {
  at: number;
  approvalId: string;
  action: ApprovalAuditAction;
  actor?: string;
  /** Provenance of `actor` — see {@link ApprovalActorSource}. */
  actorSource?: ApprovalActorSource;
  channelKey?: string;
  detail?: string;
};

/** A chat channel (and chat) that is allowed to answer a request. */
export type ApprovalBinding = {
  channelKey: string;
  /**
   * Chat the binding is restricted to. Optional (contract §5): when it is
   * missing the binding accepts an answer from any chat of the channel.
   */
  chatId?: string;
  interactionKey?: string;
  chatType?: "dm" | "group";
  /** Restrict the decision to these approver ids. */
  approverIds?: string[];
};

export type ApprovalDeliveryAttempt = {
  channelKey: string;
  chatId: string;
  ok: boolean;
  error?: string;
  at: number;
};

export type ApprovalDecision = {
  decision: "allow" | "deny";
  actor: string;
  source: ApprovalDecisionSource;
  channelKey?: string;
  /** Chat the answer came from (IM channels only). */
  chatId?: string;
  /** Provenance of `actor` — see {@link ApprovalActorSource}. */
  actorSource?: ApprovalActorSource;
  at: number;
  remember?: boolean;
  reason?: string;
};

export type ApprovalRecord = {
  /** Stable id of the approval record. */
  id: string;
  kind: ApprovalKind;
  /** Session the blocked turn belongs to. */
  sessionKey: string;
  /** Id of the pending request inside the gateway permission bus. */
  requestId: string;
  toolName: string;
  projectKey?: string;
  /** Channel that owns the turn (`web` for the Web UI). */
  originChannelKey: string;
  risk: ApprovalRisk;
  state: ApprovalState;
  summary: string;
  /** Redacted, human readable preview of the request payload. */
  payloadPreview: string;
  payloadRedacted: boolean;
  createdAt: number;
  expiresAt: number;
  idempotencyKey?: string;
  /** Channels that may answer this request. */
  bindings: ApprovalBinding[];
  deliveries: ApprovalDeliveryAttempt[];
  decision?: ApprovalDecision;
  reason?: string;
};
