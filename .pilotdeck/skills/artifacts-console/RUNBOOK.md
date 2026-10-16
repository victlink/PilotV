# 成果台运维手册（RUNBOOK）

给「改成果台的人」和「值班救火的人」。面向使用者的说明在
`.pilotdeck/skills/artifacts-console/SKILL.md`；设计论证在 `.HANDOFF-artifacts-console.md`。

---

## 0. 人怎么打开它（先看这节）

| 要做的事 | 命令 / 地址 |
|---|---|
| 打开成果 | **在 PilotV 里**：顶部切到「成果」tab，列表只列当前会话的成果（`http://$(tailscale ip -4 \| head -1):5186/`，本机当前是 `100.90.196.104`，会变） |
| 单个成果的直链 | 暂时没有 —— 成果视图是应用内状态，要先切到对应会话和成果。侧车 `8799` 只提供 API，不提供页面 |
| 登录 | 页面自带登录框；改登录口令见 §0.3 |
| 机器调 API | `Authorization: Bearer $ARTIFACTS_TOKEN`，token 在 `~/.config/pilotv-artifacts/token`（`chmod 600`） |
| 起 / 重启 console | `systemctl --user restart pilotv-artifacts.service`（unit 跑的是 `/home/marc/pilotv-artifacts/`，不是本仓库） |
| 起 / 停侧车 | `./start-sidecar.sh [start\|status\|restart\|stop]`（监听 `127.0.0.1:8801/api/artifacts-mcp`） |
| 自检（远端视角 10 项） | `python3 scripts/verify_tailscale_access.py` |
| 自检（浏览器真实路径 8 项） | `python3 scripts/verify_login_flow.py`（必须从非回环地址跑，回环是鉴权豁免区，测不出未登录分支） |
| 自检（MCP 握手 + 真调用） | `python3 scripts/verify_mcp_sidecar.py` |
| 自检（真截一张首屏图） | `python3 scripts/shoot_console_home.py /tmp/x.png` |
| **改登录口令** | 页面右上角 ⚙ → 「修改登录口令」，见 §0.3 |

### 0.0 （历史）旧成果台页面为什么可以匿名打开

> 这一节描述的是**已经删掉的** `artifacts.html` 独立页面。成果视图现在在 PilotV
> 前端里，没有自己的登录闸门。下面保留原文只为解释历史，别照着改。

console 没有登录页，未登录时任何受保护路径只回一行 `{"error": "unauthorized"}` 的 JSON ——
人打开链接只看到这行字，根本没法登进去。所以：

- 页面三件套（`artifacts.html` / `.css` / `.js`，**空壳，不含任何成果数据**）在
  `mount()` 里被加进 console 的免鉴权白名单（`artifacts_console.py:_open_page_assets`，
  改的是 console 模块的 `OPEN_PATHS`）。
- 页面里带登录闸门（`#artGate`）：任何 API 返 401 就弹出登录框，
  `POST /api/login` 拿到 Cookie 后整页重载。
- **数据仍然全走 `_guard()` 的 Cookie / Bearer / 回环三道鉴权。页面公开 ≠ 数据公开**：
  匿名 `GET /api/artifacts` 依旧是 401，这条在 `verify_tailscale_access.py` 里钉着。
- 注意回环豁免：在本机用 `http://127.0.0.1:8799` 打开永远不需要登录（那不是 bug），
  要验未登录行为必须走 Tailscale 地址。

### 0.1 为什么以前「起了却用不了」

三个坑叠在一起，缺一个都表现成「页面能开、数据全空 / 一片红」：

1. **只监听回环**。`/tmp/art-config.yaml` 里是 `bind: [loopback, tailscale]`，
   写成 `[loopback]` 时 Tailscale 上打不开（连不上，不是 401）。
2. **鉴权变量没设**。`CONSOLE_SESSION_SECRET` 不设 → 每次重启会话密钥都换，所有人当场掉线；
   `ARTIFACTS_TOKEN` 不设 → 只有 Cookie 和回环两条路能用。console **不读** `console.env`，
   变量必须由 `scripts/start-console-tailscale.sh` 显式传进去。
3. **Cookie 鉴权曾经静默失效**（已修）。console 以 `python3 console_server.py` 启动时，
   `sys.modules` 里的模块名是 `__main__`，而路由层只查 `console_server`，
   于是「浏览器 Cookie」这条鉴权路径永远不命中 —— 页面开得了，`/api/artifacts` 全 401。
   修法见 `artifacts_console.py:_console_module()`。

