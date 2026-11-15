# 任务总调度（TaskMaster）· 资源感知调度器

> 2026-11-15 新增。解决的问题来自当天的实测排查：
> 咖啡机 / 新风机 / 车顶架三个长 CAD 任务的自动推进反复「跑一会儿就自己停住」。

---

## 1. 先说结论：停机不是资源不够，是 PilotV 自己的护栏终止了循环

排查依据（都是本机可复核的原始记录）：

| 来源 | 路径 |
| --- | --- |
| 指挥循环账本历史 | `~/.pilotdeck/commander-loops/history.jsonl` |
| 运行日志 | `C:\Users\music\AppData\Local\PilotV\repo\.run\web.log` |
| 会话 transcript | `~/.pilotdeck/projects/<项目>/chats/<session>.jsonl` |

账本 24 条记录里的停机原因分布：

| 原因 | 次数 | 触发者 |
| --- | --- | --- |
| `repeated_thinking` | 6 | `turnStallGuard` 熔断 |
| `turn_timeout`（4h 墙钟兜底） | 3 | `turnStallGuard` 熔断 |
| `turn_idle`（30min 静默） | 2 | `turnStallGuard` 熔断 |
| `repeated_tool_failure` | 1 | `turnStallGuard` 熔断 |
| `verdict_marker_missing` | 3 | 判定轮读不出 verdict |
| `max_recoveries` | 7 | 恢复守护用尽 5 次预算 |

日志原文（节选）：

```
[pilotdeck-bridge] turn stall (turn_timeout) session=web-s_9732936c-…
  { elapsedMs: 14596198, limitMs: 14400000 }
[pilotdeck-bridge] turn stall (turn_idle) session=web-s_72a6f06a-…
  { idleMs: 1800005, limitMs: 1800000, elapsedMs: 1986468 }
[pilotdeck-bridge] turn stall (repeated_thinking) session=web-s_b75a0e71-…
[pilotdeck-bridge] commander loop abandoned (max_recoveries): web-s_9732936c-…
```

### 停机的完整链路

```
turnStallGuard 检测到「无进展」
  → bridge 主动 abort 当前 turn，turnFinishReason = stalled_no_progress
  → 指挥循环 catch 到 commander_stalled:*  ← 这里决定了任务生死
  → 归档成终态 waiting_user / no_progress_stall
  → 恢复守护读到 stopReason === NO_PROGRESS_STOP_REASON 就**永不续跑**
  → 界面上：自动推进开关还亮着，任务不动了
```

关键点在 `commanderLoopStore.isRecoverableNow()`：

```js
// 无进展熔断归档的账本永不再自动恢复
if (record.stopReason === NO_PROGRESS_STOP_REASON) return false;
```

这一行是**刻意**写的 —— 防止「崩溃 → 自动恢复 → 再卡死」的死循环。
但它把「模型真的卡住」和「机器太挤导致任务跑得慢」当成了一回事。

### 资源确实参与了，但不是直接原因

本机当时的实际资源（`2026-11-15 20:36` 采样）：

| 项 | 值 |
| --- | --- |
| 逻辑核 | 16 |
| 内存 | 15.4 GB 总量，**13.6 GB 已用（88%），仅剩 1.8 GB** |
| CPU | 12.9% |
| 显存 | RTX 3050 4 GB，0% 占用 |

内存剩 1.8 GB 时，FreeCAD / Python 脚本开始 OOM 与超时 → 工具失败率上升 →
模型反复重试同一段脚本 → 复读计数顶到上限 → 熔断。

**表面看是「模型卡住」，根子在资源挤。** 而旧护栏对资源一无所知：
它只看「有没有进展」，看不见「这台机器现在有多挤」。

### 并发闸门不是停机原因，但确实让人干等

`commanderLoopSlots` 的全局闸门默认 `maxConcurrent=1`，是**串行**而不是**拒绝**：
第二个任务排队等第一个。2026-11-14 的实测：

