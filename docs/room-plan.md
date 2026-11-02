# PilotV 项目室（原生多 agent 聊天室）实施方案

状态：2026-11-01 已部署 NAS 的 PilotV 原生 UI（侧栏项目室、`/rooms`），未提交 Git。下文较早阶段的本机地址和未运行 LLM 的说明仅为历史记录，以本节 NAS 验收记录为准。

正式入口：**http://nas.tail2b98e5.ts.net:5186/rooms**（Tailscale 内访问，5186 是 HTTP，不支持 HTTPS）。备用：`http://100.90.196.104:5186/rooms`。两者页面及房间 API 已从另一台 tailnet 设备实测 200。不要使用旧 `/artifacts/rooms` 独立页作为原生 UI 交付。

真实 NAS 验收：已创建两个独立测试会话，worker 接收 @ 指令、回写结果并 @reviewer；reviewer 独立读取转录并回写 REVIEW_PASS，两条投递均 completed。证据房间 `room_a0f33d4163ba`，结构化记录 `deliverables/room-review-evidence.json`。测试会话验收后已关闭，房间保留，不可作为持续在线成员使用。

验证：NAS UI 7 文件 79 测试通过且构建成功；本地房间 106/106、恢复回归 4 测试及 gateway Node 测试通过。浏览器打开原生入口无 JS 错误，但全新浏览器停在登录页；未绕过认证，登录后侧栏/交互视觉验收仍需已登录用户确认。

运行服务：`pilotdeck.service`（18789 agent gateway）、`pilotv-gateway.service`（5186）、`pilotv-artifacts.service`（8799 loopback）、`artifacts-mcp.service`（8801 loopback，Marc:Users）。房间固定走 NAS 本地 8799，普通成果仍保留原目标。MCP 插件 URL `http://127.0.0.1:8801/api/artifacts-mcp`，7 工具验证通过。

恢复行为：初次 gateway 不可用或掉线会后台重连；离线期间的新投递记失败，不重放历史消息。需要恢复工作时显式发送新的 @ 指令。未知快照、缺 runId、sessionKey 不匹配均 fail closed。默认预算 20 次为房间终身持久预算，重启和换任务不会重置；新建房间才能获得新预算。不是 exactly-once 保证。

一致性备份：`/vol3/1000/Work/00/PilotV-backups/rooms-sqlite-20261101T001603/artifacts.db`，SQLite online backup API 已合并 WAL 可见数据，integrity_check=ok，权限 600；包含 7 房间、9 成员、32 消息、26 投递。凭据文件亦为 Marc/600。恢复时先停止 pilotv-artifacts 与 MCP，备份当前数据，移开旧 DB/WAL/SHM，再将此独立备份恢复为 `.artifacts-data/artifacts.db` 并保留 Marc 所有权后重启。不要将旧 WAL 叠加到备份库。

未修改 NAS 既有 8444 tailscale serve（仍指向其他主机）；本功能使用上面的 5186 地址。

## 1. 背景

需要一个长程 PilotDeck 项目把过程和结果发进一个共享房间，另一些 agent 在房间里评审、给建议、下达下一步指令，全程明文可读，人在 PilotV 网页里观看。

评估结论：**不安装 OpenMausBot**。原因见 §3。

## 2. 目标

- 房间转录 = 一条按时间追加的明文日志，每条消息带署名、角色、时间、来源
- 房间成员 = 有独立身份的 agent，实现为 PilotDeck 会话（一个 `sessionKey` 一个 agent）
- 成员互相可寻址（@显示名）
- 评审结论能驱动 worker 继续下一步，不需人转述
- 人能在网页里实时看到全部往来（复用成果台已有的 SSE 与鉴权）

「明文」定义：可审计的进度、结果、依据、评审、指令。**不是**模型私有思维链。

## 3. 为什么不装 OpenMausBot

已核对 PilotDeck 上游与 PilotV 成果台现状：

