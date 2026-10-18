# PilotV

> agent 做完的东西，在这里被看见、被评审、被返工，直到改到通过。

PilotV 是一套**可搬走的成果台**：把「PilotDeck 宿主（人在里面对话、agent 在里面干活）」和
「成果台（成果、评审意见、返工闭环）」缝在一起。一台机器 `./start.sh` 就能跑起来，
不依赖任何外部宿主项目。

| 部件 | 是什么 | 位置 |
|---|---|---|
| 前端 | 上游 [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck) 的 Web UI（PWA，AGPL-3.0），整份 vendor 进仓，PilotV 在其上叠加成果台面板、设备切换、品牌与移动端适配 | `pilotdeck-mobile/upstream-official/` |
| 成果台 | 本仓自研：Python + aiohttp + SQLite，37 条 REST 路由，运行时只依赖 `aiohttp` | 根目录 `artifacts_*.py` |
| 网关 | Node 零运行时依赖，把同一个前端按 Cookie 转发到任意一台设备后端 | `service/pilotv_gateway.mjs` |
| MCP 侧车 | 薄薄一层 Node（313 行，只做「MCP 工具调用 → REST」翻译），把成果台包成 4 个 MCP 工具给 agent 用 | `artifacts-mcp.mjs` |

## 它要解决的六件事

| 问题 | 做法 | 代码位置 |
|---|---|---|
| 成果散在各个目录，看不出改到哪一步 | 单一成果库：文件、版本链、状态、标注、审计全部落 SQLite | `artifacts_store.py` |
| 左栏被中间产物塞爆 | 发布前判 `final` / `aux`：网页零件（切片、图标、缩略图）默认拒收，要收得显式写 `deliverable: "aux"` | `artifacts_deliver.py:classify()` |
| STEP / IGES / STL 喂给 model-viewer 是一片空白 | 转 GLB 并缓存；转换跑在隔离 venv 子进程里，没装转换器时如实报 `CadUnavailable`，不静默失败 | `artifacts_cad.py` + `scripts/cad_to_glb.py` |
| 页面一改版，标注意图就飘了 | 锚点双存：`anchor.selector`（DOM）+ `anchor.rect`（归一化 0-1 兜底），改版后用 CDP 重新量一次 | `artifacts_cdp.py` |
| 点了「应用」之后意见去哪 | 三个通道各自成败独立汇报：原项目目录（按会话分文件夹）、PilotDeck 会话输入队列、dispatch 唤醒 agent | `artifacts_deliver.py` |
| 一套前端怎么连多台设备 | 网关只转发 `devices.json` 里的目标，浏览器不能自带任意地址 —— 不是开放代理；切设备只改一个 Cookie | `service/pilotv_gateway.mjs` |

## 快速开始

前置：**Python 3.10+**（本机实测 3.12.3，更早版本未验证）、**Node 22.13.x**（上游 UI 的 `engines` 卡 `>=22.13.0 <23`）、npm。

```bash
pip install -r requirements.txt                              # 只有 aiohttp
(cd pilotdeck-mobile/upstream-official/ui && npm ci)         # 前端依赖
./start.sh                                                   # 成果台 8799 + 前端/网关 5186
./start.sh --status                                          # 看状态（含 API 可达性）
./start.sh --stop                                            # 停掉本脚本起的进程
```

`start.sh` 会在 `dist/` 缺失或比源码旧时自动 `npm run build`。不想动成果台、只想把前端指到现成实例，用 `./start.sh --no-console`。

## 端口一览

| 端口 | 服务 | 变量 |
|---|---|---|
| 5186 | 前端 + 网关（`start.sh` 默认） | `UI_PORT` |
| 8799 | 成果台 API（`service/serve_artifacts.py`） | `ARTIFACTS_PORT` |
| 8801 | 成果台 MCP 侧车（`./start-sidecar.sh`） | `ARTIFACTS_PORT` |
| 3001 | PilotDeck 后端（默认设备） | `PILOTDECK_BACKEND` |
| 8080 | WeKnora（「资料」页） | `PILOTV_WEKNORA_PORT` |
| 5173 | 上游 vite dev（开发用，不在 `start.sh` 路径上） | — |
| 8765 | `pilotdeck-mobile/gateway` 的 MCP 中继（独立 PWA 项目，见其 README） | `PORT` |
| 8899 | `scripts/serve_test.py` 联调端口 —— **不是** console，任何指向 console 的地址都该写 8799 | — |

