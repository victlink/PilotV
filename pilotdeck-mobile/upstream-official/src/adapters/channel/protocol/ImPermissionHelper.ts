import type { Gateway, GatewayEvent } from "../../../gateway/index.js";

type PendingPermission = {
  sessionKey: string;
  requestId: string;
  toolName: string;
  payload: unknown;
  /** Chat the request was raised in (native) or mirrored to. */
  chatId?: string;
  mirrored?: boolean;
  expiresAt?: number;
  prompt?: string;
};

export type ImPermissionAnswerOptions = {
  actor?: string;
  origin?: "web" | "im" | "system" | "api";
  /** Channel the answer comes from; defaults to the helper's own channel. */
  channelKey?: string;
  /** Chat the answer comes from; defaults to the pending entry's chat. */
  chatId?: string;
  /**
   * Provenance of `actor`. Chat adapters verified the sender, so they pass
   * `channel_identity`; the WebSocket entry point has no user identity and
   * passes `client_reported`.
   */
  actorSource?: "channel_identity" | "client_reported";
};

export type ImPermissionHelperOptions = {
  /** Channel this helper belongs to (used for the approval binding check). */
  channelKey?: string;
};

export type MirroredPermissionRequest = {
  sessionKey: string;
  requestId: string;
  toolName: string;
  payload?: unknown;
  expiresAt?: number;
  prompt?: string;
};

type PendingPrompt = {
  text: string;
  requestId: string;
};

/**
 * Pending permissions of one chat.
 *
 * Native requests (raised by this channel) and mirrored requests (offered by
 * the unified approval center for a turn that started elsewhere) live in
 * separate queues: a mirrored entry must never occupy the slot of a request
 * the chat itself raised, and it must never be answered by mistake.
 */
type ChatPermissionState = {
  native: PendingPermission[];
  mirrored: PendingPermission[];
};

export type ImPermissionAnswerResult = {
  text?: string;
  /** True only for the invocation that completed a permission decision. */
  canAdvance: boolean;
  /** True when the caller should retry delivery of an already queued prompt. */
  retryPrompt?: boolean;
  answerToken?: number;
};

export class ImPermissionHelper {
  private readonly pending = new Map<string, ChatPermissionState>();
  /** requestId of the prompt that was delivered last, per chat. */
  private readonly lastPromptRequestId = new Map<string, string>();
  private readonly nextPrompts = new Map<string, PendingPrompt>();
  private readonly promptDelivering = new Set<string>();
  private readonly retryPromptPending = new Set<string>();
  private readonly initialPromptPending = new Set<string>();
  private readonly answering = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly answerTokens = new Map<string, number>();
  private readonly deferredClears = new Set<string>();
  private nextAnswerToken = 1;
  /** Channel this helper belongs to; reported with every decision. */
  private readonly channelKey?: string;

  constructor(options?: ImPermissionHelperOptions) {
    this.channelKey = options?.channelKey;
  }

  capture(chatId: string, sessionKey: string, event: GatewayEvent & { type: "permission_request" }): string | undefined {
    this.pruneExpired(chatId);
    const state = this.state(chatId);
    const entry: PendingPermission = {
      sessionKey,
      requestId: event.requestId,
      toolName: event.toolName,
      payload: event.payload,
      chatId,
    };
    state.native.push(entry);
    this.saveState(chatId, state);

    if (state.native.length + state.mirrored.length !== 1 || this.answering.has(chatId)) return undefined;
    const prompt = formatPermissionPrompt(entry);
    this.answering.add(chatId);
    this.nextPrompts.set(chatId, { text: prompt, requestId: entry.requestId });
    this.lastPromptRequestId.set(chatId, entry.requestId);
    this.initialPromptPending.add(chatId);
    return prompt;
  }

  captureMirrored(chatId: string, request: MirroredPermissionRequest): string | undefined {
    this.pruneExpired(chatId);
    const state = this.state(chatId);
    const entry: PendingPermission = {
      sessionKey: request.sessionKey,
      requestId: request.requestId,
      toolName: request.toolName,
      payload: request.payload,
      chatId,
      mirrored: true,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    };
    state.mirrored.push(entry);
    this.saveState(chatId, state);
    if (state.native.length + state.mirrored.length !== 1 || this.answering.has(chatId)) return undefined;
    this.lastPromptRequestId.set(chatId, entry.requestId);
    return formatPermissionPrompt(entry);
  }

