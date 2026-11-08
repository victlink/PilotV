import { ApprovalCenter } from "../../approval/ApprovalCenter.js";
import {
  ApprovalRouter,
  type ApprovalCapableChannel,
  type ApprovalGateway,
} from "../../approval/ApprovalRouter.js";
import { createApprovalBridge, type ApprovalBridge, type ApprovalBridgeGateway } from "../../gateway/approval/createApprovalBridge.js";
import { getPilotApprovalBindingsFilePath, getPilotApprovalDir } from "../../pilot/paths.js";
import { loadApprovalBindingConfigs, type ApprovalBindingsLogger } from "./approvalBindings.js";

export type ApprovalRuntimeOptions = {
  gateway: ApprovalBridgeGateway & ApprovalGateway;
  pilotHome: string;
  /**
   * Resolves the chat channel of a binding. Optional: a gateway that has no
   * chat channel (tui / cli) still runs the center, the guard, the audit and
   * the TTL sweeper — only the IM mirror is missing (contract §3).
   */
  resolveChannel?: (channelKey: string) => ApprovalCapableChannel | undefined;
  logger?: ApprovalBindingsLogger & { error?(message: string): void };
  intervalMs?: number;
  /**
   * Called synchronously right after the bridge was constructed — i.e. after
   * `center.init()` finished and after the bridge registered its own event
   * sink and decision guard.
   *
   * The caller uses it to hand over the buffering sink it registered before
   * `center.init()` without a race: the callback runs in the same tick as the
   * bridge registration, so no event can be handled twice.
   */
  onRuntimeCreated?: (runtime: ApprovalRuntime) => void;
};

export type ApprovalRuntime = {
  center: ApprovalCenter;
  router: ApprovalRouter;
  bridge: ApprovalBridge;
  bindingsFilePath: string;
  start(): void;
  stop(): void;
};

/** Construct and initialize the gateway-level approval runtime. */
export async function createApprovalRuntime(options: ApprovalRuntimeOptions): Promise<ApprovalRuntime> {
  const logger = options.logger ?? {};
  const center = new ApprovalCenter({
    storeDir: getPilotApprovalDir(options.pilotHome),
    logger,
  });
  await center.init();

  const bindingsFilePath = getPilotApprovalBindingsFilePath(options.pilotHome);
  const router = new ApprovalRouter({
    center,
    gateway: options.gateway,
    resolveChannel: options.resolveChannel ?? (() => undefined),
    // Read on each event so edits take effect without restarting the gateway.
    bindingConfigs: () => loadApprovalBindingConfigs(bindingsFilePath, { logger }),
    logger,
  });
  const bridge = createApprovalBridge({
    center,
    router,
    gateway: options.gateway,
    intervalMs: options.intervalMs,
    logger,
  });

  const runtime: ApprovalRuntime = {
    center,
    router,
    bridge,
    bindingsFilePath,
    start: () => bridge.start(),
    stop: () => bridge.stop(),
  };
  // The bridge is registered with the gateway at this point — the caller can
  // hand over its own buffering sink without a race window.
  options.onRuntimeCreated?.(runtime);
  return runtime;
}