| 需求 | PilotV 现状 |
| --- | --- |
| 会话即 agent 身份 | 已有。`submit_turn{sessionKey,channelKey,message}`，每个 sessionKey 有独立 transcript |
| 指令插入运行中的 agent | 已有。`steer_turn{sessionKey,runId,itemId,message}`，返回 `{accepted,reason}` |
| 读 agent 产出 | 已有。`read_session_messages`、`read_subagent_messages` |
| 过程明文 | 已有。`record_agent_status_message` |
| 换模型做异构评审 | 已有。`modelOverride` / `session_model_set` |
| 人在环刹车 | 已有。`abort_turn`、`permission_decide`、`elicitation_respond`、`cron_*` |
| 持久化 + 审计底座 | 已有。SQLite/WAL、`audit` 表、`EventBus` + SSE |
| **共享多方明文房间** | 缺。CanonicalMessage 无一等发言人身份；subagent 是旁链，不是同室成员 |
| **房间路由（谁该回）** | 缺。无此机制；telegram adapter 活跃期直接丢输入且丢发言人身份 |
| **房间事件可回放** | 缺。`EventBus` 是内存环形缓冲，重启即失 |
| **评审结论自动回灌** | 缺。`pending-inputs` 是交接不是送达 |

结论：要补的是这些之上的一层薄编排，**不是替代品**。装 OMB 会引入第二套 agent 运行时（容器内 claude/codex + 各自凭据 + 各自账单）、Node 24 依赖、镜像漂移、第二套数据库与攻击面；而 OMB 的 bot 想碰到 PilotV 的成果、终端、技能，仍然要再写一层桥——工作量与原生实现相当。

OMB 真正占优的场景只有三个：人必须在 Telegram/WhatsApp 群里聊；评审必须是外部厂商运行时且要跨天记忆；要一整套群聊产品（定时 routine、审批卡、群组升级）。本项目按用户确认走「人在 PilotV 网页里看」+「评审用 PilotDeck 同源会话」，三条都不成立。

## 4. 架构

```
┌─────────────── PilotV 项目室 ───────────────┐
│ room_messages（append-only, SQLite）         │
│  · worker 会话的进度/结果                     │
│  · reviewer 会话的评审与下一步指令             │
│  · 人的消息（同一套接口、同一套鉴权）          │
└───────────────┬───────────────────────────────┘
      post_room_message │
                       ▼  EventBus → SSE → 编排器
              编排器解析 @成员 → steer_turn / submit_turn
                       ▼
              成员会话（独立 transcript）
                       │ agent 用 post_room_message 回话
                       ▼
                  room_messages（署名成员）
```

**核心映射：房间成员 = PilotDeck 会话。** 这样复用会话的全部既有能力，房间层只负责「明文转录 + 寻址 + 投递」。

## 5. 数据模型

```jsonc
// rooms
{ "id": "room_xxx", "name": "PilotV · 项目室",
  "respond_policy": "mentions",   // everyone | mentions | member | off（off=急停）
  "bulletin": "…",                // borrowed: 频道公告板 = 角色契约
  "task_id": null, "created_at": "…" }

// room_members
{ "member_id": "m_xxx", "room_id": "room_xxx",
  "display_name": "评审官",        // 唯一，@寻址用
  "role": "worker|reviewer|human",
  "session_key": "…", "model": null }   // worker/reviewer 必须有，且房间内不重复

// room_messages
{ "seq": 42, "at": "2026-10-31T…", "room_id": "room_xxx", "task_id": null,
  "role": "user|bot", "author": "评审官", "member_id": "m_xxx",
  "text": "…", "kind": "text|activity|status",
  "source": "agent|human|api",    // 来源盖章
  "reply_to": 41, "mentions": ["worker"],
  "idempotency_key": "…",         // 唯一索引，防重发
  "state": "queued|visible" }     // 工作中压后上屏

// room_deliveries —— 投递记账（不是 agent 的执行回执）
{ "room_id": "room_xxx", "msg_seq": 42, "member_id": "m_xxx",
  "state": "submitted|accepted|completed|rejected|failed|skipped",
  "item_id": "room-…", "reason": "…", "created_at": "…" }
```

字段刻意对齐 OpenMausBot 的频道/消息模型（`memberIds` / `bulletin` / `defaultResponder` / `from` / `replyToId` / `send_id` / `task_id`），便于日后任意 MCP 客户端零改造接入。

