/**
 * Bridge between the gateway runtime and the unified approval center.
 *
 * It connects three things:
 *  1. The gateway event stream — every `permission_request` /
 *     `elicitation_request` of every turn is offered to the router, so a
 *     turn started in the Web UI can be answered from a chat channel.
 *  2. The decision guard — before a decision is applied the center checks
 *     that the request is still pending, not expired and (for IM) that the
 *     answering channel is bound to it.
 *  3. The TTL sweeper — an approval that nobody answers expires and is
 *     denied, so the original turn can never hang forever.
 */

import type { ApprovalCenter } from "../../approval/ApprovalCenter.js";
import type {
  ApprovalGateway,
  ApprovalRouter,
} from "../../approval/ApprovalRouter.js";
import { canDecideViaIm } from "../../approval/ApprovalPolicy.js";
import type { ApprovalActorSource, ApprovalDecisionSource } from "../../approval/types.js";

export type ApprovalEventInput = {
  sessionKey: string;
  channelKey: string;
  projectKey?: string;
  event: { type: string; [key: string]: unknown };
};

export type ApprovalDecisionInput = {
  sessionKey: string;
  requestId: string;
  decision: "allow" | "deny";
  actor?: string;
  origin?: ApprovalDecisionSource;
  channelKey?: string;
  /** Chat the answer came from (IM channels only). */
  chatId?: string;
  /** Provenance of `actor` — see {@link ApprovalActorSource}. */
  actorSource?: ApprovalActorSource;
  remember?: boolean;
  reason?: string;
  /** Which kind of request the decision belongs to. */
  kind?: "permission" | "elicitation";
  /** Set when the decision guard refused the decision. */
  blocked?: boolean;
  /** Why the guard refused the decision. */
  blockedReason?: string;
};

export type ApprovalEventSink = (input: ApprovalEventInput) => void;
export type ApprovalDecisionSink = (input: ApprovalDecisionInput) => void;
export type ApprovalDecisionGuard = (
  input: ApprovalDecisionInput,
) => Promise<{ allowed: boolean; reason?: string }>;

export type ApprovalBridgeGateway = ApprovalGateway & {
  addApprovalEventSink?(sink: ApprovalEventSink): void;
  addApprovalDecisionGuard?(guard: ApprovalDecisionGuard): void;
  addApprovalDecisionSink?(sink: ApprovalDecisionSink): void;
  removeApprovalEventSink?(sink: ApprovalEventSink): void;
  removeApprovalDecisionGuard?(guard: ApprovalDecisionGuard): void;
  removeApprovalDecisionSink?(sink: ApprovalDecisionSink): void;
};