### 0.2 8899 是联调端口，不是 console

`scripts/serve_test.py --port 8899` 是回归用的独立进程。**任何指向 console 的地址都该是 8799**：

- `ARTIFACTS_API`（MCP 侧车转发目标）必须是 `http://127.0.0.1:8799`
- `ARTIFACTS_NOTIFY_BASE_URL` 默认已改成 `http://127.0.0.1:8799`

某份宿主会话里的 MCP 配置写着 8899，表现为一调工具就 `fetch failed`。正路是改那份配置；
改不了时可以起个字节转发垫片当过渡：`python3 scripts/port-forward-8899.py [start|stop|status]`。

### 0.3 改登录口令（页面上的 ⚙）

顶栏最右边那个 ⚙ 就是设置入口，常驻，不会被侧栏收起藏掉。点开是一张右侧抽屉：

- **当前账号**：用户名、登录方式（网页 Cookie）、成果总数、API 令牌与 IM 推送**只显示「有没有配」**。
  值一律不回显 —— 页面是公开空壳，回显等于把钥匙挂在门上。
- **修改登录口令**：当前口令 / 新口令 / 再输一遍。至少 10 位，不能与旧口令或用户名相同。
- **退出登录**：只清这台设备的 Cookie。

四个刻意的设计，改之前先想清楚：

1. **只认 Cookie。** 改谁的口令由 Cookie 决定，不看请求体里传什么用户名。任何登录用户
   都改不了别人；持有 `ARTIFACTS_TOKEN` 的 agent 也改不了（token 只能登记/读成果）。
2. **必须再验旧口令。** Cookie 可能留在别人机器上（笔记本合盖、浏览器没关）。
   回环豁免同理：`127.0.0.1` 直连也不能改口令。
3. **口令怎么存不另起一套**：直接复用 console 的 `hash_password` / `save_users`，
   用户库权限维持 `0600`。审计里只留「谁改的」，绝不记口令。
4. **改口令 ≠ 踢人。** Cookie 由 `CONSOLE_SESSION_SECRET` 签名，不随口令变化 ——
   其它设备上已登录的会话**仍然有效**，界面上写明了这点，不装作已经收回。要彻底收回：
   轮换 `CONSOLE_SESSION_SECRET`（会让所有人重新登录），或删掉该账号重建。

跨站还有一道服务端校验：带 `Origin` 且对不上 `Host` 的改口令请求直接 403。
第一道闸其实是 Cookie 的 `SameSite=Lax`（跨站 POST 压根不送 Cookie），
这道是防「哪天属性被放宽」和「同机另一个端口起了个恶意页面」。
不带 `Origin` 的请求（curl、回归脚本、agent）照样放行 —— 它们本来就不是浏览器，
一刀切挡掉只会让自检没法跑。

> ⚠️ `.artifacts-secrets.env` 里的 `ARTIFACTS_CONSOLE_PASSWORD` **只是当初建号时留下的记录值**，
> 启动链路上根本没有代码去读它写回用户库。console 只在**用户库为空**时才 bootstrap
> （`console_server.py`：`if not load_users(): bootstrap_admin()`，而且认的是 `CONSOLE_ADMIN_*`）。
> 所以页面上改完口令，重启**不会**把你覆盖回去 —— `scripts/verify_settings.py` 第 [9] 组就是专门
> 重启一次来验这件事的。但那个文件里的字面量从此是**过期值**：自检脚本登录会 401，
> 失败时会直接告诉你这一点并教你怎么办。

两个自检脚本都跑在**隔离 console** 上（`scripts/isolated_console.py` 自起进程、独立的
用户库与数据目录，退出即销毁），永远不会碰生产 `artifacts` 账号：

| 自检 | 命令 | 覆盖 |
|---|---|---|
| 改口令后端 | `python3 scripts/verify_settings.py` | 28 项：匿名 / token 被拒 / 旧口令错 / 弱口令 / 不一致 / 同旧 / 同用户名 / 改成功后旧口令失效 / 新口令可登 / 别的账号不受影响 / 用户库 0600 / 审计无明文 / 跨站 403 / 同源不误伤 / **重启后新口令仍在** |
| 面板页面级 | `python3 scripts/verify_settings_ui.py` | 18 项：入口可见 / 账号读到 / 无密钥明文 / 错误提示 / 前端先拦 / 真改成功 / 两种关闭方式 |

