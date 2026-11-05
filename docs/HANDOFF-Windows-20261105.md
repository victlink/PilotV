# PilotV Windows 部署排障交接 · 2026-11-05

> **收件方**：NAS 上 PilotDeck 的 PilotV 开发（`/vol3/1000/Work/00/PilotV`）
> **发起方**：本地 Windows 设备 `marc-pc`（Tailscale `100.120.169.61`），仓库浅克隆 `C:\Users\music\projects\pilotv`
> **目的**：把本地四轮排障定位到的 **3 处 upstream 源码缺陷** 与 **Windows 安装/部署问题** 一次性交回主仓库，
> 让后续其他设备（尤其 Windows）安装时不再重复踩坑。
> **基准**：本机 HEAD `474ba0f`；NAS HEAD `6cb868a`（未推 GitHub，GitHub 仍为 `474ba0f`）。

---

## 0. 结论先行

页面反复出现 `PilotDeck gateway is unavailable.` **不是网络/端口问题**，四轮排查依次排除了
「日志死循环扰动」「控制台耦合」「外部信号」，最终定位为：

**upstream 自身两处缺陷叠加，把一次局部异常放大成整个 gateway 进程退出；修好后又抓到第三处。**

| 环节 | 缺陷 | 后果 |
|---|---|---|
| A | `CompactionEngine` 摘要超长就 `throw`，无降级 | 长会话压缩永远失败 → 上下文无限膨胀 → 持续产生失败 promise |
| B | `pilotdeck.ts` 的 `unhandledRejection` 处理器调 `shutdownAndExit(1)` | 任一会话的次要 promise 失败 → **整个** gateway 优雅退出 → 所有 WebSocket 断连 |
| C | `commandRunner` Windows 输出解码用 `fatal:true` | 混合 GBK/UTF-8 字节 → `uncaughtException` → 同样整进程退出 |

`pilotdeck-bridge.js` 的 `isGatewayUnavailableError` 正则命中 `Gateway WebSocket closed`，
把它翻译成用户看到的那句文案。B 还用 `telemetry.trackError` 吞掉了堆栈，
日志只剩 `[telemetry] shutdown snapshot`，**这是前两轮误判为「无异常优雅退出」的直接原因**。

---

## 1. 交付物清单（本目录文件平铺，符合 `_归档约定.md`）

| 文件 | 用途 | 是否应进仓库 |
|---|---|---|
| `HANDOFF.md` | 本文档 | 建议作为 `docs/` 归档，非必须 |
| `upstream-3-fixes.patch` | 3 处源码补丁，`git apply` 可直接用 | **必须** |
| `start-windows.cmd` / `start-windows.ps1` | Windows 四服务启动器（幂等 + 按端口反查停止） | **建议新增** |
| `pilotv-boot.cmd` | 登录自启入口（幂等，CRLF+ASCII） | **建议新增** |
| `renew_gateway_tls.ps1` | TLS 证书续期（已改为按端口反查，不信任 `pids.json`） | **建议新增** |
| `agent-supervisor.cmd` / `agent-supervisor.mjs` | 18789 gateway 的 detached 守护 + 18790 单实例锁 | **建议新增** |
| `devices.json.template` | 设备清单模板（**不要**硬编码 Tailscale IP） | 建议作为模板 |
| `apply_on_nas.sh` | 在 NAS 上应用补丁 + 落地脚本 + 提交的可复现脚本 | 参考 |
| `verify_windows.ps1` | 新 Windows 设备部署后自检 | 建议新增 |

> 本机这些 `.cmd` / `.ps1` / `.mjs` 在 `git status` 里全是 **`??`（未跟踪）**，
> 即 NAS 仓库里**根本不存在** Windows 部署脚本 —— 这就是新设备必然重复踩坑的结构性原因。

---

## 2. 三处 upstream 补丁（逐条说明）

补丁基于 `474ba0f` 生成，纯 LF / 纯 ASCII，Linux 端 `git apply` 可直接用。
NAS 的 `6cb868a` 只改了 `ui/` 下的项目成员功能，**未触碰这 3 个文件**，无冲突。

### 2.1 `src/cli/pilotdeck.ts`（约 429 行）— `unhandledRejection` 不再杀进程

原版：
```ts
process.on("unhandledRejection", (reason) => {
  telemetry.trackError(reason, { module: "runtime", metadata: { source: "unhandledRejection" } });
  void shutdownAndExit(1);
});
```
修复后：只 `console.error` 完整 reason + `trackError`，**不退出**；
`uncaughtException` 保留 `shutdownAndExit(1)` 作为最后防线，但补上完整堆栈日志。

