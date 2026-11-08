# 桌面端（Electron）打包现状与前置

> 结论先说：**这个仓库现在打不出安装包**，而且这不是配置问题，是仓库内容决定的。
> `scripts/ci/check-desktop-prereqs.mjs` 负责让这句话一直为真或一直为假，而不是靠记忆。

## 为什么打不出来

`pilotdeck-mobile/upstream-official/apps/desktop/` 只 vendor 了 `src/*.ts` 和
`package.json`（25 个文件）。而 `package.json` 自己点名要用的东西一个都不在：

- `scripts/build-runtime.mjs`、`scripts/after-pack.cjs`、`scripts/check-windows-build-host.mjs`
  等 10 个打包脚本；
- `resources/icons/*`、`resources/installer.nsh`、`resources/entitlements.mac.plist`、
  `resources/node`、`resources/git`、`.runtime/app` 等资源；
- `node_modules`（桌面端是 pnpm workspace 成员，本机既没有 pnpm 也没有装依赖）。

所以「跑一下 `pnpm --filter pilotdeck-desktop dist:win`」在这台机器上不可能成功。
把这件事写成「已完成」比不写更糟。

## 那这个门禁到底检查什么

两类结论分开，因为它们的修法完全不同：

| 类别 | 检查项 | 非 `--strict`（CI 默认） | `--strict`（真要打包时） |
|---|---|---|---|
| repo | `package.json` 与 `pnpm-lock.yaml` 的依赖声明是否漂移 | 失败 | 失败 |
| repo | 打包链引用的文件缺失（基线外的新增） | 失败 | 失败 |
| repo | 已知未 vendor 的 22 个文件 | 只报告 | 失败 |
| environment | `electron`/`electron-builder` 是否已装、pnpm 是否可用、宿主与目标是否匹配 | 只报告 | 失败 |

**为什么 environment 不拦 CI**：这台机器和 CI runner 都没有 pnpm，拦了门禁第一天就常红，
一周后就会有人加 `continue-on-error`，然后它再也检查不出任何东西。

**为什么漂移一定要拦**：`package.json` 写 `electron: ^42.3.3` 而 lockfile 锁到别的版本时，
打出来的包用的是另一个 electron，行为变了而没人看得出来。这是机器能一直盯、人盯不住的那类问题。

## 真要出安装包需要做什么

在**完整的上游树**（含 `apps/desktop/scripts` 与 `resources/`）上：

```bash
pnpm install --frozen-lockfile
# Windows 目标必须在原生 Windows 上打（上游自己用 check-windows-build-host.mjs 把关）
pnpm --filter pilotdeck-desktop dist:win:x64
pnpm --filter pilotdeck-desktop dist:mac:arm64
```

产出落在 `apps/desktop/dist-electron/`。之后跑 `--strict` 应当全绿：

```bash
node scripts/ci/check-desktop-prereqs.mjs --strict
```

## 已知限制

- 门禁自己解析 `pnpm-lock.yaml`（零依赖约束，见 `cli/pilotv.mjs` 顶部说明）。它只认
  pnpm v9 那种固定缩进；形状一变就返回「未知」并判 missing，不会给出「一致」的假结论。
- `KNOWN_MISSING` 是手工入库的基线。上游若把某个文件补进来，那条会从 missing 变 ready（正常）；
  若 `package.json` 新增一个不存在的引用，门禁会红——这是有意的：新坏掉的东西必须让 CI 变红。