import type { Gateway, GatewayEvent, GatewayPermissionDecisionResult } from "../protocol/types.js";
import type { PilotDeckElicitationAnswer } from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import { randomUUID } from "node:crypto";
import type { WsHelloFrame, WsRequestFrame } from "../protocol/frames.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import { TextWebSocketConnection } from "./websocket.js";
import { SkillManagerError, SkillValidationError } from "../../extension/skills/index.js";
import { DialogGatewayError } from "../dialog/errors.js";
import { getSessionHealthTracker } from "../health/gatewayHealth.js";
import {
  correlationPrefix,
  currentCorrelation,
  newCorrelationId,
  resolveCorrelationId,
  runWithCorrelation,
} from "../../observability/correlation.js";

export type GatewayWsConnectionOptions = {
  gateway: Gateway;
  token: string;
  serverVersion: string;
  /** 这条 ws 连接自带的关联 id（来自 upgrade 请求头）；没有就自己生成一个。 */
  connectionId?: string;
  /** 可注入的日志出口。默认 console.error；测试据此断言「失败确实留下了痕迹」。 */
  log?: (message: string, error?: unknown) => void;
};

export class GatewayWsConnection {
  private authed = false;
  private readonly inFlightSessions = new Set<string>();
  /**
   * 这条连接的身份。日志里只出现 `ws=<8位>`，不写完整 id：
   * 完整 id 有被当凭据转出去的风险，而 8 位在单台机器的日志量里足够唯一。
   */
  private readonly connectionId: string;
  private closed = false;
  private readonly inFlightRequests = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly ws: TextWebSocketConnection,
    private readonly options: GatewayWsConnectionOptions,
  ) {
    this.connectionId = (this.options.connectionId || newCorrelationId()).slice(0, 8);
    ws.onMessage((message) => void this.handleMessage(message));
    ws.onClose(() => this.abortInFlightTurns());
  }

  private abortInFlightTurns(): void {
    this.closed = true;
    for (const turn of this.inFlightRequests.values()) turn.controller.abort("transport_closed");
    this.inFlightRequests.clear();
  }

  sendNotification(name: string, payload?: unknown): void {
    if (!this.authed) return;
    this.ws.sendText(JSON.stringify({ type: "notification", name, payload }));
  }

  onClose(callback: () => void): void {
    this.ws.onClose(callback);
  }

  private async handleMessage(message: string): Promise<void> {
    if (this.closed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      this.ws.close(4002, "invalid_json");
      return;
    }

    if (!this.authed) {
      await this.handleHello(frame);
      return;
    }

    if (!isRequestFrame(frame)) {
      this.ws.close(4002, "invalid_frame");
      return;
    }
    await this.handleRequest(frame);
  }

  private async handleHello(frame: unknown): Promise<void> {
    if (!isHelloFrame(frame)) {
      this.ws.close(4001, "hello_required");
      return;
    }
    if (frame.protocolVersion !== PILOTDECK_GATEWAY_PROTOCOL_VERSION) {
      this.ws.close(4001, "protocol_mismatch");
      return;
    }
    if (frame.token !== this.options.token) {
      this.ws.close(4003, "auth_failed");
      return;
    }
    this.authed = true;
    this.ws.sendText(
      JSON.stringify({
        type: "hello_ok",
        protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
        serverVersion: this.options.serverVersion,
        serverInfo: await this.options.gateway.describeServer(),
      }),
    );
  }

  /**
   * 一次请求一个关联 id，贯穿 ws -> turn -> 工具调用 -> 健康记账。
   *
   * 客户端可以用 `X-PilotV-Correlation-Id` 自带（便于和网关、成果台对齐），
   * 但只接受安全形状，不接受就自己生成：日志里出现的东西不能是任意输入。
   *
   * id 随响应/事件帧回传，所以「前端看到一次失败」和「服务端那一行日志」
   * 从此能对上 —— 缺陷 B 那两轮误判，缺的就是这个对应关系。
   */
  private openRequestScope(frame: WsRequestFrame): { correlationId: string; sessionKey: string } {
    const params = frame.params as { sessionKey?: string; correlationId?: unknown } | undefined;
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "";
    const correlationId = resolveCorrelationId(params?.correlationId);
    return { correlationId, sessionKey };
  }

  private async handleRequest(frame: WsRequestFrame): Promise<void> {
    const { correlationId, sessionKey } = this.openRequestScope(frame);
    // id 在这里绑定，往下每一层（turn、工具调用、健康记账、日志）
    // 都不用把参数一路透传就能读到同一个 id。
    return runWithCorrelation(
      { correlationId, ...(sessionKey ? { sessionKey } : {}) },
      () => this.serveRequest(frame, { correlationId, sessionKey }),
    );
  }

  private async serveRequest(
    frame: WsRequestFrame,
    scope: { correlationId: string; sessionKey: string },
  ): Promise<void> {
    const { correlationId, sessionKey } = scope;
    try {
      if (frame.method === "submit_turn") {
        const params = frame.params as Parameters<Gateway["submitTurn"]>[0];
        const runId = params?.runId ?? randomUUID();
        // Keep every request's identity: a busy duplicate must not release the
        // original request, and disconnect must never abort a later run.
        if (this.inFlightRequests.has(frame.id)) throw new Error("A stream with this request id is already active.");
        const controller = new AbortController();
        let resolveDone!: () => void;
        const done = new Promise<void>(resolve => { resolveDone = resolve; });
        this.inFlightRequests.set(frame.id, { controller, done });
        const turnSessionKey = sessionKey || undefined;
        if (turnSessionKey) this.inFlightSessions.add(turnSessionKey);
        let seq = 0;
        let lastCompleted: GatewayEvent | undefined;
        try {
          for await (const event of this.options.gateway.submitTurn({ ...params, runId }, { signal: controller.signal })) {
            if (event.type === "turn_completed") {
              lastCompleted = event;
            }
            // 会话级熔断的写入点。tracker 内部保证不抛，所以这里不需要 try，
            // 也就不可能因为观测逻辑把一轮对话打断（那是缺陷 B 的复发形式）。
            if (turnSessionKey) getSessionHealthTracker().observe(event, { sessionKey: turnSessionKey });
            this.ws.sendText(JSON.stringify({ type: "event", id: frame.id, seq: seq++, final: false, correlationId, event }));
          }
        } finally {
          this.inFlightRequests.delete(frame.id);
          resolveDone();
          if (turnSessionKey) this.inFlightSessions.delete(turnSessionKey);
        }
        const usage = lastCompleted?.type === "turn_completed" ? lastCompleted.usage : {};
        const finishReason = lastCompleted?.type === "turn_completed" ? lastCompleted.finishReason : "completed";
        this.ws.sendText(
          JSON.stringify({
            type: "event",
            id: frame.id,
            seq,
            correlationId,
            final: true,
            event: lastCompleted ?? { type: "turn_completed", usage, finishReason },
          }),
        );
        return;
      }

      const result = await this.dispatchRequest(frame);
      this.ws.sendText(JSON.stringify({ type: "response", id: frame.id, correlationId, ok: true, result }));
    } catch (error) {
      // 故障归属到会话，而不是只回一个错误帧就走。之前所有失败都只变成
      // 「一条红色响应」，进程之外没人知道是哪条会话在反复出问题。
      this.recordRequestFailure(frame, error);
      // SkillManagerError carries a structured `code` we want to round-
      // trip to the client (so the UI can surface "conflict", "not_found",
      // "invalid_slug", etc. as actionable messages instead of a generic
      // 500). SkillValidationError additionally carries the structured
      // validation payload that powers the compliance panel.
      if (error instanceof SkillValidationError) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              validation: error.validation,
            },
          }),
        );
        return;
      }
      if (error instanceof SkillManagerError) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        );
        return;
      }
      if (error instanceof DialogGatewayError || hasStructuredErrorCode(error)) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error instanceof Error ? error.message : String(error),
              ...("details" in error && error.details !== undefined ? { details: error.details } : {}),
            },
          }),
        );
        return;
      }
      this.ws.sendText(
        JSON.stringify({
          type: "response",
          id: frame.id,
          correlationId,
          ok: false,
          error: {
            code: "gateway_request_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }

  /**
   * 日志出口自己坏了不能把请求带下去。
   *
   * 它站在 catch 块里：日志器一抛，原始错误就永远发不出去，前端只看到超时，
   * 而那条我们最想留下的错误反而消失了 —— 这正是 docs/DEGRADATION.md 第 4 节
   * 禁止的「观测代码具备杀伤力」。回落时把原始错误和日志器的错误都带上，
   * 宁可日志吵一点，也不能少掉任何一层的现场。
   */
  private safeLog(message: string, error?: unknown): void {
    try {
      (this.options.log ?? ((text: string, cause?: unknown) =>
        (cause === undefined ? console.error(text) : console.error(text, cause))))(message, error);
    } catch (loggingError) {
      console.error(`${message}（日志出口自身抛错，已回落 console.error）`, { error, loggingError });
    }
  }

  /**
   * 把一次请求失败记到对应会话的健康账上。
   *
   * sessionKey 的来源不止 params.sessionKey：resume/close/read 等一组方法用的是
   * 别的入参名。这里只认 submit_turn 那一族的字段，其余留空就不记账 ——
   * 宁可不记，也不要把失败算到随便猜出来的会话头上。
   */
  private recordRequestFailure(frame: WsRequestFrame, error: unknown): void {
    const params = frame.params as { sessionKey?: string } | undefined;
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "";
    // 先留日志再记账：telemetry 会把错误压成一个 code，堆栈只在这里还完整。
    // 缺陷 B 前两轮误判成「无异常优雅退出」，就是因为只剩 [telemetry] 那行。
    this.safeLog(
      `${correlationPrefix({ ...(currentCorrelation() || {}), ...(sessionKey ? { sessionKey } : {}) })}` +
        `ws=${this.connectionId} method=${frame.method} 请求失败`,
      error,
    );
    if (!sessionKey) return;
    const recoverable = frame.method !== "submit_turn";
    getSessionHealthTracker().observe(
      {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: hasStructuredErrorCode(error) ? error.code : "gateway_request_failed",
        recoverable,
      },
      { sessionKey },
    );
  }

  private dispatchRequest(frame: WsRequestFrame): Promise<unknown> {
    switch (frame.method) {
      case "steer_turn":
        return this.options.gateway.steerTurn(frame.params as never);
      case "cancel_steer":
        return this.options.gateway.cancelSteer(frame.params as never);
      case "abort_turn":
        if (typeof (frame.params as { requestId?: unknown })?.requestId === "string") {
          const turn = this.inFlightRequests.get((frame.params as { requestId: string }).requestId);
          turn?.controller.abort("consumer_closed");
          return (turn?.done ?? Promise.resolve()).then(() => ({ ok: true }));
        }
        return this.options.gateway.abortTurn(frame.params as never).then(() => ({ ok: true }));
      case "list_sessions":
        return this.options.gateway.listSessions(frame.params as never);
      case "resume_session":
        return this.options.gateway.resumeSession(frame.params as never);
      case "new_session":
        return this.options.gateway.newSession(frame.params as never);
      case "close_project_sessions":
        if (!this.options.gateway.closeProjectSessions) throw new Error("Project session closure is unavailable.");
        return this.options.gateway.closeProjectSessions(frame.params as never);
      case "close_session":
        return this.options.gateway.closeSession(frame.params as never).then(() => ({ ok: true }));
      case "record_agent_status_message":
        if (this.options.gateway.recordAgentStatusMessage) {
          return this.options.gateway.recordAgentStatusMessage(frame.params as never);
        }
        return Promise.resolve({ recorded: false });
      case "describe_server":
        return this.options.gateway.describeServer();
      case "project_files_list":
        return this.requireCapability("project_files_list", "projectFilesList", frame.params);
      case "commands_list":
        return this.requireCapability("commands_list", "commandsList", frame.params);
      case "model_catalog_list":
        return this.requireCapability("model_catalog_list", "modelCatalogList", frame.params);
      case "session_model_get":
        return this.requireCapability("session_model_get", "sessionModelGet", frame.params);
      case "session_model_set":
        return this.requireCapability("session_model_set", "sessionModelSet", frame.params);
      case "session_model_clear":
        return this.requireCapability("session_model_clear", "sessionModelClear", frame.params);
      case "active_turn_snapshot":
        if (this.options.gateway.getActiveTurnSnapshot) {
          return this.options.gateway.getActiveTurnSnapshot(frame.params as never);
        }
        return Promise.resolve({
          active: false,
          sessionKey: (frame.params as { sessionKey?: string } | undefined)?.sessionKey ?? "",
          events: [],
        });
      case "cron_create":
        return this.options.gateway.cronCreate(frame.params as never);
      case "cron_list":
        return this.options.gateway.cronList(frame.params as never);
      case "cron_update":
        return this.options.gateway.cronUpdate(frame.params as never);
      case "cron_delete":
        return this.options.gateway.cronDelete(frame.params as never);
      case "cron_stop":
        return this.options.gateway.cronStop(frame.params as never);
      case "cron_run_now":
        return this.options.gateway.cronRunNow(frame.params as never);
      case "elicitation_respond":
        return this.options.gateway.respondElicitation(normalizeWebElicitationResponseParams(frame.params));
      case "permission_decide":
        return this.decidePermission(frame.params);
      case "grant_session_permission":
        return this.options.gateway.grantSessionPermission(frame.params as never);
      case "read_session_messages":
        return this.options.gateway.readSessionMessages(frame.params as never);
      case "read_subagent_messages":
        return this.options.gateway.readSubagentMessages(frame.params as never);
      case "fork_session":
        return this.options.gateway.forkSession(frame.params as never);
      case "manage_checkpoints":
        if (!this.options.gateway.manageCheckpoints) throw new Error("File checkpoints are unavailable on this Gateway.");
        return this.options.gateway.manageCheckpoints(frame.params as never);
      case "replace_last_turn":
        return this.options.gateway.replaceLastTurn(frame.params as never);
      case "finalize_last_turn_replacement":
        return this.options.gateway.finalizeLastTurnReplacement(frame.params as never);
      case "list_projects":
        return this.options.gateway.listProjects();
      case "describe_project":
        return this.options.gateway.describeProject(frame.params as never);
      case "reload_config":
        if (this.options.gateway.reloadConfig) {
          return this.options.gateway.reloadConfig();
        }
        return Promise.resolve({ reloaded: false, reason: "unsupported" });
      case 'python_runtime_status':
        return this.options.gateway.getPythonRuntimeStatus?.()
          ?? Promise.resolve({ enabled: true, state: 'unavailable', reason: 'not-installed' });
      case "prepare_weixin_login":
        if (this.options.gateway.prepareWeixinLogin) {
          return this.options.gateway.prepareWeixinLogin();
        }
        return Promise.resolve({
          requested: false,
          requestedAt: new Date().toISOString(),
          reason: "unsupported",
        });
      case "reload_extensions":
        if (this.options.gateway.reloadExtensions) {
          return this.options.gateway.reloadExtensions(frame.params as never);
        }
        return Promise.resolve({ reloaded: false, reason: "unsupported" });
      case "skill_list":
        return requireSkillMethod(this.options.gateway.skillsList, this.options.gateway)(frame.params as never);
      case "skill_read":
        return requireSkillMethod(this.options.gateway.skillRead, this.options.gateway)(frame.params as never);
      case "skill_write":
        return requireSkillMethod(this.options.gateway.skillWrite, this.options.gateway)(frame.params as never);
      case "skill_create":
        return requireSkillMethod(this.options.gateway.skillCreate, this.options.gateway)(frame.params as never);
      case "skill_set_enabled":
        return requireSkillMethod(this.options.gateway.skillSetEnabled, this.options.gateway)(frame.params as never);
      case "skill_delete":
        return requireSkillMethod(this.options.gateway.skillDelete, this.options.gateway)(frame.params as never);
      case "skill_import":
        return requireSkillMethod(this.options.gateway.skillImport, this.options.gateway)(frame.params as never);
      case "skill_validate":
        return requireSkillMethod(this.options.gateway.skillValidate, this.options.gateway)(frame.params as never);
      case "skill_scan":
        return requireSkillMethod(this.options.gateway.skillScan, this.options.gateway)(frame.params as never);
      case "always_on_apply":
        if (this.options.gateway.alwaysOnApply) {
          return this.options.gateway.alwaysOnApply(frame.params as never);
        }
        return Promise.resolve({ sessionKey: "", error: { code: "not_configured", message: "Always-On apply not available" } });
      case "always_on_rerun_plan":
        if (this.options.gateway.alwaysOnRerunPlan) {
          return this.options.gateway.alwaysOnRerunPlan(frame.params as never);
        }
        return Promise.resolve({ runId: "", error: { code: "not_configured", message: "Always-On rerun not available" } });
      default:
        throw new Error(`Unknown gateway method ${(frame as { method?: string }).method}.`);
    }
  }

  /**
   * Apply a `permission_decide` request coming from a Web client.
   *
   * A malformed payload must not fail silently: the client gets the same
   * response shape as any other decision, with `delivered: false` and a
   * readable `reason` code (contract §4 / §6).
   */
  private async decidePermission(params: unknown): Promise<GatewayPermissionDecisionResult> {
    let normalized: ReturnType<typeof normalizeWebPermissionDecisionParams>;
    try {
      normalized = normalizeWebPermissionDecisionParams(params);
    } catch (error) {
      return { delivered: false, reason: permissionDecisionValidationReason(error) };
    }
    return this.options.gateway.permissionDecide(normalized);
  }

  private requireCapability(
    capability: string,
    method: "projectFilesList" | "commandsList" | "modelCatalogList" | "sessionModelGet" | "sessionModelSet" | "sessionModelClear",
    params: unknown,
  ): Promise<unknown> {
    const handler = this.options.gateway[method] as ((input: never) => Promise<unknown>) | undefined;
    if (!handler) {
      return Promise.reject(Object.assign(new Error(`Gateway capability ${capability} is unavailable.`), {
        code: "CAPABILITY_UNAVAILABLE",
      }));
    }
    return handler.call(this.options.gateway, params as never);
  }
}

function hasStructuredErrorCode(error: unknown): error is Error & { code: string; details?: unknown } {
  return error instanceof Error
    && typeof (error as Error & { code?: unknown }).code === "string";
}

/**
 * Guard for optional Skill RPC methods on the Gateway. The Gateway
 * interface marks every `skill*` method as optional so older
 * RemoteGateway-backed servers don't break the type contract. When a
 * client invokes a method this server's gateway doesn't implement, we
 * fail with a structured `not_configured` error instead of crashing
 * the dispatcher.
 */
function requireSkillMethod<TArg, TRet>(
  method: ((arg: TArg) => Promise<TRet>) | undefined,
  gateway: Gateway,
): (arg: TArg) => Promise<TRet> {
  if (!method) {
    throw new SkillManagerError(
      "not_configured",
      "Skill management is not enabled on this gateway.",
    );
  }
  return method.bind(gateway);
}

function isHelloFrame(value: unknown): value is WsHelloFrame {
  return (
    isRecord(value) &&
    value.type === "hello" &&
    typeof value.protocolVersion === "string" &&
    typeof value.clientName === "string" &&
    typeof value.clientVersion === "string" &&
    typeof value.token === "string"
  );
}

function isRequestFrame(value: unknown): value is WsRequestFrame {
  return (
    isRecord(value) &&
    value.type === "request" &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

/**
 * Reason codes returned to the Web client when a `permission_decide` request
 * cannot be normalised (contract §6 input validation).
 *
 * The codes are stable so the UI can tell "you sent something wrong" from
 * "the request is gone" without parsing prose.
 */
export const WEB_PERMISSION_DECISION_REASONS = {
  invalidParams: "invalid_permission_decision_params",
  invalidSessionKey: "invalid_permission_decision_session_key",
  invalidRequestId: "invalid_permission_decision_request_id",
  invalidDecision: "invalid_permission_decision",
} as const;

/** Error raised while validating a `permission_decide` payload. */
export class WebPermissionDecisionValidationError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "WebPermissionDecisionValidationError";
    this.reason = reason;
  }
}

function permissionDecisionValidationReason(error: unknown): string {
  if (error instanceof WebPermissionDecisionValidationError) return error.reason;
  return WEB_PERMISSION_DECISION_REASONS.invalidParams;
}

/**
 * Normalize a `permission_decide` payload.
 *
 * The websocket entry point authenticates a token, not a user: the actor is
 * whatever the client claims (`client_reported`), and `origin` is pinned to
 * `web` so a browser can never claim an IM identity (contract §6).
 *
 * Every field is validated for real — a missing `sessionKey` / `requestId` or
 * an unknown decision is rejected with a readable reason code instead of
 * silently resolving to `delivered: false`.
 */
export function normalizeWebPermissionDecisionParams(params: unknown): {
  sessionKey: string;
  requestId: string;
  decision: "allow" | "deny";
  remember?: boolean;
  reason?: string;
  actor?: string;
  actorSource: "client_reported";
  origin: "web";
} {
  if (!isRecord(params)) {
    throw new WebPermissionDecisionValidationError(
      WEB_PERMISSION_DECISION_REASONS.invalidParams,
      "Invalid permission_decide params.",
    );
  }
  const sessionKey = params.sessionKey;
  if (typeof sessionKey !== "string" || sessionKey.trim().length === 0) {
    throw new WebPermissionDecisionValidationError(
      WEB_PERMISSION_DECISION_REASONS.invalidSessionKey,
      "Invalid permission_decide params: sessionKey must be a non-empty string.",
    );
  }
  const requestId = params.requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    throw new WebPermissionDecisionValidationError(
      WEB_PERMISSION_DECISION_REASONS.invalidRequestId,
      "Invalid permission_decide params: requestId must be a non-empty string.",
    );
  }
  const decision = params.decision;
  if (decision !== "allow" && decision !== "deny") {
    throw new WebPermissionDecisionValidationError(
      WEB_PERMISSION_DECISION_REASONS.invalidDecision,
      "Invalid permission decision; expected allow or deny.",
    );
  }
  const actor = typeof params.actor === "string" ? params.actor.trim() : "";
  return {
    sessionKey,
    requestId,
    decision,
    ...(typeof params.remember === "boolean" ? { remember: params.remember } : {}),
    ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
    ...(actor && actor.length <= 128 ? { actor } : {}),
    // The websocket entry point authenticates a token, not a user: the actor
    // is whatever the client claims (contract §8).
    actorSource: "client_reported",
    origin: "web",
  };
}

/**
 * Normalize an `elicitation_respond` payload.
 *
 * The websocket entry point has no user identity and must not be able to
 * impersonate a chat channel, so `origin` is pinned to `web` and no channel
 * or chat binding is taken from the client.
 */
function normalizeWebElicitationResponseParams(params: unknown): {
  sessionKey: string;
  requestId: string;
  answer: PilotDeckElicitationAnswer;
  actor?: string;
  actorSource: "client_reported";
  origin: "web";
} {
  if (!isRecord(params)) throw new Error("Invalid elicitation response params.");
  const sessionKey = params.sessionKey;
  const requestId = params.requestId;
  if (typeof sessionKey !== "string" || typeof requestId !== "string") {
    throw new Error("Invalid elicitation response params.");
  }
  const answer = params.answer;
  if (!isRecord(answer) || typeof answer.type !== "string") {
    throw new Error("Invalid elicitation answer.");
  }
  const actor = typeof params.actor === "string" ? params.actor.trim() : "";
  return {
    sessionKey,
    requestId,
    answer: answer as PilotDeckElicitationAnswer,
    ...(actor && actor.length <= 128 ? { actor } : {}),
    actorSource: "client_reported",
    origin: "web",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