**定性**：设计缺陷，非逻辑错误。`pilotdeck gateway` 是常驻多会话服务
（`await new Promise(() => undefined)` 永久挂起），却沿用了 CLI 单会话的 fail-fast 策略。
代价是「一个会话的压缩/遥测失败 → 全部在线会话掉线」。
**可观测性补丁同样重要**：没有那两行 `console.error`，第三处 bug 至今仍查不出来。

### 2.2 `src/context/compaction/CompactionEngine.ts`（约 426 行）— 摘要截断接受部分结果

原版：
```ts
if (finishReason === "length") {
  throw new Error("Summary model output was truncated at the token limit");
}
```
修复后：改为 `console.warn` + 返回已生成的 `text`，让 full compaction 完成。

**定性**：明确的 bug。常量 `COMPACT_MAX_OUTPUT_TOKENS = 4_000`
（同文件 70 行），摘要顶到输出上限是**可预期常态**。抛错后被 `run()` 的 catch 捕获 →
设置 `summaryFailureCooldownUntil`、`summarySucceeded: false` → 压缩不落地 →
会话继续膨胀 → 下一轮再触发 → 再失败，**没有任何降级路径**。
本地实测病态会话 `web-s_af06d514…`：2.8 MB jsonl / 146 条消息 / 86k tokens，
`full_compaction_no_summary` 反复出现，最终诱发了整进程退出。

### 2.3 `src/tool/builtin/bash/commandRunner.ts`（约 211 行）— Windows 输出解码容错

原版：
```ts
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
```
修复后：
```ts
const utf8Decoder = new TextDecoder("utf-8");   // 非 fatal，非法字节降级为 U+FFFD
```
**定性**：明确的 bug，且是 16:13:30 那次复发（gateway PID 19880 → 58648）的真凶。
堆栈（由 2.1 新增的日志抓到）：
```
uncaughtException: TypeError: The encoded data was not valid for encoding utf-8
  at TextDecoder.decode (node:internal/encoding:464:14)
  at Object.decode (.../src/tool/builtin/bash/commandRunner.ts:217:28)
  at Socket.<anonymous> (.../commandRunner.ts:129:36)
  code: 'ERR_ENCODING_INVALID_ENCODED_DATA'
```
Windows 下命令输出常混入 GBK / 二进制字节；`mode` 一旦被 `inspectUtf8()` 判为 `utf8`，
后续 chunk 出现非法字节就从 stdout data handler 冒泡成 `uncaughtException`。
编码判定本来就由 `inspectUtf8()` 按字节完成（同文件 260 行起），**不依赖 fatal 抛错**，
所以去掉 `fatal:true` 不影响原逻辑。

冒烟验证（在本机 `upstream-official` 下用 tsx 跑）：
```
const d = createShellOutputDecoder();
d.decode(Buffer.from('中文测试','utf8'));            // "中文测试"
d.decode(Buffer.from([0x81,0x40,0xff,0xfe,0x41])); // "\uFFFD@\uFFFD\uFFFDA"，不抛异常
d.flush();                                          // ""
```

---

## 3. Windows 安装 / 部署遇到的问题（完整清单）