`state` 的含义要说清楚：它描述的是**投递动作本身**，不是「agent 照做了」。
`accepted` 只代表 steer 已入队；agent 是否照做，以它自己用 MCP 回写的房间消息为准。

## 6. REST 契约

所有接口挂在 artifacts 服务（8799）下，走既有 `_guard()` 鉴权。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/artifacts/rooms` | 建房间 `{name, respond_policy?, bulletin?, task_id?}` → `{room, members}` |
| GET | `/api/artifacts/rooms` | 列房间 → `{rooms}` |
| GET | `/api/artifacts/rooms/{rid}` | 房间详情 → `{room, members, recent_messages, bounds, deliveries}` |
| PATCH | `/api/artifacts/rooms/{rid}` | 改房间 `{name?, respond_policy?, bulletin?, task_id?}` → `{room}`；`respond_policy=off` 是自动投递急停 |
| POST | `/api/artifacts/rooms/{rid}/members` | 加成员 `{display_name, role, session_key, model?}` → `{member}` |
| PATCH | `/api/artifacts/rooms/{rid}/members/{mid}` | 改成员（换会话/角色/显示名） → `{member}` |
| DELETE | `/api/artifacts/rooms/{rid}/members/{mid}` | 移除成员 → `{ok}`（已发消息留在转录里，不追溯） |
| POST | `/api/artifacts/rooms/{rid}/messages` | 发消息 → `{message, created}`；`idempotency_key` 重复不重复写、不重复发事件 |
| GET | `/api/artifacts/rooms/{rid}/messages` | 读转录 `?after_seq=&before_seq=&limit=&wait=&timeout=` → `{messages, next_seq, latest_seq, bounds, has_more, woke}` |
| GET | `/api/artifacts/rooms/{rid}/deliveries` | 投递状态 → `{deliveries}`（谁收到了、卡在哪一步、为什么） |
| GET | `/api/artifacts/rooms/{rid}/events` | SSE，事件 `room.message` / `room.delivery`（只推本房间） |

**游标语义**：`next_seq` 是**下一页该用的 `after_seq`**（= 本页最后一条的 seq）；
房间里的最大 seq 单独给 `latest_seq`。两者混成一个字段时，翻页会跳过一整页。

**网页**：`GET /artifacts/rooms` 返回独立静态页（`static/rooms.{html,js,css}`，
经 `/artifacts-static/` 取资源）。正文一律 `textContent` 渲染，链接只允许 http/https 与站内相对路径。

**注册顺序注意**：`/api/artifacts/{aid}` 必须排在房间静态路由之后，否则 `/api/artifacts/rooms` 会被当成 artifact id（aiohttp 按注册顺序匹配）。

## 7. MCP 工具

`artifacts-mcp.mjs`（8801）新增 3 个工具，形状对齐 OMB：

| 工具 | OMB 对应 | REST |
| --- | --- | --- |
| `post_room_message` | `send_channel_message` | POST `/api/artifacts/rooms/{rid}/messages` |
| `read_room_messages` | `get_channel_messages` | GET `/api/artifacts/rooms/{rid}/messages` |
| `wait_room_message` | `wait_for_conversation` | GET `/api/artifacts/rooms/{rid}/messages?wait=1` |

## 8. 编排器

`room_orchestrator.py`，随 artifacts 服务启动（环境变量 `PILOTV_ROOM_ORCHESTRATOR=1` 开启，默认关闭以便灰度）。

行为：

1. 订阅 `EventBus` 的 `room.message` 事件
2. 按房间 `respond_policy` 算出该投给谁：
   - `mentions`（默认）只有被 @ 的成员
   - `everyone` 房间里所有非 human 成员
   - `member` 只有「房间里成员发的消息」才触发（人发的必须显式 @）
   - `off` 一个都不投 —— 人手里的急停，防止互相 @ 打成死循环
3. 命中成员 → 取其 `session_key`：
   - 有活动 turn → `steer_turn{sessionKey, runId, itemId, message}`
   - `accepted=false` 且 `reason=no_active_turn` → 退回 `submit_turn`
   - `reason` 为 `turn_mismatch` / `turn_closing` / `cancelled` → **不盲目 fallback**，
     记 rejected 并停手（这三个原因说明那边的 turn 状态不明，盲投可能重复触发）
   - `steer_unapplied{reason:"turn_ended"}` → 退回 `submit_turn` 起新 turn
4. 投递内容 = 原正文 + 房间上下文前缀（房间名、`bulletin`、`room_id`、回复自己的指令要求用 `post_room_message` 回话）
5. `itemId` / `idempotency_key` 保证同一条消息不重复投递
6. **投递预算**：每个房间终身最多 20 次自动投递（`PILOTV_ROOM_DELIVERY_BUDGET`）。
   用完之后房间照常记录明文，只是不再自动叫醒 agent —— 要继续就明确新建房间。
   这是**有意的刹车**，不是故障：没有它，「A @ B，B @ A」会无限递归。

连接方式：gateway WS（`/ws`）。若 WS 鉴权不通，退化为 `POST /api/agent`（外部 API key）。

## 9. 借鉴与不借鉴

借鉴自 OMB：

1. `default_responder` 三态路由（首版只做 `mentions`）
2. `@显示名` 寻址
3. `bulletin` 公告板作为角色契约，注入每个成员 turn
4. 来源盖章（外部消息标记为非用户亲笔 + 落审计）
5. `send_id` 幂等 + `task_id` 钉住线程
6. 工作中消息压后上屏（`state: queued→visible`）

不借鉴：Auto 发言人分类器（OMB 的 0.6 阈值是特定模型校准值，不可通用）、定时 routine、审批卡、IM 双向群聊、OMB 自身的 agent runtime 与前端代码（只学设计，不 vendor 源码）。

## 10. 实施阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 本方案入库 | `docs/room-plan.md` 存在 |
| P1 | 房间存储（3 表 + CRUD） | 能建房间、加成员、落消息 |
| P1b | REST + SSE + 幂等 | 重复同 key 只落一条；SSE 收到 `room.message`；cursor 分页正确 |
| P3 | MCP 三工具 + `mcp.json` 挂载 | MCP `tools/list` 返回 7 个工具；agent 能发能读 |
| P4 | 编排器闭环 | mock gateway 上：房间消息 → 成员会话被唤起；当前隔离验收 `scripts/verify_rooms.py` 为 49/49 通过 |
| P5 | 独立房间网页 `/artifacts/rooms` | 建房、成员增删改、顺序转录、@发送、SSE 重连+定时刷新、可见错误及投递状态、安全 textContent；桌面/手机浏览器通过 |
| P6 | 核心安全收口 | 分页不跳消息、长轮询订阅后重查、拒绝 steer 不盲投、房间 20 次终身投递预算、`respond_policy` 生效（含 off 急停）、跨房间 SSE 过滤；`scripts/verify_rooms.py` 49/49 + `scripts/verify_rooms_ui.py` 50/50 通过 |

### 10.1 实际访问地址

- Tailscale（HTTPS，证书有效）：`https://marc-linux-pc.tail2b98e5.ts.net:5186/artifacts/rooms`
- 局域网同址：`https://192.168.0.200:5186/artifacts/rooms`
- 页面走网关 5186 的 `/artifacts/*` 与 `/api/artifacts/*` 代理到本机 8799，
  没有改动网关（5186 未重启、前端未重建）。
