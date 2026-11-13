# 指挥判定循环（Commander Loop）

状态：2026-11-12 实现，默认关闭，开关 `PILOTV_COMMANDER_LOOP=1`。
范围：`ui/server/` 的 Web 会话链路（3001）。不动上游 agent 内核（`src/**`）。

## 1. 问题

现象：一个任务交给 PilotV 之后，agent 干到一半就停了；"指挥"没有接手，不能根据
实际做出来的东西判定"还差什么、下一步做什么"，于是只能人来补一句"继续"。

这不是模型不听话，是运行时里**根本没有那一层**。

## 2. 三个断点

### 2.1 单轮内：没有工具调用就当场"完成"

`src/agent/loop/AgentLoop.ts` 主循环里，模型这一轮只要不产生工具调用，就直接收尾：

```
if (toolCalls.length === 0) { ... stopReason: "completed" ... return }
```

也就是说，"我先把方案说清楚，接下来会去改 X"这种回复，在运行时眼里和"全部做完了"
是同一种结局。于是最常见的失败长这样：先说计划 → 结束 → 等人再说"开始吧"。

同处还有一个更隐蔽的问题：`Stop` 生命周期钩子拿到的消息被 `messages.push(...)`
塞进上下文之后就 `return` 了，模型根本没机会执行；钩子若返回 `block`，甚至会被
当成 `agent_unsupported_feature` 报错。也就是说，**钩子目前没法把一轮续下去**。

（`maxTurns` 不是原因：全仓库没有任何地方给它赋值，它是 `undefined`，不构成上限。）

### 2.2 轮次之间：只有一次"审查"，没有"指挥"

`ui/server/pilotdeck-bridge.js` 在一轮成功结束后，只做一件事：按
`selectProjectReviewer()` 追加**一个** reviewer 轮次，而 `reviewDepth > 0` 直接
返回 `null`（见 `ui/server/services/projectTeamCollaboration.js`）。所以：

- 审查最多发生一次，且只给建议，不驱动下一步；
- `commander` / `executor` 这两个角色在运行时里**没有任何调度逻辑**；
- UI 设置里明明写着「指挥驱动」「自动」，后端只实现了「多问一句」。

这就是"指挥不能根据实施情况直接指挥判定"的直接原因：它没有被赋予这个职责。

### 2.3 项目室：靠 agent 互相 @，且有 20 次终身预算

`room_orchestrator.py` 的驱动方式是"谁被 @ 谁动"，没有独立的判定者；
`ROOM_DELIVERY_BUDGET` 默认 20 次，一个房间用完就静默不再自动叫醒 agent。
多轮返工很容易撞到这条线，看起来同样是"中途停了"。

## 3. 方案：目标 → 证据 → 判定 → 派发

```
用户: 任务（可带「完成条件：」）
  │
  ├─ 执行轮（executor；没有 executor 时就是指挥自己）
  │
  ├─ 判定轮（commander）
  │     输入：目标 + 完成条件 + 上一轮真实产出 + 工作区 git 状态
  │     输出：done / continue(next) / blocked / needs_user
  │     ↑ 判定理由与下一步都以明文写进同一会话
  │
  ├─ continue → 派发 next 给执行者 → 回到判定
  └─ done / blocked / 预算耗尽 → 结束，理由留在会话里
```

三条底线，缺一条这个循环就会变成新的坑：

1. **判定要看到事实，不是自述。** 判定输入固定包含 `git status --porcelain` 与
   `git diff --stat`（2 秒超时，失败就当没有），以及用户写下的完成条件。
   只让模型"自己觉得做完了"等于没判定。
2. **必须能停。** 迭代上限、墙钟预算、同一句指令重复 N 次、用户插话，四个闸门
   任一触发即退出，并说明原因。
3. **不能和人抢会话。** 队列里一有用户消息、或用户直接发了新指令，循环立刻让位。

## 4. 已实现

### 4.1 纯逻辑：`ui/server/services/commanderLoop.js`

不碰 I/O、不碰 gateway，只做判断，因此可以脱离整套运行时测试：