- 咖啡机 `web-s_9732936c` 02:31 起账，06:35 触到 4 小时墙钟才停；
- 新风机 `web-s_b75a0e71` 因此从 **02:31 排到 06:35**（4 小时）才起跑，
  排队期间既没有进度也没有解释，界面上就是「这个任务不动了」。

---

## 2. 这套调度器做了什么

一句话：**给熔断一个资源上下文，并把「终止」改写成「可恢复的暂停」。**

| 能力 | 说明 |
| --- | --- |
| 实时监测 | CPU（按核折算空闲）、内存、显存（NVIDIA），5 秒一采 |
| 准入 | 内存/CPU/显存装不下就不开新任务；排队有明确位置 |
| 监督 | 区分「环境慢 / 临时故障 / 真的卡住」，前者暂停后自动续跑 |
| 调配 | 压力高时让低优先级任务让路，而不是让所有任务一起撞墙 |
| 预算 | 熔断的墙钟/静默预算按资源状态伸缩：机器挤就放宽，机器空就收紧 |

### 2.1 熔断分类

`resourceScheduler.classifyStall()`：

| 熔断码 | 机器宽裕 | 机器紧张 | 说明 |
| --- | --- | --- | --- |
| `turn_timeout` | logic | **resource** | 墙钟到顶。挤 = 跑得慢，不是没进展 |
| `turn_idle` | logic | **resource** | 静默超时。挤 = 工具在排队等资源 |
| `repeated_thinking` | logic | logic | 复读同一段分析，需要换策略 |
| `repeated_tool_failure` | 看错误文本 | 看错误文本 | 错误里出现 OOM / timeout / killed → resource |
| `turn_token_budget` | logic | logic | 单轮 token 用完，换一轮继续 |
| 其它 | transient | transient | 临时故障，稍后重试 |

`resource` 类 → **暂停 + 退避后自动续跑**；
`logic` 类 → 也可续跑，但会注入「换做法」提示，并且**有次数上限**（默认 3 次）。

### 2.2 暂停 ≠ 终止

旧行为：熔断 → 归档为终态 `waiting_user / no_progress_stall` → 恢复守护永不续跑。

新行为：

```
熔断 → 调度器分类 → 可恢复？
   ├─ 是 → 账本写成 status='paused'（**保留 running 文件**）
   │        stopReason = 'paused:<分类>'
   │        resumeHint  = 换策略提示
   │        resumeAt    = 退避到期时间（30s → 60s → 120s）
   │        恢复守护在退避后接回来，把 resumeHint 注入下一轮判定
   └─ 否 → 维持旧语义（归档 waiting_user，终态）
```

**保留 running 文件是关键**：删除是「不会再自动恢复」的唯一凭据，
暂停态必须留着文件，恢复守护才接得回来。

### 2.3 换策略提示

只「续跑」是不够的 —— 模型会原样再犯一次。所以恢复后的**第一轮**
判定与派发都会带上提示：

```
【上一轮被暂停，请勿原样重试】
上一轮一直在重复同一段分析。请换一条路：换工具、换脚本、换验证方式，
不要再重复上一次的尝试。
```

提示只在恢复后的第一轮注入，之后清空（每轮都重复会变成噪声）。

### 2.4 资源感知预算

`turnStallGuard` 新增 `config.budgetScale` 钩子，在熔断判定时**实时**调用：

| 压力 | 墙钟预算 | 静默预算 |
| --- | --- | --- |
| normal / elevated | ×1 | ×1 |
| high / critical | ×2 | ×2 |

机器空时**不放宽** —— 不给「空转」留口子。

### 2.5 准入与让路

```
canAdmit(task) =
    并发未到上限
  AND 可用内存 ≥ max(内存地板, 任务预估占用)
  AND 可用显存 ≥ 任务预估占用
  AND 空闲核数 ≥ 任务 CPU 权重
```

