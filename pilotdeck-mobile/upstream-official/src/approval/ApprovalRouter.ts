/**
 * Router that mirrors a pending decision to a chat channel.
 *
 * The router never answers a decision itself — it only
 *  1. registers the pending request in the {@link ApprovalCenter},
 *  2. formats a redacted prompt, and
 *  3. hands the prompt to a channel adapter that can deliver it.
 *
 * The reply path stays inside the channel adapters: they already own the
 * `ImPermissionHelper` / `ImElicitationHelper` state and call
 * `gateway.permissionDecide(...)` (or `gateway.respondElicitation(...)`),
 * which resolves the original turn in the same process.
 */

import {
  canDecideViaIm,
  classifyApprovalRisk,
  redactPayload,
} from "./ApprovalPolicy.js";
import type { ApprovalCenter } from "./ApprovalCenter.js";
import type {
  ApprovalBinding,
  ApprovalDecisionSource,
  ApprovalRecord,
  ApprovalRisk,
} from "./types.js";

export type ApprovalQuestion = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
};

export type ApprovalPromptRoute = {
  kind: "permission" | "elicitation";
  chatId: string;
  interactionKey?: string;
  chatType?: "dm" | "group";
  sessionKey: string;
  requestId: string;
  toolName: string;
  prompt: string;
  risk: ApprovalRisk;
  expiresAt: number;
  /** Elicitation only — the questions the agent asked. */
  questions?: ApprovalQuestion[];
};

/** Minimal channel surface required to deliver an approval prompt. */
export type ApprovalCapableChannel = {
  channelKey: string;
  routeApprovalPrompt?(route: ApprovalPromptRoute): Promise<boolean>;
};

/** Gateway surface used by the router. */
export type ApprovalGateway = {
  permissionDecide(input: {
    sessionKey: string;
    requestId: string;
    decision: "allow" | "deny";
    remember?: boolean;
    reason?: string;
    actor?: string;
    origin?: ApprovalDecisionSource;
  }): Promise<{ delivered: boolean }>;
  respondElicitation?(input: {
    sessionKey: string;
    requestId: string;
    answer: unknown;
    actor?: string;
    origin?: ApprovalDecisionSource;
  }): Promise<{ delivered: boolean }>;
};

/** Static routing configuration (project / pilot home config file). */
export type ApprovalBindingConfig = {
  channelKey: string;
  /** Optional (contract §5): without it the binding accepts any chat. */
  chatId?: string;
  interactionKey?: string;
  chatType?: "dm" | "group";
  approverIds?: string[];
  /** Only mirror requests raised inside these projects. */
  projectKeys?: string[];
  /** Only mirror these tools (empty / missing = all). */
  toolNames?: string[];
};