## 目录结构

```
artifacts_console.py     成果台 aiohttp 路由层（37 条路由都在这里注册）
artifacts_store.py       存储层：schema / 版本链 / 标注 / 审计 / 事件总线
artifacts_deliver.py     交付物判定、部件树、返工单三通道、文本就地编辑
artifacts_cad.py         STEP/IGES/STL/OBJ/PLY → GLB 的转换器发现与缓存
artifacts_cdp.py         CDP 客户端：真机截图 + 标注重新锚定
artifacts_notify.py      事件 → 飞书/Lark webhook（默认全关，不配就零行为）
pilotdeck_workspace.py   左栏「项目目录 / 会话目录」数据源，直接读 $PILOTDECK_HOME/projects
artifacts-mcp.mjs        MCP 侧车（工具调用 → REST 翻译）
service/                 自宿主服务（serve_artifacts.py）与网关（pilotv_gateway.mjs）
scripts/                 部署、探查、自检、CAD 转换、重命名等工具脚本
pilotdeck-mobile/        自研 PWA + MCP 中继，以及 vendor 进仓的上游 PilotDeck
design/  static/         品牌设计与静态资源
testdata/cad/  demo/     CAD 与演示用样本
console-artifacts.yaml   「挂宿主 console」模式的配置（start.sh 默认走自带 service，不读它）
```

## 成果台的数据模型

`artifacts_store.py` 顶部写死了四条不变量，改这个模块前先读它们：

1. **`parent_id` + `version` 组成版本链**：新版本自动继承父版本 `status=open` 的标注，并在 `carried_from` 记来源 —— 标注跨版本存活，闭环不会在改版时断掉。
2. **标注锚点双存**：`selector` + 归一化 `rect`，两者都在时以 selector 为准。
3. **每次写操作都落 audit 表**，评审动作可追溯。
4. **事件总线**：内存 ring buffer + 每订阅者 `asyncio.Queue`，支持 `Last-Event-ID` 重放。

成果类型 `KINDS`：`page` / `image` / `video` / `drawing` / `model3d` / `doc`。

## REST 接口

全部以 `/api/artifacts` 为前缀。`mount()` 里一共注册 37 条路由，其中 `/api/artifacts/watch`
一个处理函数开了 GET/POST/DELETE 三种方法；注册集中在 `artifacts_console.py:2879` 附近。

| 分组 | 端点 |
|---|---|
| 列表与导入 | `GET /api/artifacts?kind=&status=&agent=&session=&limit=&offset=`、`POST /api/artifacts`、`POST /api/artifacts/import` |
| 单个成果 | `GET /api/artifacts/{aid}`、`/chain`、`/diff`、`/audit`、`/feedback`、`/parts`、`/viewer`、`/files/{name}` |
| 文件与预览 | `GET /{aid}/file/{relpath}`、`/thumb`、`/raw`、`/text`、`/pages/{page}`、`/part-pages/{name}/{page}` |
| 文本就地编辑 | `GET /{aid}/text`、`PUT /{aid}/text` |
| 评审闭环 | `POST /{aid}/annotations`、`PATCH /{aid}/annotations/{nid}`、`DELETE /{aid}/annotations/{nid}`、`POST /{aid}/status`、`POST /{aid}/apply`、`POST /{aid}/dispatch` |
| 标注重锚 | `POST /{aid}/reanchor` |
| 运行态 | `GET /api/artifacts/events`（SSE）、`/health`、`/workspace`、`/wait-rework`、`/me`、`/notify`、`/notify/test`（POST）、`/password`（POST） |
| 目录 watcher | `GET/POST/DELETE /api/artifacts/watch`（`api_watch`，也可只配 `ARTIFACTS_WATCH_DIRS`） |

## agent 侧入口

**MCP 侧车**（`./start-sidecar.sh`，`127.0.0.1:8801`）暴露 4 个工具：
`publish_artifact`、`get_artifact_feedback`、`wait_artifact_rework`、`compare_artifact_versions`。

