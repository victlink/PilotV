---
name: artifacts-console
description: "把做出来的东西挂到 PilotDeck 成果台（artifacts console）供人实时预览与框选标注，并在收到返工意见后改完发新版本（标注自动继承）。当用户要看成果、要把页面/图片/视频/图纸/三维模型/文档发布到控制台、要处理成果评审意见、或提到成果台/返工/标注/版本对比时使用。优先用 MCP 工具；不可用时回退到本技能的 REST 命令。"
---

# 成果台（Artifacts Console）

成果台 = 人实时看你产出的东西 + 在画面上框选标注 + 标注自动回到你这里触发返工。

**你不做编辑器。** 用户只会说「这里不对」；改代码、改图、改稿的永远是你。

## 何时用

- 做完了一个可交付物（页面 / 图片 / 视频 / 图纸 / 三维模型 / 文档）→ `publish`
- 用户（或评审）提了修改意见 → `feedback` 取回意见 → 改 → `publish --parent` 发新版本
- 要看某个成果的评审状态 / 版本链 / 改了什么 → `status` / `chain` / `diff`

## 优先 MCP 工具

本会话可用时直接用（比 curl 少一层出错），插件 id 为 `artifacts`：

| 工具 | 什么时候用 |
|---|---|
| `mcp__artifacts__publish_artifact` | 产出就绪，立刻登记（含返工发新版本：`parent_id`） |
| `mcp__artifacts__get_artifact_feedback` | 返工前取回未解决意见（坐标 + 意见 + selector） |
| `mcp__artifacts__wait_artifact_rework` | **交付完先挂这个**：有人提交返工就立刻醒来（带清单 + 评审链接） |
| `mcp__artifacts__compare_artifact_versions` | 交付前自查：v(n-1) → v(n) 到底改了啥、还有没有没销的意见 |

> 没有 `resolve_annotation` / `list_artifacts` 这两个工具，别去找。销账用
> `PATCH /api/artifacts/<id>/annotations/<标注 id>`，列表用 CLI 的 `list`。

## 交付 → 返工 → 闭环（推荐节奏）

1. `publish_artifact` 登记成果，拿到 `review_url`（发给用户看）。
2. 顺手把链接告诉用户：「在这儿看，有问题框一下，我改完自动回来」。
3. 调 `wait_artifact_rework(artifact_id, timeout=25)` 挂着 —— 这是「自动唤醒」的实现：
   评审一点提交，服务端立刻把意见清单推回来（实测唤醒延迟 < 0.1s），不用等用户想起你。
4. 醒来后按意见改 → `publish_artifact(parent_id=上一版 id)` 发新版本
   → `compare_artifact_versions` 自查 → `PATCH .../annotations/<id>` 逐条销账。
5. `wait_artifact_rework` 连续两次超时：用户大概不在，**去干别的，别空转**。

## 不可用时：用本技能自带的脚本

```bash
CLI=${PILOTV_ROOT:-/home/marc/PilotV}/scripts/artifacts_cli.py

python3 $CLI publish --kind page --title "落地页" --path src/pages/index.html --url http://127.0.0.1:3001/
python3 $CLI publish --kind page --title "落地页 v2" --path src/pages/index.html --parent art_ab12cd
python3 $CLI feedback art_ab12cd                 # 只列未解决意见
python3 $CLI resolve   art_ab12cd art_ab12cd-n1  # 销一条账
python3 $CLI chain     art_ab12cd                 # 版本链 + 相邻版本 diff
python3 $CLI diff      art_v2id  --from art_v1id   # 两版差异：解决/未解决/源码改了啥
python3 $CLI wait      --id art_ab12cd --timeout 25   # 挂机等返工，超时就返回，别空转
python3 $CLI audit     art_ab12cd                 # 谁在什么时候做了什么
python3 $CLI list --kind image
```

脚本内部就是 REST 调用，参数与 REST 完全一致（`--help` 有全部字段）。

## 别的 agent 怎么进同一条流（M4）

不装插件，两条路：

```bash
# ① 一个目录一次性导进来：自动去重 + 识别冲突
python3 $CLI import --dir ./dist --agent opencode --dry-run      # 先看清会导什么
python3 $CLI import --dir ./dist --agent opencode --on-conflict version
#    --dry-run              只报告不写库
#    --on-conflict          skip（默认）/ version（接原成果开新版）/ new（另起一条）

# ② 或直接 REST 发布，带上自己的 agent 名
curl -s -X POST $BASE/api/artifacts -H 'Content-Type: application/json' \
  -d '{"kind":"image","title":"图标","path":"out/icon.png","agent":"opencode"}'
```