| 导出 | 职责 |
| --- | --- |
| `parseVerdict(text)` | 从指挥回复里解析 `<<PILOTV_VERDICT>>{...}`；容忍代码块、裸 JSON；解析不出就**明确报告失败**，不猜 |
| `decideNextAction(state, verdict, opts)` | 派发 / 结束 / 等人工 / 停止，含四个预算闸门 |
| `extractAcceptance(text)` | 从用户消息里抽「完成条件 / 验收标准」清单，抽不到就空着，不编 |
| `buildJudgeRequest(...)` | 判定提示词：目标、完成条件、客观证据、机器可读行 |
| `buildWorkerDispatch(...)` | 派发提示词：明确"动手改到真的达成为止，不要只给计划" |
| `createCommanderState` / `noteDispatch` / `settleCommanderState` | 循环状态与进度指纹 |
| `describeAction` | 一行中文状态，用于界面提示 |

判定协议（写在提示词最后一行，便于解析也便于人读）：

```
<<PILOTV_VERDICT>>{"status":"done|continue|blocked|needs_user","summary":"...","next":"...","assignee":"可选"}
```

选"明文标记行"而不是旁路 JSON 文件，是为了守住产品规则：判定理由、下一步指令
必须和对话在同一份记录里，可审计、可回放。

### 4.2 接线：`ui/server/pilotdeck-bridge.js`

在 `runChatViaGateway` 的收尾处（reviewer 之后）插入 `runCommanderLoop`，条件：

- 部署方开了 `PILOTV_COMMANDER_LOOP`（`1` / `true` / `on`）；
- 项目团队配置里 `collaboration.mode` 不是 `manual`；
- 团队里存在启用的 `commander`；
- 当前是**用户轮**（内部轮带 `commanderIteration`，不会递归）；
- 本轮 `turn_completed` 且 `finishReason === 'completed'`，队列为空，会话未删除。

模式由团队构成决定：

- 有 `executor`（`reportsTo` 指向指挥或为空）→ `delegated`：判定轮出指令，派发给执行者；
- 没有 → `self`：判定轮本身带着"未完成就继续干"的指令，指挥自己推进。

内部轮次都用 `internalReview: true` + `fromQueue: true`，所以不会触发审查、
不会改会话绑定的 agent、不会二次进入指挥循环。

**2026-11-13 起循环状态会落盘**（见 §12）。用户明确打开自动推进时，目标、完成条件、
迭代数、预算、指令指纹逐轮写到 `~/.pilotdeck/commander-loops/`；进程重启或网关崩溃后
由恢复守护接回。人插话或队列非空立刻退出并归档账本 ——「人优先」没有变，变的只是
进程崩溃不再悄悄撤销用户给过的授权。