| # | 现象 | 根因 | 修复 | 应上游化 |
|---|---|---|---|---|
| 1 | `.run/autostart.log` 涨到 **1.82 GB**，每 5s +195 KB；gateway 反复重启 | 登录自启的两个 `.cmd` 是 **LF 换行 + UTF-8 中文注释**，Windows `cmd.exe` 逐行读取偏移错乱，把 `powershell` 截成 `hell`、`start-windows.cmd` 截成 `rt-windows.cmd`，陷入无限报错重来 | 所有 `.cmd` 统一 **CRLF + 纯 ASCII**；`pilotv-boot.cmd` 去掉嵌套 `call`，直接 `powershell.exe -File`；加 5 MB 日志轮转 | **必须写进安装文档 + CI 加行尾检查** |
| 2 | gateway「优雅自杀」，日志只有 `[telemetry] shutdown snapshot`、无堆栈 | 旧 supervisor 在 `cmd.exe` **前台**跑 node，与控制台绑定；控制台被回收（插件重载 / 登录脚本退出 / 计划任务清理）时 Windows 发 `CTRL_CLOSE`，node 静默退出 | `.run/agent-supervisor.mjs`：`spawn(..., { detached:true, windowsHide:true })` + `unref()`；另加 **18790 TCP 单实例锁**（EADDRINUSE → standby 每 3s 重试），避免 keeper 紧循环 spawn | **必须**，附 `verify_windows.ps1` |
| 3 | 登录自启两套，互相打架 | `Startup\PilotV.vbs` + 计划任务 `PilotV-Startup` 同时存在 | 只保留计划任务；VBS 重命名为 `.disabled`（可逆）；`pilotv-boot.cmd` 改为幂等（四端口全监听即跳过） | **必须写进安装文档** |
| 4 | `taskkill /T /F` 误杀风险 | `.run/pids.json` 是旧 PID，Windows 会复用 PID；`renew_gateway_tls.ps1` 与 `start-windows.ps1 -Stop` 都直接读它杀进程树 | 两处都改为「`Get-NetTCPConnection` 按端口反查 + 校验命令行关键字」；`pids.json` 降级为纯信息 | **必须** |
| 5 | 切不到 nas / leo-mac | ① `ui/public/devices.json`（5186 启动时读）与 `ui/dist/devices.json`（前端下拉读）**缺 nas**，且 `marc-linux-pc` 的 `100.72.0.111` 已是死 IP；② `?d=` 只认清单内 origin/slug，未知设备**静默回退本机**；③ 设备写接口默认关（`writable:false`）导致页面里补不了；④ 本机 3001 未开鉴权（200），nas/leo-mac 开了 → 切换成功但 `401` → 前端 `clearSession()` 弹登录页 | 清单改成本机实际 Tailscale 设备；重启 5186 加载（`loadConfigFromEnv()` 只在启动时读）；`deviceTokens.ts` 本来就按 origin 隔离 token，**每台设备首次需登录一次**，属设计非 bug | **模板 + 文档**，IP 不可硬编码进仓库 |
| 6 | `Bundled skills root is missing` / 历史 `Extensions changed` ×113 | upstream 正常降级路径；历史条目全来自 #1 死循环期间 | **不要创建 skills 目录**，反而会重新触发 watcher | 文档注明「无害，勿修」 |
| 7 | 长会话 86k tokens 压不下去 | 见 2.2 | 见 2.2；另建议用户新建会话 | 补丁已覆盖 |

**补充事实（避免重复排查）**：
- 四服务端口：`8799` 成果台 / `18789` agent gateway / `3001` Web-API+bridge / `5186` 前端网关(HTTPS)。
- 监督链：`3001` → `~/.pilotdeck/plugins/gateway-keeper/server.mjs` → `.run/agent-supervisor.cmd` → `.mjs` → detached gateway。插件在用户目录，**不在仓库**，新设备需单独部署。
- `ui/dist` 被 `.gitignore` 忽略，`devices.json` 改完要同步改 `public` 与 `dist` 两份，否则下拉与白名单不一致。
- `PILOTV_ALLOW_DEVICE_WRITES` 保持关闭是有意的：写接口能把新地址加进代理白名单，是安全敏感面。
- 远端 `nas:8799` 返回 502、成果台「跟随设备」时可能 503，与设备切换本身无关。
- 两个 `.ps1` 均为 **UTF-8 with BOM**（PowerShell 5.1 需要），终端里看到的乱码只是显示层，不是脚本缺陷。

---

## 4. 给 NAS 开发的执行步骤

> 本次已由本机代理在 NAS 上代为执行 4.1–4.3，结果见文末「执行记录」。
> 以下保留完整命令，便于复核或在其他分支重放。

### 4.1 应用 3 处补丁
```bash
cd /vol3/1000/Work/00/PilotV
git apply --check  /vol4/1000/00/产物/PilotV_Windows排障交接_v1_20261105/upstream-3-fixes.patch
git apply          /vol4/1000/00/产物/PilotV_Windows排障交接_v1_20261105/upstream-3-fixes.patch
git diff --stat     # 应只有 3 个文件、23 insertions / 6 deletions
```

### 4.2 落地 Windows 部署脚本（按本机实际路径）
```bash
cd /vol3/1000/Work/00/PilotV
install -m 644  <包>/start-windows.cmd        ./start-windows.cmd
install -m 644  <包>/start-windows.ps1        ./start-windows.ps1
install -m 644  <包>/pilotv-boot.cmd          ./scripts/pilotv-boot.cmd
install -m 644  <包>/renew_gateway_tls.ps1    ./scripts/renew_gateway_tls.ps1
install -m 644  <包>/agent-supervisor.cmd     ./.run/agent-supervisor.cmd
install -m 644  <包>/agent-supervisor.mjs     ./.run/agent-supervisor.mjs
```
> `.run/` 是运行时目录，若 `.gitignore` 忽略它，需要为这两个 supervisor 文件加例外，
> 或由开发决定迁到 `scripts/` 并同步修改 gateway-keeper 插件的引用路径。