---

## 1. 跑起来

### 1.1 正常情况：跟着 console 一起起

成果台是 `mount()` 进 console 的（`artifacts_console.py:mount`），**它自己没有入口脚本**。
console 起的时候顺手就有了：

```
PilotV 前端 (:5186) ──网关──> 侧车 (默认 8799) ──> /api/artifacts/*
```

旧结构（已下线）：

```
console (默认 8799) ──mount──> /artifacts.html + /api/artifacts/*
```

带鉴权变量、带 Tailscale 监听的重启用 `scripts/start-console-tailscale.sh`（见 §0），
别再手敲 `python3 console_server.py`——那样重启后必然掉线。

### 1.2 独立部署：每台设备各装一套

不跟 console 走，自己当独立服务跑（数据不出本机）：

```bash
python3 scripts/install_device.py --check-only      # 先体检：缺什么、缺了会怎样
python3 scripts/install_device.py --systemd         # 装 + 打印 systemd 单元
ARTIFACTS_DATA_DIR=~/.local/share/artifacts \
  python3 scripts/artifacts_service.py --port 8801  # 本机自用
```

- **别拿 `scripts/serve_test.py` 当生产服务。** 它自己就写明是「页面回归用的一次性
  服务」，不带 console 登录态、默认只绑回环、还带着一套路由自检断言 ——
  将来改回归脚本就会改到线上进程。
- 绑到非回环地址**必须**有 token，否则启动器直接拒绝（rc=2），不给「先跑起来再说」
  留口子。token 建议放文件里用 `--token-file`，别塞命令行（`ps` 和 shell 历史都看得见）。
- 安装器写的是**本机**插件清单（`~/.pilotdeck/plugins/artifacts/plugin.json`），
  url 固定 `127.0.0.1:<port>`。多台设备各装各的，互不相通。
- Chromium 的查找规则很绕（先翻 Playwright 缓存目录，再找 PATH 上几个名字），
  安装器直接调 `artifacts_cdp._chrome_binary()` 复用同一份实现 —— 别另抄一份清单，
  抄一份的结果就是「体检说缺、跑起来却好好的」。

### 1.3 开发/回归：单起一个只有成果台的进程

```bash
cd /home/marc/pilotv-artifacts
python3 scripts/serve_test.py --port 8899   # 联调/回归端口，别拿它当 console 地址
# 会自检三条静态路由有没有注册上，少一条就 assert 挂掉
```

### 1.4 MCP 侧车（让 agent 有工具用）

```bash
./start-sidecar.sh            # 幂等启动；已在跑直接返回
./start-sidecar.sh status
./start-sidecar.sh restart
./start-sidecar.sh stop
```

### 1.5 一次全量回归

```bash
bash scripts/run_all_verify.sh            # 15 个套件
bash scripts/run_all_verify.sh --only M3  # 只跑名字含 M3 的
```

它自己会做三件事，**不要手动预跑服务**：隔离数据目录 `/tmp/artifacts-regress-data`、
随机端口起 console 和侧车、逐个跑 `scripts/verify_*` 并汇总。跑完服务与侧车都会收掉。

### 1.5.0 「实时」标记的真实坑

会话级 `live` 的**唯一**事实源是 `pilotdeck_workspace._project_entry()` 里那行
`stub["live"] = stub["age"] <= LIVE_WINDOW`（`ARTIFACTS_LIVE_WINDOW` 默认 180 秒）。

`_read_session()` **不要**再返回 `live` 字段。原因是 `_resolve()` 是
`out.update(info)`，会把 stub 上算好的值盖掉。原来 `_read_session()` 里放了个
`"live": False` 占位（注释还写着「由 _project_entry 覆写」），实际顺序正好反过来，
于是**左栏的「实时」标记从上线起就没亮过** —— 5 秒前刚写的会话也显示成不实时。

要改这条判定时记住：判据只有 mtime 和 `pending-inputs/<sid>.json` 里的 `paused`，
别在别处再存一份 `live`。

### 1.5.1 验收绝不许写正式库

正式库现在有 **416 条**，左栏曾被几百条测试成果淹没，根因就是「跑验收」把
`shot.png` / `plan.svg` 直接灌进了 `.artifacts-data`。现在有三道闸：

