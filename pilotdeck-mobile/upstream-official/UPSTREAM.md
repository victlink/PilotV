# 上游来源与本地改动

本目录的 UI 源码来自官方 PilotDeck 仓库，已按本项目需要就地修改。
为便于日后与上游比对，这里记录来源与改动清单。

## 来源

- 仓库：https://github.com/OpenBMB/PilotDeck.git
- 基线提交：`6afe9c6d646d3cc13b68e7afa87a12a2759a7ba8`
- 取用方式：`git clone --depth 1 --filter=blob:none --sparse`，仅签出 `ui` 目录。
- 原始克隆的 `.git` 已移除，源码以本仓库为准（vendored），
  这样上面的本地改动才能跟着本仓库一起版本化。

需要比对上游时：

```bash
git clone --depth 1 https://github.com/OpenBMB/PilotDeck.git /tmp/pilotdeck-upstream
diff -ru /tmp/pilotdeck-upstream/ui/src ui/src
```

## 本地改动清单

改动的文件：

- `ui/src/components/app-shell/AppShellV2.tsx`
  手机上把侧栏视为「已收起」，顶栏才会出现打开会话列表的入口
  （原先被 `!isMobile` 挡住，手机上无法回到项目／会话列表）。
- `ui/src/components/app-shell/MainAreaV2.tsx`
  主区域顶栏单行化：左侧设备切换、右侧「对话／成果」与项目、会话名同一行；
  隐藏成果窗口时保留 `MainContent` 挂载，不丢对话状态。
- `ui/src/components/app-shell/SidebarV2.tsx`
  侧栏顶部改为 PiloV 标识 + 设备选择器，与主区顶栏等高、分割线对齐。
- `ui/src/main.jsx`
  引入 `mobile-responsive.css`（仅 `≤1024px` 生效的补丁）。
- `ui/vite.config.js`
  成果服务代理：`/api/artifacts*` 与 `/artifacts*` 转到 `ARTIFACTS_PROXY_TARGET`。

新增的文件：

- `ui/src/components/app-shell/ArtifactsConsolePane.tsx`
  主区「成果」视图：列出当前会话成果、上下页／下拉切换、滑动条，
  嵌入成果台主窗口并驱动选中，标注同步进官方对话输入框。
- `ui/src/components/app-shell/artifactsMedia.ts`（含单测）
  成果列表分页拉取、按 `run_id` 精确过滤、格式判断。
- `ui/src/components/app-shell/artifactFeedback.ts`（含单测）
  标注读取与拼接进对话输入的文本格式。
- `ui/src/components/app-shell/DeviceSwitcher.tsx`
  多设备下拉：新增／删除／选中，配置存浏览器本地。
- `ui/src/components/app-shell/deviceRegistry.ts`（含单测）
  设备条目校验、损坏数据剔除、一次性导入解析与按 origin 去重合并。
- `ui/src/mobile-responsive.css`
  仅 `≤1024px`：安全区、`100dvh`、iOS 输入聚焦缩放、对话框不溢出。
