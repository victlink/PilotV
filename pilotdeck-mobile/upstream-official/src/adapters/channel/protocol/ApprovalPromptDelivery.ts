/**
 * Shared orchestration for mirroring an approval prompt into a chat channel.
 *
 * The ApprovalRouter only mirrors a pending decision; it never answers it.
 * This module owns the two steps every channel needs:
 *
 *  1. register the mirrored request in the channel's {@link ImPermissionHelper}
 *     so the numeric reply (`1` / `2` / `0`) is recognised and routed back to
 *     the original turn, and
 *  2. deliver the prompt text through the channel's own outbound API.
 *
 * Keeping this in one small, dependency-free module means the behaviour can be
 * unit tested without instantiating a Feishu / WeCom client (no network, no
 * credentials), while the channel classes stay responsible for *how* a message
 * leaves the process.
 */

import type { ApprovalPromptRoute } from "../../../approval/ApprovalRouter.js";
import type { ImElicitationHelper } from "./ImElicitationHelper.js";
import type { ImPermissionHelper } from "./ImPermissionHelper.js";

export type ApprovalPromptSender = (chatId: string, text: string) => Promise<boolean>;

export type ApprovalPromptDeliveryOptions = {
  /** Pending-queue owner of the channel (the channel's own ImPermissionHelper). */
  helper: ImPermissionHelper;
  /** Route built by the ApprovalRouter for this channel/chat binding. */
  route: ApprovalPromptRoute;
  /** Outbound delivery, provided by the channel adapter. */
  send: ApprovalPromptSender;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

export type ElicitationPromptDeliveryOptions = {
  /** Pending-queue owner of the channel (the channel's own ImElicitationHelper). */
  helper: ImElicitationHelper;
  /** Route built by the ApprovalRouter for this channel/chat binding. */
  route: ApprovalPromptRoute;
  /** Outbound delivery, provided by the channel adapter. */
  send: ApprovalPromptSender;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

/**
 * Register the mirrored request and deliver the prompt.
 *
 * Returns `true` when the prompt was handed to the outbound API successfully.
 * On failure the freshly registered pending entry is removed again so no
 * dangling approval waits for an answer that can never arrive.
 */
export async function deliverApprovalPrompt(
  options: ApprovalPromptDeliveryOptions,
): Promise<boolean> {
  const { helper, route, send, logger } = options;
  helper.captureMirrored(route.chatId, {
    sessionKey: route.sessionKey,
    requestId: route.requestId,
    toolName: route.toolName,
    expiresAt: route.expiresAt,
    prompt: route.prompt,
  });

  let delivered = false;
  try {
    delivered = await send(route.chatId, route.prompt);
  } catch (error) {
    logger?.error?.(
      `[approval] prompt delivery to ${route.chatId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (delivered) return true;
  // A delivery that reports "not sent" is as much a failure as a throwing
  // one — without a log line the request silently disappears from the chat.
  logger?.warn?.(
    `[approval] prompt delivery to ${route.chatId} did not succeed (request ${route.requestId})`,
  );
  helper.removeMirrored(route.chatId, route.requestId);
  return false;
}

/**
 * Deliver a mirrored *elicitation* to a chat channel.
 *
 * The question is registered in the channel's elicitation queue — never in the
 * permission queue — so the reply is answered through the elicitation path and
 * can never be read as a permission decision.
 */
export async function deliverElicitationPrompt(options: ElicitationPromptDeliveryOptions): Promise<boolean> {
  const { helper, route, send, logger } = options;
  const questions = route.questions ?? [];
  const text =
    helper.captureMirrored(route.chatId, {
      sessionKey: route.sessionKey,
      requestId: route.requestId,
      questions,
      expiresAt: route.expiresAt,
    }) ?? route.prompt;

  let delivered = false;
  try {
    delivered = await send(route.chatId, text);
  } catch (error) {
    logger?.error?.(
      `[approval] failed to deliver elicitation prompt to ${route.chatId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (delivered) return true;
  helper.removeMirrored(route.chatId, route.requestId);
  return false;
}