1. **`scripts/_test_guard.py`**：每个 `verify_*.py` 跑之前都会问服务端
   `/api/artifacts/health` 的 `data_dir` 是不是测试目录。是正式目录就**拒绝执行并
   返回 rc=3**，而不是默默写进去。确实要写才加 `--force`。
2. **`start_server()` 自起服务时强制隔离**：不给 `ARTIFACTS_DATA_DIR` 就现造一个
   临时目录。漏了这一行，`serve_test.py` 会退回项目里的 `.artifacts-data`。
3. **自己起服务时要传 `--api`**，别让脚本去连默认的 `8799`（那正是正式成果台端口）。

> `main()` 的返回值必须交给 `SystemExit`。直接写 `main()` 会把护栏的 `return 3`
> 丢掉、退出码恒为 0，回归脚本会以为这套「通过了」。

### 1.5.2 想清正式库里的历史数据

**默认只报告，不删。** 删不删是人的决定，不是脚本的自作主张：

```bash
python3 scripts/purge_test_artifacts.py                    # 看看哪些像测试件
python3 scripts/purge_test_artifacts.py --include-dups     # 再看哪些是重复件
python3 scripts/purge_test_artifacts.py --dry-run --apply  # 试算，仍然不删
python3 scripts/purge_test_artifacts.py --apply --yes      # 真删
```

它保证：**带标注的记录一条不删**、`stored_path` 指向数据目录之外的一律不碰、
重复件只留最新一条。没给 `--apply` 或 `--yes` 时只输出清单。

---

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARTIFACTS_DATA_DIR` | `<repo>/.artifacts-data` | 成果库（sqlite）+ 产物副本所在目录 |
| `ARTIFACTS_WATCH_DIRS` | 空 | 启动时自动挂上的监控目录，`:` 或 `;` 分隔 |
| `ARTIFACTS_WATCH_INTERVAL` | `15` | 目录扫描间隔（秒） |
| `ARTIFACTS_TOKEN` | 空 | 跨机调用的 Bearer token；回环直连免登录 |
| `ARTIFACTS_NOTIFY_WEBHOOK` | 空 | IM 机器人 webhook。**不配 = 完全不推** |
| `ARTIFACTS_NOTIFY_SECRET` | 空 | 机器人「签名校验」密钥（可选，配了自动挂 sign） |
| `ARTIFACTS_NOTIFY_EVENTS` | `artifact.added,artifact.status,artifact.dispatched` | 推哪几类事件 |
| `ARTIFACTS_NOTIFY_AGENTS` | 空（=全推） | 只推这些 agent 的成果，逗号分隔 |
| `ARTIFACTS_NOTIFY_BASE_URL` | `http://127.0.0.1:8799` | 消息里链接用的公网地址（不是 8899，见 §0.2） |
| `ARTIFACTS_AUTOWATCH_PROJECTS` | `1` | 自动把每个项目的工作目录挂成监控目录（见 §2.2） |
| `ARTIFACTS_SESSION_INTERVAL` | `20` | 会话自动收录的轮询间隔（秒） |
| `ARTIFACTS_SESSION_BACKFILL` | `0` | 是否回灌历史会话产物。**默认关**，见 §2.2 |
| `ARTIFACTS_SESSION_MAX_AGE_DAYS` | `14` | 回灌时的限龄：只收这么多个天内的产物 |

### 2.2 自动收录：产物为什么不用手动 publish 也会出现

成果台有两条自动收录通道，都是「结构性的」——不需要 agent 记得调用
publish：

1. **会话收录**（`SessionIngester`）：每 20 秒扫一遍各项目的
   `chats/*.jsonl`，把里面的 `file_artifacts` 行收成成果。**归属精确到
   `run_id`**，不会张冠李戴。
2. **目录监控**：自动把每个项目的工作目录（`projects/*/.cwd`）挂上，
   挂载之后新写/新改的产物自动进成果台。这条补的是会话记录抓不到的洞
   ——Blender 走 ssh、MCP server 跑在别的机器时，产物是直接落到磁盘的，
   运行时压根没跟踪到，transcript 里也没有 `file_artifacts`。

两条通道共用同一份 `watch_sources` 账本（按 path + sha1 去重），所以
手动 publish 和自动收录撞上同一份文件时只会出现一条，不会重复。