- **严格 FIFO**：队列里有人时，后来者必须排队，哪怕它此刻装得下。
  否则一个暂时装不下的队首会被后来者无限插队，直到饿死。
- **让路**：压力为 high/critical 时，最低优先级的运行任务主动让路；
  至少留一个在跑（全让光等于什么都不干）。
- **队列重试**：资源变化时 `pump()` 重看队列，机器腾出空间就自动放行。

---

## 3. 文件清单

| 文件 | 职责 |
| --- | --- |
| `ui/server/services/resourceMonitor.js` | 采样 CPU / 内存 / 显存，算余量与压力分级 |
| `ui/server/services/resourceScheduler.js` | 调度决策核心（纯逻辑，可单测） |
| `ui/server/services/resourceSchedulerStore.js` | 调度器账本（原子写 + 归档） |
| `ui/server/services/resourceSchedulerService.js` | 粘合层：采样 → 决策 → 落盘 |
| `ui/server/routes/resource-scheduler.js` | HTTP 接口 |
| `ui/server/services/commanderLoopSlots.js` | 并发闸门（**已改造**：准入闸 + 严格 FIFO + pump） |
| `ui/server/services/commanderLoopStore.js` | 指挥账本（**已改造**：支持 `paused` 态；`clearCommanderLoopResumeAt` 供手动恢复） |
| `ui/server/services/commanderLoop.js` | 判定/派发提示词（**已改造**：注入换策略提示） |
| `ui/server/services/turnStallGuard.js` | 熔断护栏（**已改造**：预算动态伸缩） |
| `ui/server/pilotdeck-bridge.js` | 接线（**已改造**：暂停路径、准入闸、资源感知预算、账本判死时与调度器对账） |
| `ui/src/components/app-shell/SchedulerStrip.tsx` | **任务窗口顶部调度条**：资源占用 + 压力分级 + 执行/排队/暂停三组任务 |
| `ui/src/components/app-shell/useResourceScheduler.ts` | 调度条的数据钩子（5 秒轮询 + 立即恢复） |

### 数据流

```
resourceMonitor  ──setResources──▶  resourceScheduler  ──onChange──▶  resourceSchedulerStore
      ▲                                    │                                   │
      └──────── subscribe ─────────────────┘                                   │
                                                                           ▼
                                        commanderLoopSlots.gate ◀── canAdmit ──┘
```

---

## 4. 配置