### 4.3 上限

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PILOTV_COMMANDER_LOOP` | 关 | 总开关 |
| `PILOTV_COMMANDER_MAX_ITERATIONS` | 6 | 判定轮上限（delegated 一轮 ≈ 2 个 turn） |
| `PILOTV_COMMANDER_MAX_MINUTES` | 45 | 墙钟预算 |
| `PILOTV_COMMANDER_MAX_CONCURRENT` | 1 | 同时跑的自动推进循环数（全局串行，见 §12） |
| `PILOTV_COMMANDER_RECOVERY` | 开 | 设 `0` 关闭崩溃恢复守护 |
| `PILOTV_COMMANDER_RECOVERY_SCAN_MS` | 20000 | 恢复守护扫描账本的间隔 |
| `PILOTV_COMMANDER_RECOVERY_GRACE_MS` | 90000 | 账本静默多久才允许恢复（防抢正在跑的循环） |
| `PILOTV_COMMANDER_RECOVERY_INTERRUPTED_GRACE_MS` | 15000 | 明确标记中断后的重试等待 |
| `PILOTV_COMMANDER_MAX_RECOVERIES` | 5 | 单个循环最多恢复次数，超过归档为 `abandoned` |
| `PILOTV_COMMANDER_RECOVERY_STALE_MS` | 24h | 账龄上限，避免几个月前的任务突然开跑 |

另外两条硬编码闸门：同一句下一步重复 2 次判 `no_progress`；判定读不出来连续 2 次
转人工。两者都不静默吞掉，会在会话里留一行原因。恢复不会重置迭代数与墙钟起点，
所以不会靠重启"刷"出新的 6 轮 / 45 分钟。

## 5. 怎么开

变量要加在**跑 3001（`ui/server/index.js`）的那个进程环境**里。NAS 上它是
PilotDeck 运行时守护拉起的子进程，所以加在父服务的单元里最省事：

```ini
# pilotdeck.service（18789 agent gateway，3001 是它的子进程）
Environment=PILOTV_COMMANDER_LOOP=1
Environment=PILOTV_COMMANDER_MAX_ITERATIONS=6
```

改完 `systemctl daemon-reload && systemctl restart pilotdeck`，然后确认子进程确实拿到了：

```bash
tr '\0' '\n' < /proc/$(pgrep -f 'ui/server/index.js' | head -1)/environ | grep PILOTV_COMMANDER
```

本地 `start.sh` 起的那套，在脚本顶部 `export PILOTV_COMMANDER_LOOP=1` 等价。

## 6. 验收

1. 建一个项目团队：`commander` + `executor`（`reportsTo: commander`），协作模式选「指挥驱动」。
2. 发一条带验收标准的任务：

   ```
   把登录页改成手机可用
   完成条件：
   - 320px 宽度下没有横向滚动
   - npm test 通过
   ```

3. 期望看到：用户轮 → 一行「指挥判定 #1 进行中…」→ 指挥的判定回复（末尾带
   `<<PILOTV_VERDICT>>…`）→ 执行者收到派发指令 → 「指挥判定 #2」→ 直到 `done`
   或触到上限后出现「指挥循环已停止（max_iterations）」。
4. 中途发一条新消息：循环必须立刻退出并提示"用户已接管本轮"。

自动化测试（32 项，含 4 项端到端接线）：

```bash
cd pilotdeck-mobile/upstream-official/ui
npx vitest run server/services/commanderLoop.test.js server/pilotdeck-bridge.commander.test.js
```

> 本机跑整套 `npm test` 时若报 `Cannot find package 'jsdom'`，是本地没装前端测试依赖，
> 与本次改动无关；用上面的单文件命令即可。

## 7. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| token 变多（每轮多一次判定） | 默认关；迭代上限 6；超过就停 |
| 指挥自评自过 | 判定输入固定带 git 事实与完成条件；有 `supervisor` 角色时可改由它判定（未实现，见下） |
| 死循环 | 迭代 / 墙钟 / 指令重复三重闸门 |
| 和人抢会话 | 队列非空或用户发言即退出；恢复守护同样跳过 `active` / 有排队消息的会话 |
| 网关崩溃后任务停住 | 账本 + 恢复守护 + 内部轮结果判据，见 §12 |
| 恢复后偷偷续跑人已放弃的任务 | 只对「用户明确开过自动推进」的账本恢复；插话即终止并归档；次数/账龄双上限 |
| 行为不可预期 | `PILOTV_COMMANDER_LOOP=0` 关新循环，`PILOTV_COMMANDER_RECOVERY=0` 关恢复守护，无需改代码 |

## 8. 轮内续跑（P0，已实施）

单轮内的完整性闸门已打进内核：`Stop` 生命周期钩子返回**消息**（且未 `block`）时，
不再把消息塞进上下文就收尾，而是当场再起一轮模型迭代，把钩子的反馈喂回去。
"先说计划再动手"这类输出从此不会把 turn 提前结束。

改动位置（vendored 内核 `src/`，运行时经 tsx 直接加载，无需构建产物）：

- `src/agent/loop/AgentLoop.ts` — `toolCalls.length === 0` 分支里 `dispatchLifecycle("Stop")`
  之后：满足条件就 `turnCount += 1`，发 `turn_continued`（`reason: "stop_hook"`）并 `continue`。
- `src/agent/loop/stopHookContinuation.ts`（新增）— 纯判定函数 `shouldContinueAfterStopHook`，
  双重闸门：**硬上限 3 次**（`MAX_STOP_HOOK_CONTINUATIONS`，因为本仓库多数调用方不设
  `maxTurns`，光靠它兜不住死循环）+ 尊重 `maxTurns`（设了就按它算）+ 中止信号优先。
- `src/agent/protocol/state.ts` — `AgentLoopTransitionReason` 联合类型补 `"stop_hook"`，
  事件经网关透传为 `agent_status`，UI 无需改。

验证：

```bash
cd pilotdeck-mobile/upstream-official
npx tsc -p tsconfig.json --noEmit   # 我方改动 0 报错（仓库另有 3 个 approval 测试的既有报错，与本次无关）
node --import tsx --test --test-timeout 60000 "src/agent/loop/stopHookContinuation.test.ts"  # 6 项
npx tsc -p tsconfig.json            # 全量编译 + 产物输出通过，dist 里含 stopHookContinuation.js
node --test dist/src/agent/loop/stopHookContinuation.test.js   # 编译产物同样 6 项通过
```

> 不要用 `npm run build` 验证：其 `prepare-computer-use.mjs` 会从网络下载 Cua Driver
> （单次 5 分钟超时 × 4 次重试），本机网络下会卡 20 分钟以上，与代码正确性无关。
> 运行时（`node --import tsx`）直读 `src/`，本补丁重启服务即生效，无需 dist。

注意：外层指挥循环（`PILOTV_COMMANDER_LOOP=1`）不受影响，两者叠加时的总迭代数仍受
外层 6 轮上限约束。

## 9. 轮内自检钩子（P0 收尾，已实施）

上面那套闸门只是"能续跑"；真正决定**什么时候该续**的是这一节。一个注册在 `Stop`
事件上的回调钩子，在模型停止调用工具的那一刻做一次自检，判定"这算干完了"还是
"提前收尾"，后者就返回一条 `additionalContext` 消息——正是上面闸门吃的那个输入。

**判定依据（全部在校验时可得，不做额外模型调用）：**

| 输入 | 来源 |
| --- | --- |
| 最后一条 assistant 文本 | `Stop` payload `lastAssistantMessage`（原有） |
| 最后一条用户任务/完成条件 | payload `lastUserMessage`（本轮新增，跳过 hook_context 与 transient 消息） |
| 本轮实际调用过的工具名 | payload `toolsUsedThisTurn`（本轮新增，循环内累积，非整会话） |
| 是否已在续跑中 | payload `stopHookActive` |

**规则（顺序匹配，先中先出）：**

1. 已在续跑 → 放行（一轮最多自检一次；误报只多花一次模型调用，不会改错结果）
2. 空回复 → 放行（交给 inner 的空输出恢复逻辑）
3. 在等用户（`无法继续`/`请提供`/`需要我…吗`/末尾问号/给用户留选项）→ 放行
4. 明说还有没做完的（`还需要`/`还没跑`/`未完成`/`TODO`/`still need`）→ **续**
5. 只描述计划、本轮零工具调用（`我先…然后…`/`接下来我会`/`I'll now`）→ **续**
6. 声称完成、零工具调用、而用户提的是改造类需求 → **续**
7. 用户写了完成条件、回复没有逐条确认 → **续**（把条件列表原样回灌，要求逐条给证据）