  /**
   * Drop mirrored entries whose TTL elapsed.
   *
   * A stale mirrored request must never swallow the next ordinary message of
   * the chat: without this, the first reply after the TTL would be consumed
   * as the answer to a request that is long gone.
   */
  private pruneExpired(chatId: string): void {
    const state = this.pending.get(chatId);
    if (!state) return;
    const now = Date.now();
    const isAlive = (entry: PendingPermission) => entry.expiresAt === undefined || entry.expiresAt > now;
    const native = state.native.filter(isAlive);
    const mirrored = state.mirrored.filter(isAlive);
    if (native.length === state.native.length && mirrored.length === state.mirrored.length) return;
    this.saveState(chatId, { native, mirrored });
  }

  hasMirroredPending(chatId: string): boolean {
    this.pruneExpired(chatId);
    return (this.pending.get(chatId)?.mirrored.length ?? 0) > 0;
  }

  removeMirrored(chatId: string, requestId: string): void {
    const state = this.pending.get(chatId);
    if (!state) return;
    const mirrored = state.mirrored.filter((entry) => entry.requestId !== requestId);
    if (mirrored.length === state.mirrored.length) return;
    this.saveState(chatId, { native: state.native, mirrored });
    if (state.native.length === 0 && mirrored.length === 0) this.clear(chatId);
  }

  formatPending(chatId: string): string | undefined {
    this.pruneExpired(chatId);
    const state = this.pending.get(chatId);
    const entry = state?.native[0] ?? state?.mirrored[0];
    return entry ? formatPermissionPrompt(entry) : undefined;
  }

  hasPending(chatId: string): boolean {
    this.pruneExpired(chatId);
    const state = this.pending.get(chatId);
    return (state?.native.length ?? 0) + (state?.mirrored.length ?? 0) > 0 || this.answering.has(chatId);
  }

  isAnswering(chatId: string): boolean {
    return this.answering.has(chatId);
  }

  takeNextPrompt(chatId: string, answerToken?: number): string | undefined {
    // Status replies from answer() are non-advancing. Do not let an inbound
    // reply during initial delivery or an in-flight decision consume the
    // queued prompt and clear the lock.
    if (answerToken !== undefined && this.answerTokens.get(chatId) !== answerToken) return undefined;
    if (this.promptDelivering.has(chatId) || this.initialPromptPending.has(chatId) || this.inFlight.has(chatId)) return undefined;
    let prompt = this.nextPrompts.get(chatId);
    if (!prompt) {
      this.pruneExpired(chatId);
      const state = this.pending.get(chatId);
      const entry = state?.native[0] ?? state?.mirrored[0];
      if (!entry) {
        this.confirmAnswer(chatId, answerToken);
        return undefined;
      }
      prompt = { text: formatPermissionPrompt(entry), requestId: entry.requestId };
      this.nextPrompts.set(chatId, prompt);
    }
    this.promptDelivering.add(chatId);
    return prompt.text;
  }

  getPromptRequestId(chatId: string, answerToken?: number): string | undefined {
    if (answerToken !== undefined && this.answerTokens.get(chatId) !== answerToken) return undefined;
    return this.nextPrompts.get(chatId)?.requestId;
  }

  confirmInitialPrompt(chatId: string, delivered: boolean | void = true, expectedRequestId?: string): void {
    if (!this.answering.has(chatId) || !this.nextPrompts.has(chatId)) return;
    if (expectedRequestId !== undefined && this.nextPrompts.get(chatId)?.requestId !== expectedRequestId) return;
    if (!delivered) {
      this.initialPromptPending.delete(chatId);
      this.retryPromptPending.add(chatId);
      return;
    }
    this.nextPrompts.delete(chatId);
    this.initialPromptPending.delete(chatId);
    this.retryPromptPending.delete(chatId);
    this.answering.delete(chatId);
    this.finishDeferredClear(chatId);
  }