- 直接打 8799（非回环来源）需要 `Authorization: Bearer <token>`
  （`/home/marc/.config/pilotv-artifacts/token`）；已实测无 token → 401、带 token → 200。
  本机回环访问免鉴权（既有设计）。

### 10.2 P6 具体收口项

| 项 | 做法 |
| --- | --- |
| 分页游标 | `next_seq` = 本页最后一条的 seq（下一页的 `after_seq`）；房间最大 seq 单独给 `latest_seq`；`before_seq` 可往回翻历史 |
| 长轮询漏消息 | 订阅总线后**再查一次库**：查库与订阅之间落库的消息不会被漏 |
| steer 被拒不盲投 | 只有 gateway 明确回 `no_active_turn` 才改投新 turn；`cancelled` / `turn_mismatch` / `turn_closing` 一律记 rejected 并停手 |
| 递归刹车 | 房间终身 20 次自动投递预算（`skipped` 不计数）；`respond_policy=off` 是人手里的急停 |
| 成员会话独立 | store 层拒绝共用 `session_key`；worker/reviewer 必须给会话 |
| 投递状态可见 | `GET /api/artifacts/rooms/{rid}/deliveries`，网页逐条显示 state 与原因 |

## 11. 风险与限制

| 风险 / 限制 | 应对 |
| --- | --- |
| gateway `/ws` 鉴权与端点 | 已验证原生 gateway `ws://127.0.0.1:18789/ws`：hello、只读 `list_sessions`、`active_turn_snapshot`、`steer_turn` 均成功；3001 是 UI server，不能作为原生 gateway |
| 误触发（每条消息都投递） | 只认 @成员（`respond_policy=mentions`）；`itemId` + 幂等键；`task_id` 校验 |
| 长程 turn 收尾期 steer 被拒 | 只在 `no_active_turn` 时改投 `submit_turn`；其余原因记 rejected 不重试 |
| 互相 @ 死循环 | 房间终身投递预算 + `respond_policy=off` 急停 + 预算用尽须明确新建房间 |
| 房间数据每设备一份 | v1 成员限同一设备；v2 房间上 NAS 中心服务 |
| 房间刷屏 | 只放阶段摘要 + 成果链接，不灌全部工具事件 |
| 本机 8799 是生产实例 | 已安全备份并重启 console，部署 UI 与 runtime；**未向生产写任何测试房间/消息**（四张房间表仍为 0 行）。gateway 5186 未重启 |
| 未跑真实付费 LLM | 完整闭环要求 agent 经 MCP 回写，而 MCP 指向生产控制台 → 会写生产库；改指隔离实例则真 gateway 的 cwd 在 `~/.pilotdeck/app`，agent 可能写文件。故只验到「编排器 ↔ 真 gateway 交互」这一层（`scripts/verify_room_gateway_live.py` 9/9），未跑真实 LLM round trip |