**CLI 兜底**（MCP 不可用时，零依赖）：

```bash
python3 scripts/artifacts_cli.py publish --kind page --title "落地页" --path src/index.html --url http://127.0.0.1:3001/
python3 scripts/artifacts_cli.py publish --kind image --title "配图 v2" --path out/hero.png --parent art_ab12cd
python3 scripts/artifacts_cli.py feedback art_ab12cd
python3 scripts/artifacts_cli.py status art_ab12cd approved
python3 scripts/artifacts_cli.py import out/ --agent opencode --dry-run
```

## 配置

`start.sh` 的环境变量（完整列表见脚本头部注释）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `UI_PORT` | `5186` | 前端端口 |
| `PILOTDECK_BACKEND` | `127.0.0.1:3001` | PilotDeck 后端 |
| `ARTIFACTS_PORT` | `8799` | 成果台端口 |
| `ARTIFACTS_TARGET` | 本机 `$ARTIFACTS_PORT` | 前端代理的成果台地址，挂远端时才需显式写 |
| `ARTIFACTS_DATA_DIR` | `<项目根>/.artifacts-data` | 成果存储目录 |
| `ARTIFACTS_BIND` | `127.0.0.1` | 改 `0.0.0.0` 必须同时设 `ARTIFACTS_TOKEN`，否则拒绝启动 |
| `PILOTV_ARTIFACTS_HOST` | `service` | `service`=本项目自带；`console`=挂 PilotDeck 宿主 console |
| `ARTIFACTS_WATCH_DIRS` | `design/` | 分号分隔，watcher 自动发布新文件 |
| `PILOTV_WEKNORA_PORT` / `PILOTV_WEKNORA_URL` | `8080` / — | 「资料」页后端 |

鉴权三道闸（`artifacts_console.py:_guard()`）：宿主 Cookie 登录态 → `Authorization: Bearer $ARTIFACTS_TOKEN` → 本机回环直连豁免。凭据放 `.artifacts-secrets.env`（已 gitignore）。

通知（`artifacts_notify.py`）默认全关：`ARTIFACTS_NOTIFY_WEBHOOK`（飞书/Lark 自定义机器人）、`ARTIFACTS_NOTIFY_SECRET`、`ARTIFACTS_NOTIFY_EVENTS`、`ARTIFACTS_NOTIFY_AGENTS`、`ARTIFACTS_NOTIFY_BASE_URL`。推送永不阻塞请求，失败不影响发布。

## 部署

| 脚本 | 干什么 |
|---|---|
| `scripts/deploy_local_runtime.sh` | 本机开发 → 运行时：同步代码到 `~/pilotv-artifacts`（先备份，`data/` 永不覆盖）+ 重建 `dist` + 重启服务 |
| `scripts/deploy_pilotv_device.sh` | 把 PilotV 装成一台「自部署」设备：bundle + 装依赖 + 三目录分工（开发 / 运行时 / 构建产物） |
| `scripts/deploy_artifacts_sidecar.sh` | 在一台设备上单独部署成果台侧车（每台一份数据目录，成果不串台） |
| `scripts/deploy_artifacts_marc.sh` | 同步到 `marc-linux-pc:/home/marc/pilotv-artifacts`，只更代码 |
| `scripts/make_tls_cert.sh` / `renew_gateway_tls.sh` | 自签证书 —— 安卓 Chrome 只在安全上下文里给 PWA 安装入口 |
| `service/pilotv-gateway.service` | systemd unit 模板（`__REPO_ROOT__` 等占位由部署脚本替换） |

## 安全边界

- **默认只监听回环**，暴露面与线上 5186 一致。
- **对外监听必须带令牌**：`serve_artifacts.py` 在 `0.0.0.0` 且没有 `ARTIFACTS_TOKEN` 时拒绝启动 —— 成果里常有未公开的稿子。令牌从文件读，不写进命令行参数（`ps` 一眼可见）。
- **回环豁免**：本机 `http://127.0.0.1:8799` 永不需要登录，这不是 bug；要验未登录分支必须走非回环地址。
- **网关不是开放代理**：转发目标只来自 `devices.json`（当前登记 `marc-linux-pc` / `leo-mac-studio` / `jx88`）与环境变量。
- **设备写操作默认关闭**：要用界面里的设备管理，需在 unit 里显式设 `PILOTV_ALLOW_DEVICE_WRITES=1`。

