# 统一决策与授权中心（IM Approval Center）

> 状态：设计契约 v1（阶段 2 已落盘，实现接线未完成）。本文件是后续实现的唯一依据。

## 1. 目标

把「工具权限审批」与「agent 向用户提问」统一到同一套决策契约：同一请求可在 Web UI 或飞书/企微任一通道被回答，且状态、身份、时效、审计一致。

## 2. 统一契约（`src/approval/types.ts`）

| 字段 | 含义 |
| --- | --- |
| `id` | 决策记录稳定 ID（`ApprovalCenter` 生成，UUID） |
| `kind` | `permission`（工具权限）/ `elicitation`（agent 提问） |
| `sessionKey` / `requestId` | 归属会话与网关内部待决请求 ID |
| `originChannelKey` | 请求发起通道（Web 记为 `web`） |
| `risk` | `low` / `medium` / `high` / `critical`（后端确定性计算） |
| `state` | `pending` / `approved` / `denied` / `expired` / `cancelled` |
| `bindings` | 允许作答的通道 + 会话 + 可选审批人白名单 `approverIds` |
| `expiresAt` | 过期时刻；到期由 `expireDue()` 置为 `expired` 并拒绝挂起回合 |
| `decision` | 最终决定、审批人、来源通道、时间、是否本会话放行 |
| `audit` | 全量审计：`registered`/`routed`/`delivered`/`decided`/`expired`/`cancelled`/`high_risk_blocked` |

## 3. 风险与通道准入（`src/approval/ApprovalPolicy.ts`）

- `classifyApprovalRisk()`：凭据库类（bitwarden/vault/password/token…）= `critical`；shell/MCP/网络 = `high`；直接写文件 = `medium`；其余 `low`。
- `canDecideViaIm()`：**仅 `low`/`medium` 允许在 IM 作答**；`high`/`critical` 必须留在原生授权界面（普通 IM 消息中的「同意」不得视为无限授权）。
- `redactPayload()`：载荷预览脱敏后再进入提示与审计。

## 4. 状态机（`src/approval/ApprovalCenter.ts`）

`register → (routed → delivered) → decided | expired | cancelled`

- 幂等：同一 `sessionKey + requestId`（或显式 `idempotencyKey`）只登记一次；重复决定只生效第一次。
- 持久化：状态与审计落盘；重启后仍 `pending` 的记录作废（回合已不存在）。
- `checkImBinding()`：IM 作答必须命中 `bindings`（通道 + chatId + 可选审批人）。

## 5. 路由（`src/approval/ApprovalRouter.ts`）

- 只镜像，不代替作答：注册到中心 → 生成脱敏提示 → 交给具备 `routeApprovalPrompt()` 的通道适配器。
- 作答仍由通道适配器完成：`ImPermissionHelper` 调用 `gateway.permissionDecide()` 回到同一进程的原回合。
- 绑定来源：`ApprovalBindingConfig`（channelKey / chatId / projectKeys / toolNames / approverIds）。

## 6. 网关接线（`src/gateway/`）

- `InProcessGateway`：新增事件订阅、决定守卫、决定审计三组 sink；`permissionDecide` 先过守卫再消费 pending。
- 协议：`GatewayPermissionDecisionInput` 增加 `actor`、`origin`；WebSocket 入口强制 `origin="web"`，客户端不得自称 IM 来源。
- 桥：`src/gateway/approval/createApprovalBridge.ts`（事件路由 + 守卫 + TTL 清理）。

## 7. 未完成项（下一轮）

1. `InProcessGateway` 回合事件循环接入 `notifyApprovalEventSinks`，`permissionDecide` 接入守卫与审计 sink。
2. 飞书 / 企微适配器实现 `routeApprovalPrompt()`（`FeishuChannel.ts:598`、`WeComChannel.ts:928` 为既有 permission_request 处理点）。
3. IM 作答回传 `actor`/`origin="im"`，使 `approverIds` 绑定生效。
4. 在 `src/cli/createLocalGateway.ts:391` / `src/gateway/Gateway.ts:40` 装配中心、路由器与桥。
5. 聚焦回归测试 + 相关包全量测试；由审查员 Agent 独立复核。

## 8. 验收口径

- 无真实测试输出不得声称通过；IM 路径必须以真实通道往返为准，模拟不得替代。
- 审计必须能回答：谁、何时、从哪个通道、批准了什么、是否过期。
