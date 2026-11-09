import type { Gateway, GatewayEvent } from "../../../gateway/index.js";

/**
 * Lightweight helper that manages pending elicitation state for IM channels.
 *
 * IM channels process one turn at a time per chat (`activeChats` guard), so
 * user replies arrive through the normal inbound handler. When the agent emits
 * an `elicitation_request` the event stream blocks until `respondElicitation`
 * is called. This helper:
 *
 *   1. Captures the pending request when the channel sees an elicitation event.
 *   2. Formats the question(s) as a numbered-option text message.
 *   3. When the user's next message arrives, resolves the pending elicitation
 *      by mapping the reply (a number or label) back to the original option.
 *
 * Mirrored elicitations (a Web turn that the approval center offers to a chat
 * channel) live in the same queue as the native ones — never in the permission
 * queue, so an answer to a question can never be read as a permission
 * decision.
 */

type PendingElicitation = {
  sessionKey: string;
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
  /** Set when the request was mirrored from another channel. */
  mirrored?: boolean;
  expiresAt?: number;
};

export type MirroredElicitationRequest = {
  sessionKey: string;
  requestId: string;
  questions: PendingElicitation["questions"];
  expiresAt?: number;
};

export type ImElicitationAnswerOptions = {
  actor?: string;
  origin?: "web" | "im" | "system" | "api";
  /** Channel the answer comes from; used for the approval binding check. */
  channelKey?: string;
  /** Chat the answer comes from. */
  chatId?: string;
  /** Provenance of `actor`. */
  actorSource?: "channel_identity" | "client_reported";
};

export class ImElicitationHelper {
  private readonly pending = new Map<string, PendingElicitation>();

  /**
   * Call when the event stream yields an `elicitation_request`.
   * Returns the formatted question text to send to the user.
   */
  capture(chatId: string, sessionKey: string, event: GatewayEvent & { type: "elicitation_request" }): string {
    this.pending.set(chatId, {
      sessionKey,
      requestId: event.requestId,
      questions: event.questions,
    });

    return this.formatQuestions(event.questions);
  }

  /**
   * Register a request that the approval center mirrored into this channel.
   * The reply is answered through the elicitation path, so it can never be
   * mistaken for a permission decision.
   */
  captureMirrored(chatId: string, request: MirroredElicitationRequest): string | undefined {
    this.pruneExpired(chatId);
    if (this.pending.has(chatId)) return undefined;
    this.pending.set(chatId, {
      sessionKey: request.sessionKey,
      requestId: request.requestId,
      questions: request.questions,
      mirrored: true,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    });
    return this.formatQuestions(request.questions);
  }

  /** Drop a mirrored request again (delivery failed). */
  removeMirrored(chatId: string, requestId: string): void {
    const entry = this.pending.get(chatId);
    if (!entry) return;
    if (entry.mirrored && entry.requestId === requestId) this.pending.delete(chatId);
  }

  hasPending(chatId: string): boolean {
    this.pruneExpired(chatId);
    return this.pending.has(chatId);
  }

  /**
   * Call when the user sends a message while an elicitation is pending.
   * Parses the reply, calls `gateway.respondElicitation`, and clears state.
   * Returns a confirmation string to send back, or undefined if nothing to say.
   */
  async answer(
    chatId: string,
    text: string,
    gateway: Gateway,
    options?: ImElicitationAnswerOptions,
  ): Promise<string | undefined> {
    this.pruneExpired(chatId);
    const entry = this.pending.get(chatId);
    if (!entry) return undefined;
    this.pending.delete(chatId);

    const trimmed = text.trim();

    if (trimmed === "0") {
      await gateway.respondElicitation({
        sessionKey: entry.sessionKey,
        requestId: entry.requestId,
        answer: { type: "cancelled", reason: "user cancelled" },
        ...(options?.actor !== undefined ? { actor: options.actor } : {}),
        ...(options?.origin !== undefined ? { origin: options.origin } : { origin: "im" }),
        ...(options?.channelKey !== undefined ? { channelKey: options.channelKey } : {}),
        ...(options?.chatId !== undefined ? { chatId: options.chatId } : {}),
        ...(options?.actorSource !== undefined ? { actorSource: options.actorSource } : {}),
      });
      return "已取消。";
    }

    const answers: Record<string, string | string[]> = {};

    for (const q of entry.questions) {
      const indices = trimmed.split(/[,，\s]+/).map((s) => Number.parseInt(s, 10)).filter((n) => !Number.isNaN(n));

      const selected: string[] = [];
      for (const idx of indices) {
        if (idx >= 1 && idx <= q.options.length) {
          selected.push(q.options[idx - 1].label);
        }
      }

      if (selected.length === 0) {
        selected.push(trimmed);
      }

      answers[q.question] = q.multiSelect ? selected : (selected[0] ?? trimmed);
    }

    await gateway.respondElicitation({
      sessionKey: entry.sessionKey,
      requestId: entry.requestId,
      answer: { type: "answered", answers },
      ...(options?.actor !== undefined ? { actor: options.actor } : {}),
      ...(options?.origin !== undefined ? { origin: options.origin } : { origin: "im" }),
      ...(options?.channelKey !== undefined ? { channelKey: options.channelKey } : {}),
      ...(options?.chatId !== undefined ? { chatId: options.chatId } : {}),
      ...(options?.actorSource !== undefined ? { actorSource: options.actorSource } : {}),
    });
    return undefined;
  }

  clear(chatId: string): void {
    this.pending.delete(chatId);
  }

  /** Drop mirrored questions whose TTL elapsed. */
  private pruneExpired(chatId: string): void {
    const entry = this.pending.get(chatId);
    if (!entry || entry.expiresAt === undefined) return;
    if (entry.expiresAt > Date.now()) return;
    this.pending.delete(chatId);
  }

  private formatQuestions(
    questions: PendingElicitation["questions"],
  ): string {
    const lines: string[] = [];
    for (const q of questions) {
      if (q.header) lines.push(`**${q.header}**`);
      if (q.question) lines.push(q.question);
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        lines.push(`${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`);
      }
    }
    lines.push("", "回复数字选择（多选用逗号分隔），回复 0 取消。");
    return lines.join("\n");
  }
}