## 测试与自检

```bash
# 上游前端
(cd pilotdeck-mobile/upstream-official/ui && npm test)          # vitest
# 自研 PWA / MCP 中继
(cd pilotdeck-mobile && npm test)
(cd pilotdeck-mobile/gateway && npm test)                      # node --test
# 逐项自检脚本：命名即用途
ls scripts/verify_* scripts/check_*
python3 scripts/verify_reanchor.py                             # 锚点重锚
python3 scripts/verify_mcp_sidecar.py                          # MCP 握手 + 真调用
python3 scripts/verify_notify.py                               # 通知链路
```

浏览器端到端没有 package.json script，靠 `pilotdeck-mobile/scripts/*.mjs` 手动跑，且需要本机已装浏览器（非即装即用）。验收记录见 `pilotdeck-mobile/ACCEPTANCE.md`。

## 上游关系与许可

`pilotdeck-mobile/upstream-official/` 是 **vendor 拷贝，不是 submodule**（无 `.gitmodules`，上游 `.git` 已删除，改动随本仓版本化）。上游为 `github.com/OpenBMB/PilotDeck`，**AGPL-3.0**；本仓在此之上的改动清单见 `pilotdeck-mobile/upstream-official/UPSTREAM.md`。

PilotV 对上游的改动主要是：新增成果台面板（`ArtifactsConsolePane` / `ArtifactStage` / `ArtifactDocumentEditor`）、`/api/artifacts*` 代理到成果台（`ARTIFACTS_PROXY_TARGET`，默认 `127.0.0.1:8799`）、设备切换、移动端响应式、以及全站品牌重命名为 PilotV。

> 注意：`UPSTREAM.md` 声称只签出了 `ui`，但实际进仓的是整仓（git 跟踪 1642 个文件，含 `src/`、`apps/desktop/`、`scripts/`、`Dockerfile`），改动清单也没覆盖全部新增文件。**以实际目录树为准，不要拿这份清单当 diff 用。**

上游原仓自带一套 `*.png filter=lfs` 的 `.gitattributes`；PilotV 已把需要在小设备上 checkout 的图片全部移出 LFS，所以本仓 clone 不需要 LFS 服务（`install.sh` 里那处 `git-lfs.github.com/spec` 字符串是检测指针的代码，不是指针文件）。

## 文档地图

| 文档 | 给谁看 |
|---|---|
| `.pilotdeck/skills/artifacts-console/SKILL.md` | 使用者：怎么发布成果、怎么评审返工 |
| `.pilotdeck/skills/artifacts-console/RUNBOOK.md` | 值班 / 改代码的人：起停、鉴权、自检、历史踩坑 |
| `.HANDOFF-artifacts-console.md` | 设计论证：需求怎么落到这些模块 |
| `pilotdeck-mobile/README.md` / `ACCEPTANCE.md` | 自研 PWA + MCP 中继的用法与验收 |

## 已知不一致（照着 README 别踩）

- `RUNBOOK.md` 里提到的 `scripts/verify_tailscale_access.py`、`scripts/verify_login_flow.py`、`scripts/shoot_console_home.py`、`scripts/start-console-tailscale.sh` **不在本仓库**，它们属于宿主 console 侧那套部署（本机 systemd 单元跑的是 `/home/marc/pilotv-artifacts/`）。
- `console-artifacts.yaml` 只在 `PILOTV_ARTIFACTS_HOST=console`（挂宿主 console）时才有意义；默认的 `service` 模式走 `service/serve_artifacts.py`，不读它。
- `scripts/serve_test.py` 的默认端口就是 8899（`--port` 可改），它是回归用的独立进程；**任何指向 console 的地址都该写 8799**。
- `/review/`、`site/.qa/` 下的 PNG 与截图、`ui/dist.previous-*/` 都是可再生成的产物，已 gitignore；`site/` 只有 `.qa/` 里的脚本入库，介绍页页面本身不在仓里。