- `agent` 字段决定归属：成果台顶部按来源筛选；同一批文件被不同 agent 导入**各算各的**，不算冲突。
- 导入进来的成果一样能标注、返工、版本对比——标注挂在成果上，不挂在 agent 上。
- 运营侧（配 IM 推送、挂监控目录、状态排查）看 `.pilotdeck/skills/artifacts-console/RUNBOOK.md`。

## REST 直调（MCP 与脚本都挂了时的最后手段）

```bash
BASE=http://127.0.0.1:8799        # 成果台所在 console 端口

# 发布 / 发新版本（parent_id 非空即为返工新版）
curl -s -X POST $BASE/api/artifacts -H 'Content-Type: application/json' -d '{
  "kind":"page","title":"落地页 v1","path":"src/pages/index.html",
  "url":"http://127.0.0.1:3001/","agent":"pilotdeck"}'

# 取返工意见（只返回 status=open）
curl -s "$BASE/api/artifacts/art_ab12cd/feedback?status=open"

# 标注置为已解决
curl -s -XPATCH "$BASE/api/artifacts/art_ab12cd/annotations/art_ab12cd-n1" \
  -H 'Content-Type: application/json' -d '{"status":"resolved"}'

# 版本差异（默认跟链上上一版比；from 可指定任意两版）
curl -s "$BASE/api/artifacts/art_v2id/diff?from=art_v1id"

# 读 / 写成果台副本里的文字（html/md/txt 等，2MB 以内）
curl -s "$BASE/api/artifacts/art_ab12cd/text"
curl -s -X PUT "$BASE/api/artifacts/art_ab12cd/text" \
  -H 'Content-Type: application/json' -d '{"text":"# 改过的\n"}'

# 把未解决标注一次性交给 agent（落原项目目录 + 注入对应会话 + 唤醒）
curl -s -X POST "$BASE/api/artifacts/art_ab12cd/apply"

# 挂机等返工（1-120 秒；woke=false 表示这段时间没人返工，可以去干别的）
curl -s "$BASE/api/artifacts/wait-rework?aid=art_ab12cd&timeout=25"
```

> `PUT .../text` 写的是**成果台自己的副本**，原项目文件不动。

鉴权：本机回环直连免登录；跨机用 `Authorization: Bearer $ARTIFACTS_TOKEN`。
这两条只够**登记与读取**成果。要改网页登录口令，只能由人在页面上点 ⚙ 设置面板做，
并且必须再输一次旧口令 —— agent（哪怕持有 token）没有也不该有这条路。

> 用户说「密码不对 / 进不去 / 忘了口令」：别去改口令、别去建新账号。先让用户开
> PilotV（网关地址，如 `http://<tailscale-ip>:5186/`）用应用内的 Settings 面板改。
> 若确实拿不到浏览器，
> 才读 `.artifacts-secrets.env` 里的 `ARTIFACTS_CONSOLE_PASSWORD` —— 但那只是**建号时留下的
> 记录值**，页面改过口令后它就是过期值。细节见 RUNBOOK §0.3。

## 成果台只收「独立最终成果」（发布时会被拦）

成果台是给人看**成品**的，不是看零件的。所以发布时会判定，命中「附属产物」直接
**409 拒收**，并在 `reason` 里说明是哪一条规则命中：

| 会被拒的形态 | 例子 |
|---|---|
| 网页的元素截图、切片 | `hero-shot.png`、`card-2-crop.png` |
| 页面里引用的小图标/插图/字体 | `assets/logo.svg`、`icons/star.svg` |
| 预览图、封面、海报 | `thumb.jpg`、`preview.png`、`poster.jpg` |
| 资源目录下的图片 | `src/assets/hero.png`、`static/img/bg.jpg` |

确实要收这类中间产物，显式写 `"deliverable":"aux"`（逃生舱，默认别用）；
要强制收一条被判成附属的成果，写 `"deliverable":"final"`。

判定的唯一实现是 `artifacts_deliver.classify()`，别在别处再抄一份规则。

### 多部件成果（图纸 / 三维模型）：`.parts.json`

图纸集、装配体这类「一份成果含多个可独立查看的部件」，在**主文件旁边**放一个
同名清单即可，成果台会自动发现，不用在发布请求里传：

```
drawings/
  set.pdf              ← 主文件（发布这个）
  set.parts.json       ← 部件清单，自动发现
  plan-a.pdf
  plan-b.pdf
```