**关掉自动收录**（排查异常时）：

```bash
export ARTIFACTS_AUTOWATCH_PROJECTS=0   # 关目录自动挂载
export ARTIFACTS_SESSION_BACKFILL=0     # 关会话收录（默认就是关的）
```

**为什么回灌历史默认关**：这台机器上可回灌的历史产物有 2452 个，其中位
年龄 83 天、p90 618 天，绝大多数是 `~/项目/VICTLINK-AI`、`~/项目/CAD`
两个无关老项目的构建产物。首屏就倒灌，等于把用户真正在做的成果淹在底下。
确实要回灌就显式打开，并限龄：

```bash
export ARTIFACTS_SESSION_BACKFILL=1
export ARTIFACTS_SESSION_MAX_AGE_DAYS=7    # 实测 7 天 → 37 条，30 天 → 581 条
```

### 2.3 两条自动通道都盖不住的洞

产物写在**任何项目工作目录之外**时，两条通道都收不到。例如 3D 会话的
Logo 产物实际写在 `~/PilotV/常用资料/PilotV-Logo-3D/`（3D 项目目录之外），
而 transcript 里只记录了驱动脚本 `pilotv_3d_build.py` —— 这种只能显式
publish：

```bash
python3 scripts/artifacts_cli.py publish \
  --kind image --title "PilotV Logo 三维效果图" \
  --path "$HOME/PilotV/常用资料/PilotV-Logo-3D/PilotV-Logo-3D.png" \
  --run-id "web:<session-id>"
```

### 2.1 接 IM（飞书 / Lark / 任何吃 webhook 的群机器人）

```bash
export ARTIFACTS_NOTIFY_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxxx'
export ARTIFACTS_NOTIFY_BASE_URL='https://pilotdeck.internal'   # 消息里点得开
export ARTIFACTS_NOTIFY_AGENTS='pilotdeck,opencode'             # 可选，挡掉测试噪音

# 验一下配没配对（同步发一条）
curl -s -X POST http://127.0.0.1:8799/api/artifacts/notify/test \
  -H 'Content-Type: application/json' -d '{"text":"成果台通道测试"}'

# 看通道状态：送达/失败/丢弃计数、最近一次错误
curl -s http://127.0.0.1:8799/api/artifacts/notify
```

推的文案长这样：

```
[成果台] opencode · page · v2
「登录页」→ 待返工（按钮对比度不够）
https://pilotdeck.internal/          # 成果页在应用内，切到那个会话 + 那条成果即可
```

**推送永远不会拖垮成果台**：事件回调只入队，HTTP 发送在线程里；webhook 挂了只是
`failed` 计数 +1，发布照样成功。队列满（200）时丢通知而不是堵住请求。

> 交接文档原本让「复用 `im_bot` 飞书」，但这台机器上找不到 `im_bot`（`/vol3/1000/Work` 全树 0 命中），
> 所以实现成了通用 webhook 通知器（`artifacts_notify.py`）。飞书自定义机器人原生吃这个 payload，
> 配置即用；`im_bot` 哪天回来了，把 `_post()` 换成调它的 send 就行，其余不动。

---

## 3. 目录结构

| 文件 | 职责 |
|---|---|
| `artifacts_store.py` | sqlite schema、版本链、状态机、审计、EventBus |
| `artifacts_console.py` | REST/SSE 路由、物化器、目录 watcher、页面托管 |
| `artifacts_notify.py` | IM webhook 通知器（M4） |
| `artifacts_cdp.py` | Chromium CDP：页面截图、selector 重锚 |
| `artifacts_deliver.py` | 成果判定（只收最终成果）、`.parts.json` 部件树、返工单落地、文字编辑 |
| `artifacts-mcp.mjs` | MCP 侧车（4 个工具） |
| `pilotdeck-mobile/.../app-shell/ArtifactStage.tsx`、`ArtifactsConsolePane.tsx` | 成果页（预览 + 标注），旧 `artifacts.html/css/js` 已删 |
| `static/vendor/model-viewer.min.js` | 三维渲染器本地副本（成果台常在内网/离线机器上看，拉不到 CDN） |
| `scripts/verify_*.py\|mjs` | 验收套件；`run_deliverables_verify.sh`（REST）+ `run_gestures_verify.sh`（真浏览器手势）是需求 1-5 的主验收 |
| `scripts/make_mini_pdf.py` | 手搓最小合法 PDF（图纸验收用；本机没装 reportlab/fpdf） |
| `scripts/artifacts_cli.py` | 外部 agent / 人的 REST CLI（publish/import/wait/...） |