export type ApprovalRouterOptions = {
  center: ApprovalCenter;
  gateway: ApprovalGateway;
  resolveChannel: (channelKey: string) => ApprovalCapableChannel | undefined;
  bindingConfigs: () => ApprovalBindingConfig[];
  now?: () => number;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

export class ApprovalRouter {
  private readonly center: ApprovalCenter;
  private readonly gateway: ApprovalGateway;
  private readonly resolveChannel: (channelKey: string) => ApprovalCapableChannel | undefined;
  private readonly bindingConfigs: () => ApprovalBindingConfig[];
  private readonly now: () => number;
  private readonly logger: NonNullable<ApprovalRouterOptions["logger"]>;

  constructor(options: ApprovalRouterOptions) {
    this.center = options.center;
    this.gateway = options.gateway;
    this.resolveChannel = options.resolveChannel;
    this.bindingConfigs = options.bindingConfigs;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? {};
  }

  /**
   * Handle a gateway event.
   *
   * Every permission and elicitation request is registered in the center —
   * including the requests a chat channel raises itself. The center is the
   * single source of truth for state, expiry and audit, and the decision
   * guard needs a record to authorize an IM answer against.
   *
   * Only requests that were *not* raised by a chat channel are mirrored: a
   * channel that owns the turn already answers its own requests, and
   * mirroring them would forward a request into the channel it came from.
   */
  async handleEvent(input: {
    sessionKey: string;
    channelKey: string;
    projectKey?: string;
    event: { type: string; [key: string]: unknown };
  }): Promise<ApprovalRecord | undefined> {
    const event = input.event;
    if (event.type !== "permission_request" && event.type !== "elicitation_request") {
      return undefined;
    }

    const kind = event.type === "permission_request" ? "permission" : "elicitation";
    const toolName =
      event.type === "permission_request"
        ? String((event.toolName as string) ?? "unknown")
        : "ask_user_question";
    const payload =
      event.type === "permission_request" ? event.payload : event.questions;
    const questions =
      kind === "elicitation" ? normalizeQuestions(event.questions) : undefined;

    const risk = classifyApprovalRisk({ kind, toolName, payload });
    const preview = redactPayload(payload);
    const requestId = String(event.requestId ?? "");

    let record: ApprovalRecord;
    try {
      record = await this.center.register({
        kind,
        sessionKey: input.sessionKey,
        requestId,
        toolName,
        ...(input.projectKey ? { projectKey: input.projectKey } : {}),
        originChannelKey: input.channelKey,
        risk,
        summary:
          kind === "permission" ? `工具授权：${toolName}` : `业务确认：${toolName}`,
        payloadPreview: preview.preview,
        payloadRedacted: preview.redacted,
        bindings: this.selectBindings(input.projectKey, toolName),
        idempotencyKey: `${kind}:${input.sessionKey}:${requestId}`,
      });
    } catch (error) {
      // A registration failure must never break the native flow of the turn.
      this.logger.error?.(
        `[approval] failed to register ${kind} request: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }

    // The channel that raised the request answers it in its own prompt.
    if (this.resolveChannel(input.channelKey)) return record;

    if (!canDecideViaIm(risk)) {
      await this.center.auditEvent({
        approvalId: record.id,
        action: "high_risk_blocked",
        detail: `${toolName} 保持原生授权`,
      });
      return record;
    }

    await this.route(record, questions);
    return record;
  }

  /** Deliver the prompt to every bound channel. */
  async route(record: ApprovalRecord, questions?: ApprovalQuestion[]): Promise<boolean> {
    if (record.bindings.length === 0) return false;
    await this.center.auditEvent({
      approvalId: record.id,
      action: "routed",
      detail: `targets=${record.bindings.length}`,
    });
    let delivered = false;
    for (const binding of record.bindings) {
      const channel = this.resolveChannel(binding.channelKey);
      if (!channel?.routeApprovalPrompt) continue;
      // A binding without a chat cannot be delivered to — it only says which
      // channel is allowed to answer.
      if (!binding.chatId) continue;
      try {
        const ok = await channel.routeApprovalPrompt({
          kind: record.kind,
          chatId: binding.chatId,
          interactionKey: binding.interactionKey,
          chatType: binding.chatType,
          sessionKey: record.sessionKey,
          requestId: record.requestId,
          toolName: record.toolName,
          prompt: this.formatPrompt(record),
          risk: record.risk,
          expiresAt: record.expiresAt,
          ...(questions && questions.length > 0 ? { questions } : {}),
        });
        await this.center.recordDelivery(record.id, {
          channelKey: binding.channelKey,
          chatId: binding.chatId,
          ok,
          ...(ok ? {} : { error: "channel_rejected_prompt" }),
        });
        if (ok) delivered = true;
      } catch (error) {
        await this.center.recordDelivery(record.id, {
          channelKey: binding.channelKey,
          chatId: binding.chatId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.warn?.(
          `[approval] delivery to ${binding.channelKey} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return delivered;
  }

  /** Prompt text sent to the chat channel. Never contains secrets. */
  formatPrompt(record: ApprovalRecord): string {
    const expiresAt = new Date(record.expiresAt).toLocaleString("zh-CN", {
      hour12: false,
    });
    if (record.kind === "elicitation") {
      // An elicitation is a question, not an authorization. It must never use
      // the permission wording ("1 = allow once"), otherwise the reply would
      // be read as a permission decision.
      return [
        `【PilotDeck 业务确认】${record.toolName}`,
        `请求编号：${record.requestId}`,
        `会话：${record.sessionKey}`,
        `有效期至：${expiresAt}`,
        "",
        "请求内容：",
        record.payloadPreview,
        "",
        "请直接回复你的答案，或回复 0 取消。",
      ].join("\n");
    }
    const riskLabel = record.risk === "high" ? "高" : record.risk === "medium" ? "中" : "低";
    return [
      `【PilotDeck 授权请求】${record.toolName}`,
      `风险等级：${riskLabel}`,
      `请求编号：${record.requestId}`,
      `会话：${record.sessionKey}`,
      `有效期至：${expiresAt}`,
      "",
      "请求内容：",
      record.payloadPreview,
      "",
      "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
    ].join("\n");
  }

  private selectBindings(projectKey?: string, toolName?: string): ApprovalBinding[] {
    const configs = this.bindingConfigs();
    const bindings: ApprovalBinding[] = [];
    for (const config of configs) {
      if (!config.channelKey) continue;
      if (config.projectKeys && config.projectKeys.length > 0) {
        if (!projectKey || !config.projectKeys.includes(projectKey)) continue;
      }
      if (config.toolNames && config.toolNames.length > 0) {
        if (!toolName || !config.toolNames.includes(toolName)) continue;
      }
      bindings.push({
        channelKey: config.channelKey,
        ...(config.chatId ? { chatId: config.chatId } : {}),
        ...(config.interactionKey ? { interactionKey: config.interactionKey } : {}),
        ...(config.chatType ? { chatType: config.chatType } : {}),
        ...(config.approverIds ? { approverIds: config.approverIds } : {}),
      });
    }
    return bindings;
  }
}

function normalizeQuestions(raw: unknown): ApprovalQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: ApprovalQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<ApprovalQuestion>;
    if (typeof candidate.question !== "string") continue;
    const options = Array.isArray(candidate.options)
      ? candidate.options
          .filter((option): option is { label: string; description: string } =>
            Boolean(option) && typeof (option as { label?: unknown }).label === "string",
          )
          .map((option) => ({
            label: option.label,
            description: typeof option.description === "string" ? option.description : "",
          }))
      : [];
    questions.push({
      question: candidate.question,
      header: typeof candidate.header === "string" ? candidate.header : "",
      options,
      ...(candidate.multiSelect ? { multiSelect: true } : {}),
    });
  }
  return questions;
}