```json
{
  "version": 1,
  "label": "图纸集",
  "parts": [
    { "id": "planA", "label": "一层平面图", "path": "plan-a.pdf" },
    { "id": "planB", "label": "二层平面图", "path": "plan-b.pdf" },
    { "id": "asm",   "label": "总装", "children": [
      { "id": "body", "label": "机身", "path": "body.glb" },
      { "id": "wing", "label": "机翼", "path": "wing.glb" }
    ]}
  ]
}
```

- `path` 相对**主文件所在目录**；每个叶子会被复制进成果台，可单独渲染。
- 支持嵌套（`children`）；`id` 是标注归属的锚点。
- 格式支持：三维 `glb/gltf/obj/stl/ply/3ds/dae/3mf/step/stp/iges/igs`，
  图纸 `pdf/svg/dxf/dwg`。
- 没有清单时，`drawing`/`model3d` 会自动挂一个隐式根部件，渲染路径只有一套。
- `path` **只能指向主文件所在目录以内**（含子目录）。`../` 和绝对路径会被挡住并标
  `missing`，软链接也挡得住（按 realpath 判）。别指望用绝对路径引目录外的文件。
- 「能不能拆部件」看 `artifacts_deliver.SPLITTABLE_EXT`（含 `.pdf`）。别在别处
  再抄一份扩展名清单 —— 漏一个就会出现「三维有部件树、图纸没有」这种半成品。

### 人怎么标注（三种手势，别改回去）

| 手势 | 结果 |
|---|---|
| 单击 | 在该点落一个**编号标注**（点选意见） |
| 按住拖动 | 拉一个**框选标注**（框住一块区域提要求） |
| 在已有编号/框上**长按** | 弹出菜单：编辑文字 / 删除 / 定位 |

判定在 `artifacts.js` 的 `drawStart/drawMove/drawEnd`：位移超过
`DRAG_PX`(6) 才算框选，否则算单击；长按 `LONG_PRESS_MS`(500) 内不移动才算。
阈值调 `artifacts.js` 顶部的常量，别在别处再写一份。

### 视频：自己一套控制条 + 标注带时间点

视频不用浏览器原生控件（会被标注层盖住、且样式不可控），改成成果台自己画：
播放/暂停、停止、时间线拖动、当前时间/总时长、以及帧号（`fps` 由 `ffprobe`
探测后回填）。

- **在某一帧标注**：标注会记下 `t`（秒）和 `frame`（帧号），并写进 anchor；
  点已有标注会**跳回那一帧**。别只记秒 —— 用户说的「第 3 秒那个门」和
  「第 90 帧」在返工时是两条不同的指令。
- 要在时间线上显示标注点：读 `annotation.anchor.t`，自己画刻度；
  前端已备好锚点字段，别在服务端另存一份时间。

### 文字类成果（html / md / txt）：可以直接改

`kind=page` 的 html 和 `kind=doc` 的 md/txt，右上「编辑」进源码视图，
改完保存**立刻生效**（写回成果台自己那份副本），不用发新版。

- 保存只改**成果台副本**，不碰你项目里的原文件。要改原文件得走返工发新版。
- 依据是原始字节的 `<base>` 合并（先读原始字节，再叠改动），所以标签属性、
  行尾、大小写都不会被"格式规范化"偷偷改掉。
- 框选正文后可以就这段文字提标注，再「确认提交」交给 AI 重写选中的那段。

### 左栏「项目 / 会话」下拉：默认只看你正在看的那个对话

左栏顶上两格下拉：**项目** + **会话**。默认行为：

- 打开成果台时，落在**正在活动**的会话上；都不活跃就落在**最近更新**的那个。
- 但只在那个会话**自己真有成果**时才收窄到会话级；一条都没有就停在项目级。
  刚开的对话通常还没发成果，收窄过去只剩一棵空树，看起来像成果台坏了。
- 项目直属成果（没挂到任何会话上的）**任何情况下都照常显示** —— 按会话筛掉它们
  等于「成果凭空消失」，那比多显示几行严重得多。
- **手选过一次之后就不再自动套默认值**，包括 SSE 推新成果触发的那次重载。
  不这么处理的话，agent 一发成果就把用户视线拽回默认对话，筛选会「自己跳回去」。
- 选择存 `localStorage["pdconsole.artscope.v1"]`，关掉再开还在。

> **不要靠「最近活跃的会话」去猜「当前对话」。** 同时开着三个对话时它们全是活跃的，
> 猜出来的多半不是用户正看的那个。成果现在就在 PilotV 的「成果」页里看
> （顶部 tab 切过去，列表只列**当前会话**的成果），成果视图是应用内状态、
> 暂时还没有可分享的深链接 —— 让用户自己切到那个会话看，不要靠活跃度去猜。