  confirmNextPrompt(
    chatId: string,
    delivered: boolean | void = true,
    expectedRequestId?: string,
    answerToken?: number,
  ): void {
    if (answerToken !== undefined && this.answerTokens.get(chatId) !== answerToken) return;
    if (!this.promptDelivering.has(chatId)) return;
    if (expectedRequestId !== undefined && this.nextPrompts.get(chatId)?.requestId !== expectedRequestId) return;
    this.promptDelivering.delete(chatId);
    if (!delivered) {
      this.retryPromptPending.add(chatId);
      return;
    }
    this.nextPrompts.delete(chatId);
    this.retryPromptPending.delete(chatId);
    this.answering.delete(chatId);
    this.answerTokens.delete(chatId);
    this.finishDeferredClear(chatId);
  }

  /** Release a completed answer when the adapter cannot deliver its reply. */
  releaseAnswer(chatId: string, answerToken?: number): void {
    if (answerToken !== undefined && this.answerTokens.get(chatId) !== answerToken) return;
    // Keep the queued prompt and lock intact so a failed delivery cannot let
    // the next inbound message decide the unseen request.
    this.promptDelivering.delete(chatId);
    if (this.nextPrompts.has(chatId)) this.retryPromptPending.add(chatId);
    else this.confirmAnswer(chatId, answerToken);
  }

  /** Mark the confirmation message as delivered and release the final answer lock. */
  confirmAnswer(chatId: string, answerToken?: number): void {
    if (answerToken !== undefined && this.answerTokens.get(chatId) !== answerToken) return;
    if (!this.answering.has(chatId) || this.inFlight.has(chatId) || this.initialPromptPending.has(chatId)) return;
    if (this.promptDelivering.has(chatId) || this.nextPrompts.has(chatId)) return;
    const state = this.pending.get(chatId);
    if ((state?.native.length ?? 0) + (state?.mirrored.length ?? 0) > 0) return;
    this.retryPromptPending.delete(chatId);
    this.answering.delete(chatId);
    this.answerTokens.delete(chatId);
    this.finishDeferredClear(chatId);
  }

  /** Clear state after a completed turn, without racing an answer delivery. */
  clearAfterTurn(chatId: string): void {
    const initialPromptSending = this.initialPromptPending.has(chatId);
    if (
      this.inFlight.has(chatId)
      || this.promptDelivering.has(chatId)
      || this.retryPromptPending.has(chatId)
      || (!initialPromptSending && this.answering.has(chatId))
    ) {
      this.deferredClears.add(chatId);
      return;
    }
    this.clear(chatId);
  }

  /** Pending state of a chat (not stored when it does not exist). */
  private state(chatId: string): ChatPermissionState {
    return readState(chatId, this.pending) ?? { native: [], mirrored: [] };
  }

  /** Store the pending state, dropping the chat when it is empty. */
  private saveState(chatId: string, state: ChatPermissionState): void {
    if (state.native.length === 0 && state.mirrored.length === 0) this.pending.delete(chatId);
    else this.pending.set(chatId, state);
  }

  private finishDeferredClear(chatId: string): void {
    if (!this.deferredClears.has(chatId)) return;
    const state = this.pending.get(chatId);
    if (
      (state?.native.length ?? 0) + (state?.mirrored.length ?? 0) > 0
      || this.answering.has(chatId)
      || this.inFlight.has(chatId)
      || this.promptDelivering.has(chatId)
      || this.initialPromptPending.has(chatId)
      || this.nextPrompts.has(chatId)
      || this.retryPromptPending.has(chatId)
    ) return;
    this.deferredClears.delete(chatId);
    this.clearNow(chatId);
  }

  async answer(
    chatId: string,
    text: string,
    gateway: Gateway,
    options?: ImPermissionAnswerOptions,
  ): Promise<string | undefined> {
    return (await this.answerWithState(chatId, text, gateway, options))?.text;
  }

