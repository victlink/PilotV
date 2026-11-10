# PilotV 三端单文件安装包（v0.1.2）

每个平台只交付**一个文件**，双击/执行即可，不需要额外脚本、不需要 Tailscale。

| 平台 | 交付文件 | 怎么装 |
|---|---|---|
| Android | `PilotV-0.1.2.apk` | 传到手机点开安装（允许「未知来源」）；包名 `com.pilotv.app`，v0.1.2 |
| Windows | `PilotV-Setup-0.1.2.exe` | 双击；装到 `%LOCALAPPDATA%\PilotV`，无需管理员权限 |
| Linux | `pilotv-install-0.1.2.sh` | `chmod +x && ./pilotv-install-0.1.2.sh` |

三个文件都在本仓库外的 NAS 归档目录 `/vol4/1000/00/产物/PilotV/PilotV_三端安装包_v0.1.2_20261110/`。
本目录只放**可复现的源码**；二进制不进 Git。

## 装完之后怎么连手机

1. 在装了 PilotV 的电脑上打开 `http://127.0.0.1:5186/pair`（或安装器打印的局域网地址），先登录。
2. 页面出二维码；安卓客户端点「扫码连接」对准它。
3. 手机与电脑同 Wi-Fi 时走局域网直连；出门切 4G 时自动换到二维码里带的公网备用入口。
   公网入口由 `PILOTV_PUBLIC_ORIGINS` 配置（安装参数 `-PublicOrigin` / `--public-origin`），
   不配就只有局域网地址，出门会断 —— 这是预期行为，不是故障。
4. 公网入口需要在宿主端配好 Cloudflare Tunnel（见 `docs/MOBILE-PAIRING.md`）。

## 三个安装器都支持的参数

| 动作 | Windows | Linux |
|---|---|---|
| 只读体检，不改任何东西 | `PilotV-Setup-0.1.2.exe -CheckOnly` | `./pilotv-install-0.1.2.sh --check` |
| 更新到最新 main 并重启 | `PilotV-Setup-0.1.2.exe -Update` | `./pilotv-install-0.1.2.sh --update` |
| 只起服务（计划任务 / systemd 用） | `... -StartOnly` | `... --start-only` |
| 装完不启动 | `... -NoStart` | `... --no-start` |
| 指定公网入口 | `... -PublicOrigin https://pilotv.example.com` | `... --public-origin https://pilotv.example.com` |
| 卸载（目录改名保留，不删除） | `... -Uninstall` | `... --uninstall` |
| 开机自启 | 计划任务可指向 `-StartOnly` | `... --service` |

Linux 额外环境变量：`PILOTV_INSTALL_DIR`、`PILOTV_BRANCH`、`PILOTV_REPO_URL`、
`PILOTV_LAN_PORT`、`PILOTV_NODE_MIRROR`、`PILOTV_SKIP_DEPS`。
Windows 额外参数：`-InstallDir`、`-Branch`、`-RepoUrl`、`-LanPort`。

## 安装器做什么

1. 体检：系统、运行时、端口占用、GitHub 可达性（`-CheckOnly` / `--check` 只读）。
2. 运行时：Node 22 LTS（系统已有 22.x 就复用，否则下载官方便携版到安装目录，不污染系统）、
   Python 虚拟环境 + `aiohttp`、pnpm（corepack 或 npm 全局）。
3. 源码：`git clone --depth 1 https://github.com/VICTLINK/PilotV.git`（没有 git 时自动改下载 zip/tar）。
4. 依赖：`pnpm install --no-frozen-lockfile` + `pnpm run build` 产出 `ui/dist`。
5. 配置：写 `.env.local`（公网入口、局域网端口），生成成果台机器令牌，写开始菜单/桌面入口。
6. 启动：Windows 走仓库自带 `start-windows.ps1`（8799 / 18789 / 3001 / 5186 / 8801 五个服务）；
   Linux 走 `start.sh`（8799 / 5186）+ 直接拉起 18789 / 3001。
7. 自检：轮询 `http://127.0.0.1:5186/pair` 直到 200，然后打印可点的配对地址。

## 复现构建

```bash
# Windows EXE（需要 Python 3.10+ 与 pyinstaller）
python -m pip install pyinstaller
python windows/build.py            # → dist/PilotV-Setup-0.1.2.exe

# Android APK（需要 JDK 17 + Android SDK 35）
cd <PilotV-Android>/android
./gradlew :app:assembleRelease :app:testDebugUnitTest
zipalign -f -p 4 app-release-unsigned.apk aligned.apk
apksigner sign --ks <你的 keystore> --out PilotV-0.1.2.apk aligned.apk
```

> 当前 APK 用随包附带的测试 keystore 签名，**仅用于自测分发**；
> 正式发布请换自己的 keystore，否则以后换签名必须先卸载、无法覆盖升级。
> Windows EXE 未做代码签名，SmartScreen 首次运行可能提示「未知发布者」，点「仍要运行」即可。

## 已知边界

- 安装器要联网：拉 GitHub 仓库、Node 便携版、pnpm 依赖。离线机器需预置 `repo/` 目录并设 `PILOTV_SKIP_DEPS=1`。
- 首次 `pnpm install` 会装完整 pnpm workspace，耗时数分钟；UI 里的 `@pilotdeck/config workspace:*` 决定了不能用 `npm ci`。
- Windows 控制台中文用系统 OEM 代码页（GBK）输出，在中文 Windows 的 cmd/PowerShell 窗口正常；
  通过 Git Bash 之类的 UTF-8 终端捕获时会显示乱码，不影响功能。
- Agent 网关 18789 需要 `~/.pilotdeck/pilotdeck.yaml` 里有 agent/model 配置，否则 `start-windows.ps1`
  会提示启动超时；这是 PilotDeck 宿主自身的配置，不在本安装器职责内。