### 1.5.3 只想验需求 1-5

```bash
bash scripts/run_deliverables_verify.sh   # 纯 REST：发布拦截/部件/文字/三条通道
bash scripts/run_gestures_verify.sh       # 真 Chromium：手势/编辑/渲染/应用
```

两套都自带隔离数据目录与隔离 `PILOTDECK_HOME`，**不会碰真实 `.artifacts-data` 和真实会话**。

---

## 4. 出问题先看哪里

| 症状 | 先查 | 通常原因 |
|---|---|---|
| 卡片出不来看不见 | `GET /api/artifacts/health` | 服务没挂 `mount()`；或页面路由少了逗号静默失效 |
| 卡片一直是骨架 | `/api/artifacts/<id>` 的 `status`/`meta` | 物化队列卡住（看 `health` 的 `materialize_queue`）；页面类要给 `url` 才会截图 |
| 标注坐标飘了 | 审计里有没有 `annotation.added` | 页面改版后 selector 失配 → 用 `POST /api/artifacts/<id>/reanchor` 重锚 |
| watcher 不发布 | `GET /api/artifacts/watch` | 文件 < 512B、临时后缀（`.tmp/.swp`）、`node_modules/.git` 会被有意忽略 |
| IM 没消息 | `GET /api/artifacts/notify` | `enabled=false` = 没配 webhook；`last_error` 会写明原因；`dropped>0` = 队列积压 |
| 返工没人接 | `GET /api/artifacts/wait-rework?aid=...` | agent 必须自己挂着；`woke=false` 是超时没人返工，不是错误 |
| 发布返回 409「这不是一份独立最终成果」 | 响应的 `verdict` / `reason` | 判成了附属产物（元素截图/图标/缩略图）。真要收就加 `deliverable:"aux"` |
| 三维一直显示「三维渲染器没加载」 | 浏览器控制台、`static/vendor/` 在不在 | 渲染器是**异步加载**的，就绪判断以 `customElements.get('model-viewer')` 为准；别用「模块同步引好了」做假设 |
| 图纸/模型没有部件树 | 主文件旁的 `<名>.parts.json` 在不在 | 清单必须与主文件**同名同目录**；可拆扩展名只有一份清单 `artifacts_deliver.SPLITTABLE_EXT`（`.pdf` 在里面） |
| 文字改了但页面没变 | `GET /api/artifacts/<id>/text` 的 `updated_at` | 保存写在成果台副本上；确认没被页面缓存（url 带 `_=<updated_at>`） |
| 「确认提交」报「没归到任何项目/会话」 | 成果的 `project` / `run_id` | 发布时没带，或会话已不在。**已入队/已唤醒 ≠ agent 已改完**，要确认用 `wait-rework` |
| 返工单在项目目录里，但对话里没动静 | 是不是靠的第 2 条通道 | `pending-inputs` 是**一次载入**的旁挂文件，运行中的会话不重读（`pilotdeck-bridge.js` 的 `state.queueLoaded`）。即时唤醒只走 `wait_artifact_rework`；要跨会话交接就让 agent 去项目目录取返工单 |

---

## 5. 加东西时的规矩

1. **别让推送/物化/缩略图阻塞请求**。慢活一律进队列 + 后台线程。
2. **外部 agent 只走 REST 契约**（`/api/artifacts*`），不要为单个 agent 开特例端点。
3. **新增验收必须能离线跑**：`run_all_verify.sh` 末尾是**显式清单**，不是自动发现 ——
   加了新套件要在 `run_deliverables_verify.sh` / `run_gestures_verify.sh` 之后手动补一行。
   断言**不准依赖库里已有数据**——自己种，否则换台机器/清过库就挂（已经栽过两次）。
4. **判定通过只看退出码**，别用管道尾部的退出码（`timeout ... | tail` 会骗人，已栽过）。
5. 改了前端就重跑 `verify_diff_ui.py` / `verify_agent_ui.py` / `verify_page.mjs`（真 Chromium，不目测）。

---

回复时间：2026-10-09 15:17:09 (Asia/Shanghai)