  async answerWithState(
    chatId: string,
    text: string,
    gateway: Gateway,
    options?: ImPermissionAnswerOptions,
  ): Promise<ImPermissionAnswerResult | undefined> {
    if (this.answering.has(chatId)) {
      // Keep ordinary messages inside the permission flow while the RPC or
      // prompt delivery is pending. The structured result prevents adapters
      // from treating these status messages as completed decisions.
      if (this.inFlight.has(chatId)) return { text: "权限决定处理中，请稍候。", canAdvance: false };
      if (this.initialPromptPending.has(chatId)) return { text: "权限提示发送中，请稍候。", canAdvance: false };
      return this.retryPromptPending.has(chatId)
        ? { text: "上一条权限提示发送失败，正在重试。", canAdvance: false, retryPrompt: true }
        : undefined;
    }
    const state = this.state(chatId);
    if (state.native.length === 0 && state.mirrored.length === 0) return undefined;

    const trimmed = text.trim();
    if (trimmed !== "0" && trimmed !== "1" && trimmed !== "2") {
      return { text: "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。", canAdvance: false };
    }

    this.answering.add(chatId);
    this.inFlight.add(chatId);
    const answerToken = this.nextAnswerToken++;
    this.answerTokens.set(chatId, answerToken);
    const generation = (this.generations.get(chatId) ?? 0) + 1;
    this.generations.set(chatId, generation);
    // Answer the request the chat is actually looking at: the prompt that was
    // delivered last wins. Without it a queued mirrored request could swallow
    // the reply that belongs to a native request (and vice versa).
    const entry = takePendingEntry(state, this.lastPromptRequestId.get(chatId));
    if (!entry) {
      this.answering.delete(chatId);
      return undefined;
    }
    this.saveState(chatId, state);
    const deny = trimmed === "0";
    // The channel and the chat are always reported: without them the
    // approval center cannot match the answer against the binding
    // (contract §4) and every IM answer would be rejected.
    const channelKey = options?.channelKey ?? this.channelKey;
    const decidedChatId = options?.chatId ?? entry.chatId;
    const origin = options?.origin !== undefined ? options.origin : "im";
    // A chat adapter knows who it is talking to — the channel verified the
    // sender — so an IM answer is reported as `channel_identity`.
    const actorSource = options?.actorSource ?? (origin === "im" ? "channel_identity" : undefined);
    try {
      const decision = await gateway.permissionDecide({
        sessionKey: entry.sessionKey,
        requestId: entry.requestId,
        decision: deny ? "deny" : "allow",
        ...(deny ? { reason: "User denied permission from IM channel." } : {}),
        ...(!deny ? { remember: trimmed === "2" } : {}),
        ...(options?.actor !== undefined ? { actor: options.actor } : {}),
        origin,
        ...(channelKey !== undefined ? { channelKey } : {}),
        ...(decidedChatId !== undefined ? { chatId: decidedChatId } : {}),
        ...(actorSource !== undefined ? { actorSource } : {}),
      });
      if ((this.generations.get(chatId) ?? 0) !== generation) return undefined;
      if (!decision.delivered) {
        const current = this.state(chatId);
        const head = current.native[0] ?? current.mirrored[0];
        this.saveState(chatId, current);
        if (head) {
          this.nextPrompts.set(chatId, {
            text: formatPermissionPrompt(head),
            requestId: head.requestId,
          });
        } else {
          this.nextPrompts.delete(chatId);
        }
        this.retryPromptPending.delete(chatId);
        // A refused decision must be reported as such — the chat must not be
        // told that the request simply expired, and it must never be told
        // that the permission was granted (contract §4).
        return {
          text: decision.reason
            ? `权限请求未通过：${decision.reason}`
            : "权限请求已失效，已跳过，继续处理。",
          canAdvance: false,
          retryPrompt: true,
          answerToken,
        };
      }
      const remaining = this.state(chatId);
      const head = remaining.native[0] ?? remaining.mirrored[0];
      this.saveState(chatId, remaining);
      if (head) {
        this.nextPrompts.set(chatId, {
          text: formatPermissionPrompt(head),
          requestId: head.requestId,
        });
      }
      if (trimmed === "0") return { text: "已拒绝，继续处理。", canAdvance: true, answerToken };
      if (trimmed === "2") return { text: "已允许本会话，继续执行。", canAdvance: true, answerToken };
      return { text: "已允许一次，继续执行。", canAdvance: true, answerToken };
    } catch (error) {
      if ((this.generations.get(chatId) ?? 0) === generation) {
        const current = this.state(chatId);
        if (entry.mirrored) current.mirrored.unshift(entry);
        else current.native.unshift(entry);
        this.saveState(chatId, current);
        this.nextPrompts.delete(chatId);
        this.retryPromptPending.delete(chatId);
        this.answering.delete(chatId);
      }
      throw error;
    } finally {
      if ((this.generations.get(chatId) ?? 0) === generation) {
        this.inFlight.delete(chatId);
        this.generations.delete(chatId);
      } else if (!this.pending.has(chatId) && !this.inFlight.has(chatId) && !this.answering.has(chatId)) {
        this.generations.delete(chatId);
      }
    }
  }