export type ApprovalBridgeOptions = {
  center: ApprovalCenter;
  router: ApprovalRouter;
  gateway: ApprovalBridgeGateway;
  intervalMs?: number;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

export type ApprovalBridge = {
  /** Start the TTL sweeper. */
  start(): void;
  /** Stop the TTL sweeper. */
  stop(): void;
  /** Sweep once (exposed for tests and for manual triggers). */
  sweep(): Promise<void>;
};

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

export function createApprovalBridge(options: ApprovalBridgeOptions): ApprovalBridge {
  const { center, router, gateway } = options;
  const logger = options.logger ?? {};
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;

  const eventSink: ApprovalEventSink = (input) => {
    void router
      .handleEvent(input)
      .catch((error: unknown) => {
        logger.error?.(
          `[approval] failed to route event: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  const decisionGuard: ApprovalDecisionGuard = async (input) => {
    const record = center.findByRequestId(input.requestId, input.sessionKey);
    if (input.origin === "im") {
      // Contract §3/§4: an answer from a chat channel must be backed by a
      // record of the approval center. Without a record there is nothing to
      // authorize, so the decision is refused instead of silently allowed.
      if (!record) return { allowed: false, reason: "im_decision_without_record" };
      if (record.state !== "pending") {
        return { allowed: false, reason: `approval_${record.state}` };
      }
      if (record.expiresAt <= Date.now()) {
        return { allowed: false, reason: "approval_expired" };
      }
      // Contract §4: every IM answer, including a denial, must be backed by
      // a pending approval record. A denial cannot escalate privileges, but
      // an unbound chat must not be able to veto somebody else's request.
      if (input.decision === "allow" && input.remember === true && !canDecideViaIm(record.risk)) {
        return {
          allowed: false,
          reason: "im_session_authorization_not_allowed_for_high_risk",
        };
      }
      // A request that the answering channel raised itself is answered in
      // that channel's own numbered prompt (1 = allow once, 2 = allow for
      // the session). That prompt *is* the native authorization interface
      // the contract keeps high risk requests in. Mirrored decisions still
      // require the IM risk gate for allows and the binding check for both
      // allows and denials.
      const nativeDecision = center.isNativeChannelDecision(record, input.channelKey);
      if (!nativeDecision || input.decision === "deny") {
        if (input.decision === "allow" && !canDecideViaIm(record.risk)) {
          return { allowed: false, reason: "risk_not_im_decidable" };
        }
        const rejection = center.checkImBinding(record, {
          channelKey: input.channelKey,
          chatId: input.chatId,
          actor: input.actor,
        });
        if (rejection) return { allowed: false, reason: rejection };
      }
      return { allowed: true };
    }
    // Web / api / system — keep the existing native behaviour untouched when
    // the request was never registered in the center. Denials retain their
    // previous unconditional pass-through for these non-IM origins.
    if (input.decision === "deny") return { allowed: true };
    if (!record) return { allowed: true };
    if (record.state !== "pending") {
      return { allowed: false, reason: `approval_${record.state}` };
    }
    if (record.expiresAt <= Date.now()) {
      return { allowed: false, reason: "approval_expired" };
    }
    return { allowed: true };
  };

  const decisionSink: ApprovalDecisionSink = (input) => {
    if (input.blocked) {
      // The guard refused the decision — the request stays pending, but the
      // attempt has to be visible in the audit trail (contract §8).
      const record = center.findByRequestId(input.requestId, input.sessionKey);
      void center
        .auditEvent({
          approvalId: record?.id ?? input.requestId,
          action: "decision_blocked",
          actor: input.actor,
          actorSource: input.actorSource,
          channelKey: input.channelKey,
          detail: `${input.blockedReason ?? "blocked"}:tool=${record?.toolName ?? "unknown"}`,
        })
        .catch((error: unknown) => {
          logger.error?.(
            `[approval] failed to record blocked decision: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return;
    }
    void center
      .resolve({
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        decision: input.decision,
        // A missing identity stays missing: the audit trail must never name
        // an answerer that did not report one (contract §8). The empty string
        // keeps the `actor: string` shape of the decision record — the audit
        // writer omits a falsy actor, so the entry stays empty.
        actor: input.actor ?? "",
        source: input.origin ?? "web",
        channelKey: input.channelKey,
        chatId: input.chatId,
        actorSource: input.actorSource,
        remember: input.remember,
        reason: input.reason,
      })
      .catch((error: unknown) => {
        logger.error?.(
          `[approval] failed to record decision: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  let registered = false;

  const register = (): void => {
    if (registered) return;
    registered = true;
    gateway.addApprovalEventSink?.(eventSink);
    gateway.addApprovalDecisionGuard?.(decisionGuard);
    gateway.addApprovalDecisionSink?.(decisionSink);
  };

  const unregister = (): void => {
    if (!registered) return;
    registered = false;
    // `?.()` keeps the bridge usable with a gateway that does not implement
    // the removal (an older in-process gateway).
    gateway.removeApprovalEventSink?.(eventSink);
    gateway.removeApprovalDecisionGuard?.(decisionGuard);
    gateway.removeApprovalDecisionSink?.(decisionSink);
  };

  register();

  const sweep = async (): Promise<void> => {
    try {
      const expired = await center.expireDue();
      for (const record of expired) {
        try {
          await gateway.permissionDecide({
            sessionKey: record.sessionKey,
            requestId: record.requestId,
            decision: "deny",
            reason: "approval_expired",
            actor: "system",
            origin: "system",
          });
        } catch (error) {
          logger.warn?.(
            `[approval] failed to deny expired approval ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      logger.error?.(
        `[approval] sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    start() {
      // A bridge that was stopped is re-registered, so `stop()` followed by
      // `start()` leaves the gateway with the same wiring it had before.
      register();
      if (timer) return;
      timer = setInterval(() => {
        void sweep();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      // The guard and the audit sinks must not outlive the bridge: a stopped
      // approval center may no longer decide anything, so the gateway must
      // not run its guard or write its audit entries either.
      unregister();
    },
    sweep,
  };
}