只描述计划但本轮**确实跑过工具**的，视为进行中，放行（不打断正常的"读文件→再改"节奏）。
末尾问号只认最后一行，正文里出现问号不算交还用户。

**改动位置：**

- `src/agent/loop/stopSelfCheck.ts`（新增）— 纯逻辑：`assessStopSelfCheck`、
  `extractAcceptanceCriteria`（与 bridge 侧 `extractAcceptance` 同规则）、`lastUserPromptText`。
- `src/agent/loop/stopSelfCheckHook.ts`（新增）— 回调处理器，输出
  `{type:"sync", specific:{hookEventName:"Stop", additionalContext}}`；`isStopSelfCheckEnabled` 读开关。
- `src/cli/createLocalGateway.ts` — 每个会话的 `HookRuntime` 里注册该回调（仅在开关打开时）。
- `src/agent/loop/AgentLoop.ts` — `Stop` payload 补 `lastUserMessage` / `toolsUsedThisTurn`，
  循环内记录本轮工具名。

**开关**（默认关，和指挥循环保持一致，避免默认消耗）：

```bash
# 网关进程（18789，由 .run/agent-supervisor.mjs 拉起，env 透传）
PILOTV_STOP_SELF_CHECK=1
```

关掉用 `PILOTV_STOP_SELF_CHECK=0`（或不设）。改完重启网关进程即生效。

已知行为：子代理的 loop 复用父会话的 `lifecycle`（`SubAgentSession.cloneDependencies`），
所以子代理 turn 收尾时也会跑这套自检。影响是子代理可能被要求把话说完再返回，代价是
每个子代理最多多一次模型调用；不想要这个行为就整体关掉开关（暂未按 `agentId` 细分）。