  clear(chatId: string): void {
    this.deferredClears.delete(chatId);
    this.clearNow(chatId);
  }

  private clearNow(chatId: string): void {
    if (this.inFlight.has(chatId)) {
      this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    } else {
      this.generations.delete(chatId);
    }
    this.pending.delete(chatId);
    this.lastPromptRequestId.delete(chatId);
    this.nextPrompts.delete(chatId);
    this.promptDelivering.delete(chatId);
    this.retryPromptPending.delete(chatId);
    this.initialPromptPending.delete(chatId);
    this.inFlight.delete(chatId);
    this.answerTokens.delete(chatId);
    this.answering.delete(chatId);
  }
}

/**
 * Read the pending state of a chat without creating it.
 */
function readState(chatId: string, pending: Map<string, ChatPermissionState>): ChatPermissionState | undefined {
  return pending.get(chatId);
}

/**
 * Take the pending entry a chat reply belongs to.
 *
 * The request id of the prompt that was delivered last wins, so a reply is
 * never applied to a request the user is not looking at. The fallback keeps
 * the legacy FIFO behaviour when no prompt was delivered (yet).
 */
function takePendingEntry(state: ChatPermissionState, requestId?: string): PendingPermission | undefined {
  if (requestId !== undefined) {
    const nativeIndex = state.native.findIndex((entry) => entry.requestId === requestId);
    if (nativeIndex >= 0) return state.native.splice(nativeIndex, 1)[0];
    const mirroredIndex = state.mirrored.findIndex((entry) => entry.requestId === requestId);
    if (mirroredIndex >= 0) return state.mirrored.splice(mirroredIndex, 1)[0];
  }
  return state.native.shift() ?? state.mirrored.shift();
}

function formatPayload(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    text = String(payload);
  }

  const trimmed = text.trim();
  if (trimmed.length <= 800) return trimmed || "(空)";
  return `${trimmed.slice(0, 800)}...`;
}

function formatPermissionPrompt(entry: PendingPermission): string {
  if (entry.mirrored) return resolveMirroredPrompt(entry);
  return [
    `工具 ${entry.toolName} 需要权限才能继续执行。`,
    "",
    "请求内容：",
    formatPayload(entry.payload),
    "",
    "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
  ].join("\n");
}

function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString("zh-CN", { hour12: false });
}

/**
 * A mirrored prompt must always name the tool and the expiry, so the IM user
 * can tell which request they are answering. A caller supplied prompt (the
 * redacted text built by the ApprovalRouter) is preferred, but only when it
 * really carries both facts; otherwise the prompt is rebuilt here.
 */
function resolveMirroredPrompt(entry: PendingPermission): string {
  if (entry.prompt !== undefined && entry.prompt.trim()) {
    const hasTool = entry.prompt.includes(entry.toolName);
    const hasExpiry = entry.expiresAt === undefined || entry.prompt.includes(formatExpiry(entry.expiresAt));
    if (hasTool && hasExpiry) return entry.prompt;
  }
  return [
    `【PilotV 授权请求】${entry.toolName}`,
    `有效期至：${entry.expiresAt === undefined ? "未知" : formatExpiry(entry.expiresAt)}`,
    `请求编号：${entry.requestId}`,
    `会话：${entry.sessionKey}`,
    "",
    "请求内容：",
    formatPayload(entry.payload),
    "",
    "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
  ].join("\n");
}