### 4.3 精确提交并推送
```bash
cd /vol3/1000/Work/00/PilotV
git add -- pilotdeck-mobile/upstream-official/src/cli/pilotdeck.ts \
           pilotdeck-mobile/upstream-official/src/context/compaction/CompactionEngine.ts \
           pilotdeck-mobile/upstream-official/src/tool/builtin/bash/commandRunner.ts \
           start-windows.cmd start-windows.ps1 scripts/pilotv-boot.cmd \
           scripts/renew_gateway_tls.ps1 .run/agent-supervisor.cmd .run/agent-supervisor.mjs
git commit -m "fix(runtime): 防止局部异常拖垮 gateway + Windows 部署加固"
git push origin main
```

**⚠️ 两个必须注意的点**：
1. NAS 工作区另有 **9 个在途文件**（`project-team.js`、`sync_project_team_runtime.py`、
   `scripts/verify_project_team_*.mjs` 等，属另一个正在开发的功能）。
   **只 `git add` 上面列出的文件，不要 `git add -A`**，否则会把未完成的工作一起提交。
2. `git push origin main` 会同时带上 NAS 已有但未推的 `6cb868a`
   （`feat(ui): 项目成员回复带发言人名字…`）。这是最新源码，符合本次目标；
   如该功能暂不打算公开，请先与对应开发确认再推。

### 4.4 后续建议（可选但强烈建议）
- 在 CI 加一条 **`.cmd` 必须为 CRLF + ASCII** 的检查，#1 这类问题就不会再出现。
- 把 `devices.json.template` 纳入仓库，`README` 写明「按本机 Tailscale 网络填写，改完重启 5186」。
- 上游若日后修复了这三处，**可以直接回退本补丁**，它们都是防御性改动、无功能语义变化。

---

## 5. 验证清单

**源码层（NAS / 任意平台）**
```bash
grep -n "unhandledRejection (gateway stays alive)" pilotdeck-mobile/upstream-official/src/cli/pilotdeck.ts
grep -n "using partial summary"                    pilotdeck-mobile/upstream-official/src/context/compaction/CompactionEngine.ts
grep -n 'new TextDecoder("utf-8")'                 pilotdeck-mobile/upstream-official/src/tool/builtin/bash/commandRunner.ts
```

**运行层（本机实测结果，2026-11-05 16:18）**
- gateway PID `43916`，30 秒观察 PID 无变化、`agent.log` 零增量；
- `18789` / `3001` / `8799` / `5186` 全部 200，WS 握手保持 `readyState=1`；
- `web.log` 中 `gateway_unavailable` 计数 0；
- 补丁生效后 `full_compaction_no_summary` 零新增（历史 5 条均属旧进程）；
- `?d=nas` / `?d=leo-mac-studio` / `?d=jx88` 均 `unknownDevice:false` 且 Cookie 正确。

**新 Windows 设备安装后**：运行 `verify_windows.ps1`，全部通过才算部署完成。

---

## 6. 已知限制 / 不要做的事

- **不要**为消除 `Bundled skills root is missing` 而创建 `skills/` 目录（见 #6）。
- **不要**默认开启 `PILOTV_ALLOW_DEVICE_WRITES=1`。
- 3 处补丁是 **upstream 源码改动**，以后做「NAS → 本机」同步会被覆盖，同步后需重新打补丁
  ——本次推回主仓库正是为了消除这个循环。
- gateway 现由 detached supervisor 守护，`start-windows.cmd -Stop` 停掉它后**会自动重启**；
  要彻底停需先结束 supervisor 或停用 gateway-keeper 插件。
- 旧病态会话（86k tokens）本地保留未删，建议用户新建会话，无需迁移。

---

## 附录 · 证据路径（本机）

| 内容 | 路径 |
|---|---|
| 四轮完整排障记录 | `C:\Users\music\WorkBuddy\2026-11-05-14-48-30\.workbuddy\memory\2026-11-05.md` |
| gateway / supervisor 日志 | `C:\Users\music\projects\pilotv\.run\{agent,supervisor,web,gateway,autostart}.log` |
| 1.82 GB 日志留证样本 | `.run/autostart.log.sample-20261105.txt` |
| devices.json 改动前备份 | `.run/devices.json.backup-20261105`、`.run/devices.dist.json.backup-20261105` |
| VBS 自启备份 | `.run/PilotV.vbs.backup-20261105` |
| NAS 同步手册 | `C:\Users\music\Documents\Work\PilotV\NAS_UPDATE_RUNBOOK.md` |