**验证：**

```bash
cd pilotdeck-mobile/upstream-official
npx tsc -p tsconfig.json    # 全量编译通过；本次改动 0 报错
node --import tsx --test --test-timeout 60000 \
  "src/agent/loop/stopSelfCheck.test.ts" \
  "src/agent/loop/stopSelfCheckHook.test.ts" \
  "src/agent/loop/stopSelfCheckDispatch.test.ts" \
  "src/agent/loop/stopHookContinuation.test.ts"   # 29 项全过
```

其中 `stopSelfCheckDispatch.test.ts` 走的是真的 `HookRuntime` + `LifecycleRuntime`：
`Stop 事件 → 命中回调 → additional_context 效果 → 合成 user 消息`，这条链断掉自检会
静默失效，所以单独测。

## 10. 自动推进开关（界面）与完整工作流程

### 10.1 开关

位置：输入框右下角、发送按钮正上方的一枚小开关「自动推进 / Auto-drive」。

- 打开：这一轮结束后，指挥（项目没配指挥时由当前 Agent）检查最初目标是否达成，
  没达成就继续推进，直到判定 `done` / 需要人工 / 触到预算。
- 关闭：这一轮结束就是结束，行为与改动前完全一致。
- 状态存在浏览器 `localStorage`（`pilotdeck.autoDrive`），刷新、换会话都保持；
  每次发送随 `options.autoDrive` 带给后端，排队消息与「重新生成」同样携带。
- 不传 `onAutoDriveChange` 时开关不渲染，所以其他调用方零影响。

开关**优先于**环境变量 `PILOTV_COMMANDER_LOOP`：

| 界面开关 | `PILOTV_COMMANDER_LOOP` | 结果 |
| --- | --- | --- |
| 开 | 任意 | 跑指挥循环（无指挥角色 → self 模式） |
| 关 | 1 | 不跑（用户明确关掉，优先） |
| 未传 | 1 | 跑，但仍要求团队配置里有指挥且不是 manual |
| 未传 | 未设 | 不跑 |

### 10.2 完整工作流程

一次发送按下后的完整链路：

```
① 用户输入 + 开关状态
   └─ Composer(onAutoDriveChange) → ChatInterface(autoDrive)
      → useChatComposerState → sessionLauncher
      → WS 帧 { type:'pilotdeck-command', options:{ autoDrive:true, ... } }

② ui/server/index.js 收到帧 → runChatViaGateway(command, options)

③ 用户轮（正常一轮 Agent 执行，工具照用）
   └─ 轮内：模型停止调用工具时，Stop 自检钩子（PILOTV_STOP_SELF_CHECK=1 时）
      判断是「干完了」还是「提前收尾」，后者回灌一条消息 → 同一 turn 继续

④ 用户轮结束（turn_completed，finishReason=completed）
   └─ 判据：!internalReview && !commanderIteration && 队列为空 && 未删除
       && shouldRunCommanderLoop(projectRuntime, options)   ← 开关在这里生效

⑤ 指挥判定轮（新的一轮，同一会话）
   证据 = 上一轮最后的 assistant 文本 + git status / git diff --stat + 完成条件
   目标 = 用户原始输入（options.acceptance 有就用它，否则从输入里抽「完成条件：」列表）
   要求指挥回复末行输出：
        <<PILOTV_VERDICT>>{"status":"done|continue|blocked|needs_user","next":"…"}

⑥ decideNextAction
   done            → 收尾，提示「任务结束」
   continue        → self 模式：判定轮本身已带「继续执行」指令，直接进 ④'（下一圈）
                     delegated 模式：再把指令派给执行者跑一轮，再进 ④'
   blocked / needs_user → 收尾并说明原因
   触到上限（迭代 6 / 墙钟 45min / 同指令重复 2 次） → 收尾并说明 stop reason

⑦ 每一圈都先检查「用户是否接管」：队列非空 / 正在跑别的 turn / 会话被删
   → 立刻退出并提示「用户已接管本轮」
```

一句话：**开关打开后，一轮回复不等于任务结束；每一轮结束都由指挥重新对照最初目标，
没达成就继续，直到达成或触到预算。**

### 10.3 三层各管什么

