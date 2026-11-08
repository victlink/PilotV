/**
 * Assembly point of the unified approval center (统一审批中心).
 *
 * Contract §7 requires the center, the router and the bridge to be wired in
 * `src/cli/createLocalGateway.ts` / `src/gateway/Gateway.ts` — i.e. in the
 * gateway factory itself, so that *every* gateway (server, tui, cli) runs the
 * approval runtime and not only the server command.
 *
 * `createApprovalRuntime()` is asynchronous (`await center.init()`), while the
 * gateway factories are synchronous. This module keeps the synchronous
 * signature intact and exposes a readiness handle instead:
 *
 *  - `ready`   — a promise that settles once the center is initialised and
 *                the bridge is running.
 *  - `current()` — the runtime, available once `ready` settled.
 *
 * Two invariants hold while the center is still initialising:
 *
 *  1. No event is registered in the center before `center.init()` finished —
 *     events are buffered and replayed afterwards, so nothing is lost.
 *  2. No decision is adjudicated before `center.init()` finished — an `allow`
 *     is refused with `approval_runtime_not_ready`. A `deny` is allowed
 *     through because a denial can never escalate privileges (same rule the
 *     production guard uses).
 */

import type { ApprovalCapableChannel, ApprovalGateway } from "../../approval/ApprovalRouter.js";
import type {
  ApprovalBridgeGateway,
  ApprovalDecisionGuard,
  ApprovalEventInput,
  ApprovalEventSink,
} from "../../gateway/approval/createApprovalBridge.js";
import { createApprovalRuntime, type ApprovalRuntime } from "./approvalRuntime.js";

export type ApprovalRuntimeLogger = {
  warn?(message: string): void;
  error?(message: string): void;
};

export type AttachApprovalRuntimeOptions = {
  gateway: ApprovalBridgeGateway & ApprovalGateway;
  pilotHome: string;
  /** Resolve a chat channel for the IM mirror. Optional: without it the
   *  center still works (guard / audit / TTL) but cannot mirror prompts. */
  resolveChannel?: (channelKey: string) => ApprovalCapableChannel | undefined;
  logger?: ApprovalRuntimeLogger;
  intervalMs?: number;
};

export type ApprovalRuntimeHandle = {
  /** Settles once the center is initialised (or after a failed init). */
  ready: Promise<void>;
  /** The runtime, or `undefined` while it is still initialising. */
  current(): ApprovalRuntime | undefined;
  /** The init failure, when the runtime could not be created. */
  error(): Error | undefined;
  /** Stop the bridge and release every gateway hook. */
  stop(): void;
};

/** Reason returned while the approval runtime is still initialising. */
export const APPROVAL_RUNTIME_NOT_READY_REASON = "approval_runtime_not_ready";

/**
 * One handle per gateway instance: `createLocalGateway()` and
 * `Gateway.createGateway()` must never wire two centers onto the same
 * gateway, otherwise every decision would be audited twice.
 */
const handles = new WeakMap<object, ApprovalRuntimeHandle>();

export function attachApprovalRuntime(
  options: AttachApprovalRuntimeOptions,
): ApprovalRuntimeHandle {
  const gateway = options.gateway;
  // The WeakMap is keyed by the instance, the typed gateway is used for the
  // sink registration.
  const key = options.gateway as unknown as object;
  const existing = handles.get(key);
  if (existing) return existing;

  const logger = options.logger ?? {};
  let runtime: ApprovalRuntime | undefined;
  let failure: Error | undefined;
  let stopped = false;

  // Events raised before the center is ready are buffered here and replayed
  // once the router exists.
  const bufferedEvents: ApprovalEventInput[] = [];
  const bufferingSink: ApprovalEventSink = (input) => {
    bufferedEvents.push(input);
  };

  // Until the center is ready no `allow` may be adjudicated: the request
  // would not be known to the center, so the audit trail would be wrong.
  const notReadyGuard: ApprovalDecisionGuard = async (input) => {
    if (input.decision === "deny") return { allowed: true };
    return { allowed: false, reason: APPROVAL_RUNTIME_NOT_READY_REASON };
  };

  gateway.addApprovalEventSink?.(bufferingSink);
  gateway.addApprovalDecisionGuard?.(notReadyGuard);

  const ready = (async () => {
    try {
      runtime = await createApprovalRuntime({
        gateway: options.gateway,
        pilotHome: options.pilotHome,
        resolveChannel: options.resolveChannel ?? (() => undefined),
        logger,
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
        // The bridge registers its own event sink and decision guard inside
        // `createApprovalRuntime`. The handover below runs in the very same
        // tick, so no event can reach two sinks and no decision can hit the
        // temporary guard after the real one took over.
        onRuntimeCreated: (created) => {
          gateway.removeApprovalDecisionGuard?.(notReadyGuard);
          gateway.removeApprovalEventSink?.(bufferingSink);
          // Replay the events that were raised while the center was starting.
          const pending = bufferedEvents.splice(0, bufferedEvents.length);
          for (const event of pending) {
            void created.router
              .handleEvent(event)
              .catch((error: unknown) => {
                logger.error?.(
                  `[approval] failed to route buffered event: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          }
        },
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      logger.error?.(
        `[approval] failed to initialise the approval runtime: ${failure.message}`,
      );
      // The native flow must keep working even without the center.
      gateway.removeApprovalDecisionGuard?.(notReadyGuard);
      gateway.removeApprovalEventSink?.(bufferingSink);
      bufferedEvents.length = 0;
      return;
    }

    if (stopped) {
      runtime.stop();
      return;
    }

    runtime.start();
  })();

  const handle: ApprovalRuntimeHandle = {
    ready: ready.then(() => undefined),
    current: () => runtime,
    error: () => failure,
    stop: () => {
      stopped = true;
      gateway.removeApprovalDecisionGuard?.(notReadyGuard);
      gateway.removeApprovalEventSink?.(bufferingSink);
      runtime?.stop();
    },
  };

  handles.set(key, handle);
  return handle;
}

/**
 * The approval runtime handle of a gateway, when one was attached.
 *
 * `createLocalGateway()` and `Gateway.createGateway()` both attach the
 * runtime; the handle is keyed by the gateway instance, so the second call
 * returns the first one instead of wiring a second center.
 */
export function getApprovalRuntimeHandle(gateway: object): ApprovalRuntimeHandle | undefined {
  return handles.get(gateway);
}

/** Wait until the approval runtime of a gateway is initialised. */
export async function waitForApprovalRuntime(gateway: object): Promise<ApprovalRuntime | undefined> {
  const handle = handles.get(gateway);
  if (!handle) return undefined;
  await handle.ready;
  return handle.current();
}
