# PilotV 测试与 CI 说明

本仓库是多个子项目拼装的 monorepo，测试分散在三处。本文档给出**统一的本地测试入口**与 **GitHub CI** 的对应关系，方便在没有 CI Runner 的机器上复跑门禁。

## 1. 仓库结构里的测试分布

| 位置 | 类型 | 运行方式 | 是否需要装依赖 |
| --- | --- | --- | --- |
| `cli/*.test.mjs`、`scripts/ci/*.test.mjs`、`plugins-src/*/*.test.mjs` | Node 零依赖单测 | `node --test` | 否 |
| `scripts/test_*.py`（artifacts / workspace / gateway 回归） | Python `unittest` | `PYTHONPATH=. python -m unittest scripts.test_artifacts_*` | 否（仅标准库 + mock） |
| `pilotdeck-mobile/upstream-official/src/**/*.test.ts` | 网关 `node:test`（tsx） | `npm run test:src` | 是（上游 workspace 依赖） |
| `pilotdeck-mobile/upstream-official/ui/**/*.test.ts(x)` | 前端 Vitest | `pnpm --dir ui run test` | 是（UI 依赖） |
| `pilotdeck-mobile/upstream-official/dist/tests/**` | 编译后网关测试 | `npm run test`（先 build） | 是 |

## 2. 根目录统一测试入口

仓库根新增了 `package.json`，把上面「不需要装子项目依赖」的两类测试聚合成一个 `npm test`：

```bash
npm test            # = test:node + test:python（零/低依赖，开箱即跑）
npm run test:node   # Node 零依赖单测（cli / ci / plugins-src）
npm run test:python # Python 回归（scripts/test_artifacts_*.py），显式模块方式（Python 3.11 的 discover 不支持裸 scripts 目录）
npm run test:gateway# 网关单测（需先 pnpm install 上游依赖）
npm run test:ui     # 前端单测（需先装 UI 依赖）
npm run test:full   # 以上全部（需完整装依赖）
npm run ci:gates    # 复跑 CI 的仓库卫生 / 错误可观测 / 脚本 sprawl / 上游 patch / 部署脚本转义 五道门禁
```

> 说明：`test:gateway` / `test:ui` / `test:full` 需要先进入对应子目录执行 `pnpm install`（或 `npm install`）。`ci:gates` 里 `check-script-sprawl` / `check-repo-hygiene` 直接复用 CI 脚本，结果与 GitHub Actions 一致。

## 3. CI 工作流（`.github/workflows/ci.yml`）

CI 在 `push` 到 `main`、`pull_request`、`workflow_dispatch` 时触发，分三个 job：

- **hygiene**：仓库卫生与零依赖单测。
  - `node-version: 22`（CI Runner 用 22；运行时门禁本身已支持 22/24 两线）。
  - Python 3.13（PEP 701 f-string 要求 ≥3.12）。
  - 门禁脚本：`check-repo-hygiene`（行尾/批处理 ASCII/误提交）、`check-error-observability`（错误必须落日志）、`check-script-sprawl`（禁止新增散落脚本）、`check-upstream-patches`（vendored 上游的 4 处手工 patch 必须仍在位）、`check-desktop-prereqs`、`check_deploy_script_escaping.sh`。
  - Python 全仓语法编译：`python -m compileall`。
  - CLI/CI 判定逻辑单测：`node --test cli/*.test.mjs scripts/ci/*.test.mjs plugins-src/*/*.test.mjs`。
  - 最后一步 `git add -A && git diff --cached --quiet` 确保 checkout 后工作树干净（归一化一致）。

- **web**：网关 + UI 构建、类型检查、测试。
  - `pnpm install --frozen-lockfile --filter pilotdeck --filter pilotdeck-ui`。
  - `npm run build`（tsc → dist）→ `npm run test:src`（网关单测）→ tsc 类型检查 → UI 类型检查 + `vitest`。

- **compat**：版本一致性。
  - `deploy/check-api-compat.mjs`：前端每个 `/api` 调用在仓内都有 owner（防止「前端调了后端没有的路由」）。
  - `deploy/check-no-device-paths.mjs`：禁止新增设备专属绝对路径。
  - `deploy/release.json` 结构校验 + `deploy/tests/run-all.sh` 回滚沙箱回归。
  - `bash -n` 检查升级/验证脚本语法。

## 4. 本地复跑 CI 的最小步骤

```bash
# 1) 零依赖门禁 + 单测（任何机器）
npm run ci:gates
npm test

# 2) 完整（需要联网装依赖，约数分钟）
cd pilotdeck-mobile/upstream-official && pnpm install --filter pilotdeck --filter pilotdeck-ui
npm run test:full
```

## 5. 上游 patch 通道

`patches/*.patch` 记录对 vendored 上游（`pilotdeck-mobile/upstream-official`）的 4 处手工修复。CI 用 `scripts/ci/check-upstream-patches.mjs` 三态校验（applied / missing / drifted），只有 `applied` 算通过。任何对上游的手工改动，都必须新增对应 patch 文件并登记，否则上游同步会静默覆盖（历史上因此出过「gateway 偶尔整体退出」的事故）。