| 层 | 触发时机 | 由谁决定要跑 | 作用 |
| --- | --- | --- | --- |
| 轮内 Stop 自检钩子 | 模型这一轮不再调工具 | 环境变量 `PILOTV_STOP_SELF_CHECK` | 防「只说不做」把 turn 提前结束 |
| 轮末指挥判定循环 | 一轮正常结束之后 | 界面开关 / `PILOTV_COMMANDER_LOOP` | 对照最初目标，未达成继续推进 |
| 项目室 `room_orchestrator` | 多 Agent 房间内 @ 派发 | 房间自身预算 | 多人协作场景，与本开关无关 |

## 11. 还没做（按收益排序）

1. **独立判定者（P1）**：团队里有 `supervisor` 时，判定轮交给它，指挥只负责派发。
   自评自过是这套机制最弱的一环，换一个模型/角色成本很低。

2. **可执行的完成条件（P1）**：完成条件写成 `check: npm test` 时，由 bridge 在
   项目目录里跑一次，把 exit code 作为证据喂给判定。这需要一份显式白名单
   （谁能配、跑什么、超时多少），属于安全决策，先不默认开。

3. **界面开关（P2）**：`collaboration` 现在只接受 `mode` 一个字段
   （`projectTeamConfig.js` 的 `COLLABORATION_FIELDS` 白名单），要加
   `{mode, maxIterations}` 得先扩 schema 与 UI。

4. **项目室侧对齐（P2）**：`room_orchestrator.py` 的 20 次终身预算应按「连续无进展次数」
   而不是「总投递数」计费，否则正常的返工也会被刹车。

## 12. 崩溃恢复与稳定性（2026-11-13 事故修复）

### 12.1 现象与根因

本机两个任务（便携咖啡机 / 新风机）都打开了界面上的「自动推进」，跑到一半停住，
开关仍亮着、没有 `turn_completed`、没有「任务结束」，也没碰到 6 轮 / 45 分钟上限。
当晚 gateway（127.0.0.1:18789）在 21:09、21:22、21:42 三次崩溃：

```
Fatal error ..., Check failed: marking_done_.     # V8 cppgc 并发标记断言
exit code 2147483651 (0x80000003)                  # supervisor 随即换 pid 拉起
```

崩溃前两个会话并发、上下文 65k / 75k tokens、其中一个触发 89k full compaction，
还伴随模型 `network_error` 重试。Web 侧对应 `runChatViaGateway threw: Gateway WebSocket closed`
与一串 1006 断连。会话 transcript 都停在工具调用中间，产物和记录没丢。

三个叠加的缺陷让任务**再也起不来**：

1. 循环状态只在 `state.commanderLoop`（3001 进程内存）。gateway 崩溃 → WS 断连 →
   `runChatViaGateway` 在 catch 里把异常**吞掉并正常返回** → 循环 `finally` 清空状态。
   重启后没人记得任务没跑完，`pending-inputs` 也是空的。
2. 循环内部调 `runChatViaGateway` 时**不检查返回值**，断连后继续拿旧 transcript 解析
   verdict 甚至继续派发，等于空转。
3. 两个长上下文循环同时跑，正好落在 V8 cppgc 断言的触发条件上。

### 12.2 修复

| 位置 | 改动 |
| --- | --- |
| `ui/server/services/commanderLoopStore.js`（新） | 磁盘账本：逐轮原子写 `~/.pilotdeck/commander-loops/<session>.json`；终态追加 `history.jsonl` 后删除 running 文件；坏文件隔离留证；纯函数负责恢复判据与 options 重建 |
| `ui/server/services/commanderLoopSlots.js`（新） | 全局并发闸门，默认 1：两个任务同时开自动推进时第二条**排队**而不是一起压垮网关 |
| `ui/server/pilotdeck-bridge.js` | 循环逐轮落盘；内部轮用 `isIncompleteTurn()` 检查 `turnFinishReason`，断连即标 `interrupted` 并保留账本；正常结束 / 用户接管 / 触顶才归档；支持 `resumeRecord` 从账本恢复（迭代数、墙钟起点、指令指纹都带回）；新增 `startCommanderLoopRecovery()` 守护；连「第一条指令就赶上崩溃」也记账 |
| `ui/server/index.js` | 服务 listen 后启动恢复守护，状态帧发给正在 watch 该会话的前端 |
| `.run/agent-supervisor.mjs` | 启动日志记 `node` 版本与实际 V8 flags；`PILOTDECK_GATEWAY_NODE_FLAGS` 显式注入；命中已知受影响构建时打 WARN |