## 12. 运维

- artifacts 服务：既有 `pilotv-artifacts.service`，房间功能随其生效，无需新增单元
- 房间编排器：`pilotv-artifacts.service.d/rooms.conf` 显式打开
  `PILOTV_ROOM_ORCHESTRATOR=1` 与 `PILOTV_ROOM_GATEWAY_WS=ws://127.0.0.1:18789/ws`
  （用 drop-in，不改主单元文件；主单元被别的流程改过也不受影响）
- MCP sidecar：`~/.config/systemd/user/artifacts-mcp.service`，回环 8801 → 控制台 8799
- PilotDeck 侧挂载：`~/.pilotdeck/plugins/artifacts/plugin.json` 指向 `http://127.0.0.1:8801/api/artifacts-mcp`；
  全局 `~/.pilotdeck/mcp.json` 里没有同名条目（同名会被全局那份覆盖 → 全 404），安装器会自动清掉重复项
- 本机部署脚本：`scripts/deploy_rooms_local.py`（只重启必要的服务，失败自动回滚 runtime/config；
  **不**跑 `deploy_local_runtime.sh`，那会顺带重启网关并重建前端）
- 备份目录：`/home/marc/pilotv-room-backups/<时间戳>/`（SQLite online backup + runtime 快照 + user units/config）
- 已验证：HTTPS Tailscale URL 200 且证书有效、静态文件、REST、SSE、生产 MCP `tools/list=7`、
  编排器已连上 18789。直接 8799 非回环无 token → 401、带 token → 200；
  5186 沿用现有网关信任/回环代理路径，未新增鉴权豁免
- 测试：`scripts/verify_rooms.py` 49/49；`scripts/verify_rooms_ui.py` 50/50；
  `scripts/verify_room_gateway_live.py` 9/9（真 gateway，只读）；
  `scripts/check_rooms_ui.mjs`（生产静态页 + mock REST，验建房/成员/发送/XSS/390px 不溢出，不写生产）；
  `scripts/verify_rooms_live.py` 只读验证
- 限制：不保证 exactly-once agent 执行 —— `steer accepted` 只代表入队，
  agent 是否照做以它自己的 MCP 回写为准；WS 断连时投递失败不自动重放