### 让返工意见回到「原项目目录的对应会话」

发布时带上 `project` 和 `run_id`（就是那次对话/任务的 id）：

```json
{"kind":"image","title":"封面图","path":"out/cover.png",
 "agent":"cover-art","project":"my-app","run_id":"cli:abc123"}
```

用户在成果台点「确认提交」后，意见会同时走三条通道（提交前会先把没写完的草稿存掉；
「继续编辑」不提交，草稿原地留着，接着标就行）：

1. **原项目目录**：`<项目目录>/.pilotdeck/artifacts-rework/<sessionId>/<时间>-<aid>.md`，
   按会话分文件夹，外加一份 `index.json` 索引。
2. **对应会话**：`~/.pilotdeck/projects/<slug>/pending-inputs/<sessionId>.json`
   追加一条 `status=queued` 的条目（`options` 里带成果台副本路径）。
   ⚠️ 这条是**交接，不是即时送达**。PilotDeck 对这个旁挂文件是「一次载入」：
   `pilotdeck-bridge.js` 的 `loadQueueState()` 由 `state.queueLoaded` 守着，
   进程内只读一次，也没有文件监听或轮询。所以运行中的会话看不到外部写入的条目，
   要等它重启或该会话状态被重建才恢复（而且恢复时会被标成 `paused`，
   等用户点恢复）。界面里这一条会如实写「已交接」。
3. **唤醒 agent**：触发现有 `dispatch` / `wait_artifact_rework`。
   **这条才是即时的** —— 正挂在 `wait_artifact_rework` 上的 agent 会立刻拿到意见。

> 只写了 `project`/`run_id` 之一、或会话已经不在了，对应通道会如实报失败并给出原因，
> 不会假装送达。**「已入队 / 已唤醒」不等于「agent 已经改完」** —— 要确认结果就重新
> `wait_artifact_rework`。想稳稳交给下一次对话，直接让 agent 去原项目目录
> `.pilotdeck/artifacts-rework/<sessionId>/` 取返工单。

## 字段要点

| 字段 | 说明 |
|---|---|
| `kind` | `page` / `image` / `video` / `drawing` / `model3d` / `doc` |
| `path` | 产物文件路径。相对路径按你的工作目录解析；服务端会**复制**一份到成果台，所以改完原文件不会自动刷新，必须发新版本 |
| `url` | `page` 类的真机预览地址（dev server）；给了才会截图与内嵌预览 |
| `parent_id` | **返工发新版时必填**：填被评审的成果 id，未解决标注会自动继承 |
| `run_id` / `agent` / `project` | 来源标记；**「确认提交」靠这三个把返工单送回原项目对应会话，发布终稿时务必带上** |
| `deliverable` | `final`（默认）/ `aux`（显式收附属产物）；判成 aux 会 409 |
| `parts` | 可选，直接内联部件清单；一般改用同目录的 `.parts.json` |

`kind` 与后缀对不上时以 `kind` 为准（渲染分派看的是它）。

## 评审状态机（别自己乱改）

```
pending ─(物化完成)→ ready ─→ reviewing ─→ approved
                                     ↓  ↑        ↓
                                  rework ────────┘（返工后回到 reviewing）
任意非终态 → rejected
```

- 非法流转返回 **409**，不是静默改状态。
- 返工派发走 `POST /api/artifacts/<id>/dispatch`，它会置 `rework` 并把未解决意见一次性交给 agent。
- 每一次状态流转都进审计流水（`/audit`），带 actor 和原因。

## 常见坑

- **忘了 `parent_id`**：用户看到还是旧版，最常见的失败。
- **相对路径解析错**：路径按 agent 进程 cwd 解析；传绝对路径最稳。
- **标注继承后 `carried_from` 有值**：那是继承来的，不是新提的；改的是继承那条。
- **别自己画缩略图**：服务端会物化（图片/视频首帧/PDF 首页/页面截图），没有就出占位图。
- **交付完就闭嘴**：不在 `wait_artifact_rework` 上挂着，用户提了意见你也不知道。
- **忘了带 `project`/`run_id`**：用户点「应用」时返工单无处可落，界面会明确报
  「这份成果没归到任何项目/会话」。终稿发布就要带，别等返工时才发现。
- **别把手改过的原文件当成果**：用户在成果台里改的是**成果台副本**，原项目文件不动。
  要让改动落地，提交一份新版本（带 `parent_id`）或把它写进返工单。