恢复链路（全在 3001 进程内，不依赖 gateway 存活）：

```
账本 running/interrupted
  → 守护每 20s 扫描（跳过：内存已有循环 / 会话 active / 有排队消息 / 人已接管）
  → 网关可用 → 从下一轮判定继续（不重发用户消息、不重置预算）
  → transcript 写一条 commander_loop_recovered 明文事件
  → 终态归档到 history.jsonl 并删 running 文件
```

### 12.3 配置与运维

变量都加在跑 **3001（`ui/server/index.js`）** 的进程环境里；网关侧的
`PILOTDECK_GATEWAY_NODE_FLAGS` 加在拉起 supervisor 的环境里。完整默认值见 §4.3。

```bash
# 看现在有哪些任务挂在账本上（明文 JSON，可直接读）
ls -la ~/.pilotdeck/commander-loops/
cat ~/.pilotdeck/commander-loops/*.json

# 看恢复/归档历史
tail -n 20 ~/.pilotdeck/commander-loops/history.jsonl

# 只想停掉自动续跑，不动代码
PILOTV_COMMANDER_RECOVERY=0        # 关恢复守护
PILOTV_COMMANDER_LOOP=0            # 关新循环（界面开关仍优先）
```

**让某个人工任务彻底不再恢复**：在会话里发一条消息（用户接管会让循环终止并归档），
或删掉对应账本文件。不要直接编辑 running 文件里的 `status`。

**升级运行时**：`Check failed: marking_done_` 是 Node/V8 的运行时断言，应用层无法
根除。本机已于 2026-11-13 升到 **Node 24.22.3 LTS**（详见 §12.6），并发闸门
（`PILOTV_COMMANDER_MAX_CONCURRENT=1`，默认即 1）仍保留为第二道防线。
`PILOTDECK_GATEWAY_NODE_FLAGS="--max-old-space-size=4096"` 是可显式注入的缓解项，
是否对本断言有效需按机型实测，默认不改任何 V8 行为。

即使再崩，业务上也不再"停住"：账本还在，网关回来后自动续跑；恢复 5 次仍失败或
账龄超过 24h 会归档为 `abandoned`，并在日志与 transcript 里留原因。

### 12.4 验证

```bash
cd pilotdeck-mobile/upstream-official/ui
npx vitest run --environment node \
  server/services/commanderLoopStore.test.js \
  server/services/commanderLoopSlots.test.js \
  server/services/commanderLoop.test.js
```

本机 `vite.config.js` 默认 `environment: 'jsdom'`，而这台机器没装 jsdom；
跑纯 Node 侧用例时显式加 `--environment node`。Node 22 与 Node 24 下均跑过全量
相关回归（9 个文件 / 167 个用例全部通过）。

端到端自检：给一个会话开自动推进 → 确认账本出现 → `taskkill` 掉 gateway 让
supervisor 换 pid → 观察 `web.log` 出现 `commander loop interrupted` 与
`commander recovery watcher` 后续日志 → 会话 transcript 出现
`commander_loop_recovered` → 任务从下一轮判定继续。

### 12.5 回滚

`PILOTV_COMMANDER_RECOVERY=0` 关恢复守护、`PILOTV_COMMANDER_LOOP=0` 关新循环，
两者都是环境变量，无需改代码。已有账本不会被守护读取，可保留供人工查看。
代码级回滚即回退本节的 5 个文件，账本为纯新增目录，删除不影响会话记录。

### 12.6 Node 24 LTS 升级（2026-11-13，本机 Windows）

运行时缺陷本身必须靠升级解决，账本只是兜底。本机做法是**给 PilotV 装一份独立
运行时，不动宿主**：WorkBuddy 自带并注入 PATH 的 `22.22.2` 保持不变（宿主自身依赖），
PilotV 全链路改用 `24.22.3 LTS`（V8 `13.6.233.17`）。