变量都加在跑 **3001（`ui/server/index.js`）** 的进程环境里。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PILOTV_SCHEDULER` | 开 | 总开关。`0` = 完全回退到 2026-11-15 之前的行为 |
| `PILOTV_SCHEDULER_SAMPLE_MS` | 5000 | 资源采样间隔 |
| `PILOTV_SCHEDULER_VRAM_REFRESH_MS` | 20000 | 显存查询间隔（要 spawn `nvidia-smi`，贵） |
| `PILOTV_SCHEDULER_MEM_FLOOR_MB` | 2048 | 空闲内存地板：低于此值不接纳新任务 |
| `PILOTV_SCHEDULER_MEM_CRITICAL_MB` | 768 | 低于此值压力为 critical |
| `PILOTV_SCHEDULER_CPU_CEILING` | 85 | CPU 高于此值不接纳新任务 |
| `PILOTV_SCHEDULER_CPU_CRITICAL` | 95 | CPU 高于此值压力为 critical |
| `PILOTV_SCHEDULER_VRAM_CEILING` | 90 | 显存占用高于此值压力为 high |
| `PILOTV_SCHEDULER_MAX_CONCURRENT` | 跟 `PILOTV_COMMANDER_MAX_CONCURRENT` | 同时运行的任务数 |
| `PILOTV_SCHEDULER_TASK_RAM_MB` | 1024 | 单任务内存占用估值 |
| `PILOTV_SCHEDULER_TASK_VRAM_MB` | 0 | 单任务显存占用估值 |
| `PILOTV_SCHEDULER_TASK_CPU_WEIGHT` | 1 | 单任务 CPU 核数估值 |
| `PILOTV_SCHEDULER_MAX_PAUSE_ATTEMPTS` | 3 | 单任务最多暂停几次，超出判失败 |
| `PILOTV_SCHEDULER_PAUSE_BACKOFF_MS` | 30000 | 退避基数，按暂停次数指数增长 |
| `PILOTV_SCHEDULER_TURN_SCALE_SATURATED` | 2 | 机器紧张时熔断预算的放大倍数 |

> `PILOTV_SCHEDULER=0` 是**运行时开关**：每次访问都重新读环境变量，
> 不必重启 3001 就能立刻关掉。出问题时「立刻关掉」比「改完配置等重启」重要。

---

## 5. 接口

全部挂在 `/api/resource-scheduler/*`（需要认证）。

与上游自带的 `/api/taskmaster`（TaskMaster AI CLI 集成）**刻意分开**，
避免命名混淆。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/resources` | 机器实时状态 + 压力分级 + 队列计数 |
| GET | `/tasks` | 完整任务队列快照 |
| GET | `/tasks/:id` | 单任务详情（含最近一次熔断分类与提示） |
| POST | `/tasks/:id/cancel` | 取消任务 |
| POST | `/tasks/:id/resume` | 立即恢复被暂停的任务 |

`/resume` **仍然要过准入闸**：机器装不下就恢复不了，接口如实回报原因
（HTTP 409）而不是假装恢复了。它同时做两件事才算成功：

1. 把调度器里的任务从 `paused` 放回 `queued`；
2. 清掉指挥账本里的 `resumeAt` —— 真正的重启由恢复守护完成，它读的是账本。

第 2 步失败（账本不在，说明任务已被取消或归档）时接口直接失败：
只改调度器状态不会有任何人来跑它，那就是骗人。

---

## 5.1 任务窗口（界面）

任务窗口顶部多了**调度条**（`SchedulerStrip`），三件事一眼可见：

```
调度  [偏高]  1 个执行中 · 2 个排队 · 0 个已暂停
CPU    ▓▓▓░░░░░░░  35%
内存   ▓▓▓▓▓▓▓▓░░  12.1 GB / 15.4 GB        （悬停显示「可用 3.3 GB」）
显存   ▓░░░░░░░░░  0 MB / 4.0 GB
─ 已暂停  便携咖啡机设计   原因：repeated_thinking   30s 后自动续跑   [立即恢复]
─ 执行中  车顶行李架
─ 排队中  新风机设计       前面还有 1 个
```

设计取舍：

- **只读**，唯一动作是「立即恢复」，且仍要过服务端准入闸 ——
  界面不能成为绕过机器容量限制的后门。
- 资源读不到时**显示「不可用」而不是 0**。显存为 0 是有效读数
  （刚开机就是 0），要和「读不到」区分开。
- 调度器无响应时**保留上一次读数**并标注「无响应」：
  调度器挂了不该让任务窗口跟着白屏。
- 已结束的任务不占位置，留在下面的会话卡片里。

显存是**真查**的：每 20 秒跑一次 `nvidia-smi --query-gpu=memory.total,memory.used`。
没有 NVIDIA 卡时 `vram` 如实为 `null`，且**不算监控器故障**
（`lastVramError` 单独记，不污染 `lastError`）。

---

## 6. 验收

### 单元测试

```bash
cd pilotdeck-mobile/upstream-official/ui
npx vitest run --environment node \
  server/services/resourceMonitor.test.js \
  server/services/resourceScheduler.test.js \
  server/services/resourceSchedulerStore.test.js \
  server/services/commanderLoopSlots.test.js \
  server/services/commanderLoop.test.js \
  server/services/commanderLoopStore.test.js \
  server/services/turnStallGuard.test.js \
  server/pilotdeck-bridge.commander.test.js
```

界面部分：

```bash
npx vitest run --environment jsdom \
  src/components/app-shell/SchedulerStrip.test.tsx \
  src/components/app-shell/TaskMonitorPanel.test.tsx
```

本机实测：**8 个服务端文件 / 153 个用例 + 3 个界面文件 / 47 个用例**
全部通过（Node 24.22.3）。

> 注：`npx vitest run --project server` 在本机不可用（`ui/vite.config.js`
> 没有定义名为 `server` 的 project），直接指定文件路径即可。

### 接线自检（不启动网关、不监听端口）

```bash
cd pilotdeck-mobile/upstream-official/ui
node --import tsx ../../.run/pv-scheduler-smoke.mjs
```

期望输出：

```
snapshot keys: enabled,config,timestamp,resources,counts,tasks,lastPersistError,monitorRunning
enabled: true counts: {"total":0,"running":0,"queued":0,"paused":0}
routes: get /resources | get /tasks | get /tasks/:id | post /tasks/:id/cancel | post /tasks/:id/resume
SMOKE OK
```

### 端到端

1. 给一个会话开自动推进；
2. `GET /api/resource-scheduler/tasks` 确认任务出现在队列里；
3. 制造资源压力（例如同时跑 FreeCAD + `tsc --noEmit`），
   `GET /api/resource-scheduler/resources` 应看到压力分级升到 `high`；
4. 任务熔断后，会话里出现「自动推进已暂停（……）」，
   账本 `~/.pilotdeck/commander-loops/*.json` 的 `status` 变成 `paused`；
5. 退避到期后任务自动续跑，`resumeHint` 被注入下一轮判定；
6. 暂停 3 次后任务判失败，账本归档进 `history.jsonl`。

---

## 7. 回滚

| 场景 | 操作 |
| --- | --- |
| 想立刻关掉调度器（不改代码） | `PILOTV_SCHEDULER=0`，运行时生效，不必重启 |
| 想关掉自动推进本身 | `PILOTV_COMMANDER_LOOP=0` |
| 想关掉崩溃恢复守护 | `PILOTV_COMMANDER_RECOVERY=0` |
| 代码级回滚 | 回退 §3 表中标「已改造」的文件；新文件是纯新增，删除不影响既有行为 |
| 只回滚界面调度条 | 删 `SchedulerStrip.tsx` / `useResourceScheduler.ts`，去掉 `TaskMonitorPanel.tsx` 里的 `<SchedulerStrip />` 一行；服务端调度不受影响 |

`PILOTV_SCHEDULER=0` 时，熔断会回到旧语义（归档 `waiting_user / no_progress_stall`），
这一路径有专门的回归用例守着。

---

## 8. 已知限制

1. **只管自动推进循环**。普通聊天（不开自动推进）不经过调度器，
   资源再紧张也不会被拦。
2. **任务成本是估值**。`taskRamMb` / `taskCpuWeight` 是按任务类型估的，
   不是实测。要更准就得接进程级 RSS 采样（成本更高，当前没做）。
3. **显存只支持 NVIDIA**。AMD / Intel 核显的显存读不到，
   此时 `vram` 如实为 `null`，不会假装有。
4. **暂停恢复依赖恢复守护**。守护每 20 秒扫一次账本，加上退避时间，
   实际恢复延迟在 20–90 秒量级，不是瞬时。界面上的「立即恢复」会清掉
   退避并等下一次扫描（≤20 秒），它不是「绕过守护直接开跑」。
5. **调度条只覆盖自动推进任务**。普通聊天不排队，所以调度条的队列可能是
   0 而下面的会话卡片显示有任务在跑 —— 这两个数字统计的不是同一批东西。
6. **`verdict_marker_missing` 没有被这套调度器改善**。判定轮读不出
   `<<PILOTV_VERDICT>>` 标记时，连续 3 次仍会转人工。这是**另一个**
   问题（提示词契约不够稳），需要单独修。
7. **机器真的不够用时，调度器只能让任务等**。它不会凭空变出算力；
   它做的是「别让三个任务一起把机器压垮然后全部失败」。