```text
安装位置   %USERPROFILE%\tools\node-v24.22.3-win-x64\node.exe
安装方式   官方 win-x64 zip 解压（镜像下载 + SHASUMS256.txt 校验，未跑 msi、不改系统 PATH）
持久变量   PILOTDECK_NODE = <上面的 node.exe>（用户级）
```

启动脚本 `.run/restart-3001.cmd`、`.run/web-3001.cmd`、`.run/agent-supervisor.cmd`
统一按以下优先级解析 node，全部是纯 ASCII + CRLF。前两个是本机运行态文件
（被 `.gitignore` 排除、不入库），只有 `agent-supervisor.cmd` 随仓库分发；
Linux / NAS 由 systemd 直接指定运行时路径，不用 `.cmd`：

```text
PILOTDECK_NODE  >  %USERPROFILE%\tools\node-v24*  >  WorkBuddy 自带目录  >  PATH 里的 node
```

**整条链只需要改 3001 一处**：`index.js` 用哪个 node 启动，`gateway-keeper` 就
用 `process.execPath` 拉起 `agent-supervisor.mjs`，supervisor 再用 `process.execPath`
spawn gateway。所以 3001 换成 24 之后，keeper / supervisor / 18789 全是 24，
`supervisor.log` 里每行的 `node=` 可直接核对。

```bat
:: 重启并确认版本
.run\restart-3001.cmd
findstr /c:"node=" .run\supervisor.log
```

验证：新 node 下对 `pilotdeck-bridge.js` / `index.js` / 两个新 service 做 `--check`
全部通过；vitest 相关用例在 Node 24 下通过。注意 **PATH 上的 `node` 仍是 22.22.2**，
手工敲 `node server/index.js` 会退回旧运行时；要么走上面的 `.cmd`，要么显式设
`PILOTDECK_NODE`，要么直接用绝对路径。若确实要全局切换，把
`%USERPROFILE%\tools\node-v24.22.3-win-x64` 前置到用户 PATH，并重启宿主应用。

回滚：删除 / 清空 `PILOTDECK_NODE` 并把 `tools\node-v24*` 目录改名，三个 `.cmd`
会自动回退到 WorkBuddy 自带的 22.22.2；账本与并发闸门不受影响，但会重新暴露在
该 V8 断言下，不建议长期停在 22.22.2。回滚时还要把 `better_sqlite3.node` 换回
`*.abi127.original`，否则 22 会因 ABI 不匹配起不来。

**运行时闸门必须一起放宽**，否则 3001 一启动就被自己拦下来：

| 文件 | 改动 |
| --- | --- |
| `scripts/check-node-runtime.mjs` | 从「>=22.13.0 且 <23」改为「>=22.13.0 且 <25，允许 22 / 24 两条 LTS 线」；命中 22.22.2 只打 WARN 不拒绝 |
| `install.sh` | `SUPPORTED_NODE_MAJORS="22 24"`，Linux 安装器同一口径；`bash -n` 通过 |
| `scripts/check-node-runtime.test.mjs`（新） | `node --test` 10 个用例，覆盖 22.12/22.13/22.22.2/23/24/25 与 cppgc 告警 |
| `README_SOURCE_INSTALL*.md` | 故障排查说明同步更新 |

**ABI 绑定模块**：换主版本后 `better-sqlite3` 必须换 ABI（22 → 127，24 → 137）。
本机下载官方 `better-sqlite3-v12.10.0-node-v137-win32-x64.tar.gz` 解压覆盖
`build/Release/better_sqlite3.node`，旧二进制改名保留为 `*.abi127.original`
和 `*.abi127.bak`。全仓只有这一个 ABI 绑定模块，其余 `.node` 都是 N-API。
验证：`<node24> -e "const D=require('<pkg>'); console.log(new D(':memory:').prepare('select 1').get())"`。

**插件进程回落**：`ui/server/utils/plugin-process-manager.js` 原来
`spawn('node', ...)` 会从 PATH 找到 WorkBuddy 自带的 22，结果是
`3001(24) → gateway-keeper(22) → supervisor(22) → gateway(22)`，
网关一崩重启就退回旧运行时。已改为 `spawn(process.execPath, ...)`；
两个启动器再把 node 所在目录前置到 `PATH` 作为兜底。核对：
`supervisor.log` 的 `node=` 行为 `24.22.3`，且进程映像路径指向
`tools\node-v24.22.3-win-x64\node.exe`。
