<#
  PilotV Windows 一键安装（单文件 EXE 内嵌的就是本脚本）
  版本 0.1.2

  双击安装：装运行时 -> 拉仓库 -> 装依赖 -> 建前端 -> 起五个服务 -> 给配对页地址。
  全部装到 %LOCALAPPDATA%\PilotV，不需要管理员权限，不写注册表。

  参数（命令行）：
    -CheckOnly    只读体检，不写任何文件
    -Update       更新到最新 main 并重启
    -StartOnly    只起服务（计划任务用）
    -NoStart      装完不启动
    -Uninstall    停服并把安装目录改名保留
    -InstallDir   安装目录
    -PublicOrigin 公网入口，写进二维码备用地址
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Update,
    [switch]$StartOnly,
    [switch]$NoStart,
    [switch]$Uninstall,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'PilotV'),
    [string]$Branch = 'main',
    [string]$RepoUrl = 'https://github.com/VICTLINK/PilotV.git',
    [string]$PublicOrigin = '',
    [int]$LanPort = 5186
)

$ErrorActionPreference = 'Stop'
$Version = '0.1.2'
$RepoDir   = Join-Path $InstallDir 'repo'
$Upstream  = Join-Path $RepoDir 'pilotdeck-mobile\upstream-official'
$UiDir     = Join-Path $Upstream 'ui'
$Venv      = Join-Path $RepoDir '.venv'
$ToolsDir  = Join-Path $InstallDir 'tools'
$NodeDir   = Join-Path $ToolsDir 'node'
$RunDir    = Join-Path $InstallDir 'run'
$Marker    = Join-Path $InstallDir '.pilotv-installed'
$NodeMirror = if ($env:PILOTV_NODE_MIRROR) { $env:PILOTV_NODE_MIRROR } else { 'https://nodejs.org/dist' }

function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok([string]$m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Fail([string]$m) { throw $m }
function Test-Port([int]$p) {
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); return $true } catch { return $false }
}
function Invoke-Download([string]$url, [string]$out) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 300
}
function Add-Front([string]$dir) {
    if ($dir -and (Test-Path $dir)) { $env:Path = $dir + ';' + $env:Path }
}

# ------------------------------------------------------------------ 体检
if ($CheckOnly) {
    Step 'PilotV Windows 安装体检（只读）'
    Ok "系统：$([Environment]::OSVersion.VersionString)"
    foreach ($c in @('git','node','npm','python','py','pnpm','powershell')) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { Ok "$c -> $($cmd.Source)" } else { Warn "$c 未安装（安装器会自动补 Node / pnpm / venv）" }
    }
    if (Get-Command node -ErrorAction SilentlyContinue) { Ok "node $(node -v 2>$null)" }
    foreach ($p in @(5186,3001,8799,18789,8801)) {
        if (Test-Port $p) { Warn "端口 $p 已被占用（若已是 PilotV 会复用）" } else { Ok "端口 $p 空闲" }
    }
    try { Invoke-WebRequest -Uri $RepoUrl -Method Head -UseBasicParsing -TimeoutSec 8 | Out-Null; Ok 'GitHub 仓库可达' }
    catch { Warn 'GitHub 仓库暂不可达（离线安装需预置 repo 目录）' }
    Ok "安装目录将是：$InstallDir"
    Step '体检结束（未做任何修改）'
    exit 0
}

# ------------------------------------------------------------------ 卸载
if ($Uninstall) {
    Step '停止服务'
    $startScript = Join-Path $RepoDir 'start-windows.ps1'
    if (Test-Path $startScript) { try { & $startScript -Stop | Out-Null } catch { Warn $_.Exception.Message } }
    $task = Get-ScheduledTask -TaskName 'PilotV-Startup' -ErrorAction SilentlyContinue
    if ($task) { Unregister-ScheduledTask -TaskName 'PilotV-Startup' -Confirm:$false -ErrorAction SilentlyContinue; Ok '已移除开机任务' }
    if (Test-Path $Marker) {
        $backup = "$InstallDir.uninstalled-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Move-Item -LiteralPath $InstallDir -Destination $backup
        Ok "已卸载，原目录完整保留在：$backup"
    } else { Warn "未找到安装标记 $Marker，为安全起见不移动目录" }
    exit 0
}

# ------------------------------------------------------------------ 运行时
function Ensure-Node {
    $sys = Get-Command node -ErrorAction SilentlyContinue
    if ($sys) {
        $v = (& node -v 2>$null)
        if ($v -match '^v22\.') { Ok "复用系统 Node $v"; $script:NodeDir = $null; return }
    }
    $exe = Join-Path $NodeDir 'node.exe'
    if (Test-Path $exe) { Ok "复用便携 Node $(& $exe -v)"; return }
    Step '下载 Node 22 LTS 便携版'
    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
    $sums = Join-Path $ToolsDir 'SHASUMS256.txt'
    Invoke-Download "$NodeMirror/latest-v22.x/SHASUMS256.txt" $sums
    $fname = (Select-String -Path $sums -Pattern 'node-v22.*-win-x64.zip' | Select-Object -First 1).Line.Split(' ')[1]
    if (-not $fname) { Fail '清单里找不到 win-x64 的 Node 22 包' }
    $zip = Join-Path $ToolsDir $fname
    Invoke-Download "$NodeMirror/latest-v22.x/$fname" $zip
    $tmp = Join-Path $ToolsDir 'node-extract'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    Get-ChildItem -LiteralPath $inner.FullName | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $NodeDir -Force
    }
    Remove-Item $zip, $sums, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $exe)) { Fail 'Node 解压后未找到 node.exe' }
    Ok "便携 Node 就位：$( & $exe -v)"
}

function Ensure-Python {
    $py = $null
    foreach ($c in @('py','python','python3')) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { $py = $cmd.Source; break }
    }
    if (-not $py) {
        Step '尝试用 winget 安装 Python 3.12（用户级）'
        $wg = Get-Command winget -ErrorAction SilentlyContinue
        if ($wg) { & winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements --scope user | Out-Null }
        $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    }
    if (-not $py) { Fail '找不到 Python 3.10+，请手动安装 python.org 的 3.12 后重跑' }
    $venvPy = Join-Path $Venv 'Scripts\python.exe'
    if (-not (Test-Path $venvPy)) {
        Step '创建 Python 虚拟环境'
        if ($py -match 'py\.exe$') { & $py -3 -m venv $Venv } else { & $py -m venv $Venv }
    }
    & $venvPy -m pip install -q --disable-pip-version-check -r (Join-Path $RepoDir 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { Fail '安装 aiohttp 失败' }
    Ok 'Python 依赖（aiohttp）就位'
}

function Ensure-Pnpm {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { Ok "复用 pnpm $(pnpm -v)"; return }
    Step '启用 pnpm（corepack）'
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        try { corepack enable 2>$null; corepack prepare pnpm@9 --activate 2>$null } catch { }
    }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        & npm install -g --no-audit --no-fund pnpm@9
        if ($LASTEXITCODE -ne 0) { Fail '安装 pnpm 失败' }
    }
    Ok "pnpm $(pnpm -v)"
}

function Get-Repo {
    if (Test-Path (Join-Path $RepoDir '.git')) {
        Step "更新仓库到 origin/$Branch"
        Push-Location $RepoDir
        try { & git fetch --depth 1 origin $Branch; & git reset --hard "origin/$Branch" }
        finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Fail 'git 更新失败' }
    } elseif (Test-Path (Join-Path $Upstream 'package.json')) {
        Ok '复用已有 repo 目录（非 git，跳过更新）'
    } else {
        Step '克隆 PilotV 仓库'
        if (Test-Path $RepoDir) { Remove-Item $RepoDir -Recurse -Force }
        if (Get-Command git -ErrorAction SilentlyContinue) {
            & git clone --depth 1 --branch $Branch $RepoUrl $RepoDir
            if ($LASTEXITCODE -ne 0) { Fail 'git clone 失败' }
        } else {
            $zip = Join-Path $ToolsDir 'pilotv.zip'
            Invoke-Download "https://github.com/VICTLINK/PilotV/archive/refs/heads/$Branch.zip" $zip
            $tmp = Join-Path $ToolsDir 'repo-extract'
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
            $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
            Move-Item -LiteralPath $inner.FullName -Destination $RepoDir
            Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not (Test-Path (Join-Path $Upstream 'package.json'))) { Fail "仓库结构不对：缺 $Upstream\package.json" }
    Ok "仓库就位：$RepoDir"
}

function Write-EnvLocal {
    # 单引号 here-string：不做变量插值，bash 的 ${VAR:-默认} 原样落盘。
    $content = @'
# 由 PilotV-Setup 生成；本机专属配置，不进版本库。
PILOTV_PUBLIC_ORIGINS="${PILOTV_PUBLIC_ORIGINS:-__PUBLIC__}"
PILOTV_LAN_PORT="${PILOTV_LAN_PORT:-__LAN__}"
'@
    $content = $content.Replace('__PUBLIC__', $PublicOrigin).Replace('__LAN__', "$LanPort")
    [IO.File]::WriteAllText((Join-Path $RepoDir '.env.local'), $content, (New-Object Text.UTF8Encoding($false)))
    Ok "已写入 .env.local（公网入口=$(if ($PublicOrigin) { $PublicOrigin } else { '未设置' })）"
}

function Install-Deps {
    if ($env:PILOTV_SKIP_DEPS -eq '1') { Warn '跳过依赖安装（PILOTV_SKIP_DEPS=1）'; return }
    Step '安装前端/后端依赖（pnpm workspace，首次约需数分钟）'
    Push-Location $Upstream
    try { & pnpm install --no-frozen-lockfile; $rc = $LASTEXITCODE } finally { Pop-Location }
    if ($rc -ne 0) { Fail 'pnpm install 失败' }
    Step '构建前端 dist'
    Push-Location $UiDir
    try { & pnpm run build; $rc = $LASTEXITCODE } finally { Pop-Location }
    if ($rc -ne 0) { Fail '前端构建失败' }
    Ok '依赖与前端产物就位'
}

function Ensure-Token {
    $dir = Join-Path $env:USERPROFILE '.pilotdeck'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $f = Join-Path $dir 'artifacts-token'
    if (-not (Test-Path $f) -or (Get-Item $f).Length -eq 0) {
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        [IO.File]::WriteAllText($f, ([BitConverter]::ToString($bytes) -replace '-', '').ToLower())
    }
    Ok '成果台机器令牌就位'
}

function Start-Services {
    $startScript = Join-Path $RepoDir 'start-windows.ps1'
    if (-not (Test-Path $startScript)) { Fail "缺少 $startScript" }
    Step '启动五个服务（8799 / 18789 / 3001 / 5186 / 8801）'
    Add-Front (Join-Path $Venv 'Scripts')
    if ($script:NodeDir) { Add-Front $NodeDir }
    # 配对二维码的备用入口由 3001 进程读环境变量；start-windows.ps1 不读 .env.local，
    # 所以必须在启动前显式注入，否则手机上只有当前页面地址、出门就断。
    if ($PublicOrigin) { $env:PILOTV_PUBLIC_ORIGINS = $PublicOrigin }
    $env:PILOTV_LAN_PORT = "$LanPort"
    & $startScript
    Ok '启动命令已执行'
}

function Wait-Ready {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$LanPort/pair" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { Ok "配对页就绪：http://127.0.0.1:$LanPort/pair"; return }
        } catch { }
        Start-Sleep -Seconds 1
    }
    Warn '配对页 30 秒内未就绪，请查看 <安装目录>\repo\.run\*.log'
}

function New-Shortcuts {
    $programs = [Environment]::GetFolderPath('Programs')
    $pilotvDir = Join-Path $programs 'PilotV'
    New-Item -ItemType Directory -Force -Path $pilotvDir | Out-Null
    $url = Join-Path $pilotvDir 'PilotV 配对页.url'
    [IO.File]::WriteAllText($url, "[InternetShortcut]`r`nURL=http://127.0.0.1:$LanPort/pair`r`n", [Text.Encoding]::ASCII)
    Ok "开始菜单快捷方式：$url"
}

function Show-Summary {
    $ip = ''
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
               Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } |
               Select-Object -First 1).IPAddress
    } catch { }
    Write-Host ''
    Step '安装完成。用电脑浏览器打开下面任一地址，登录后用安卓客户端「扫码连接」：'
    if ($ip) { Write-Host "    http://$($ip):$LanPort/pair      <- 手机与电脑同一 Wi-Fi 时最快" }
    Write-Host "    http://127.0.0.1:$LanPort/pair        <- 只在本机看"
    if ($PublicOrigin) { Write-Host "    $PublicOrigin/pair                  <- 公网入口（无需 Tailscale）" }
    Write-Host ''
    Write-Host "  更新：PilotV-Setup.exe -Update"
    Write-Host "  状态：<安装目录>\repo\start-windows.ps1 -Status"
    Write-Host "  日志：<安装目录>\repo\.run\"
}

# ------------------------------------------------------------------ 主流程
New-Item -ItemType Directory -Force -Path $InstallDir, $ToolsDir, $RunDir | Out-Null
if (-not $StartOnly) { Ensure-Node }
if ($script:NodeDir) { Add-Front $NodeDir }
Add-Front (Join-Path $Venv 'Scripts')

if ($StartOnly) {
    Start-Services
    Wait-Ready
    exit 0
}

if ($Update) {
    Step '停止现有服务'
    $startScript = Join-Path $RepoDir 'start-windows.ps1'
    if (Test-Path $startScript) { try { & $startScript -Stop | Out-Null } catch { } }
    Get-Repo
    Ensure-Python
    Ensure-Pnpm
    Install-Deps
    Write-EnvLocal
    Ensure-Token
    New-Shortcuts
    if (-not $NoStart) { Start-Services; Wait-Ready }
    Show-Summary
    exit 0
}

Get-Repo
Ensure-Python
Ensure-Pnpm
Install-Deps
Write-EnvLocal
Ensure-Token
New-Shortcuts
[IO.File]::WriteAllText($Marker, (Get-Date -Format o))
if (-not $NoStart) { Start-Services; Wait-Ready }
Show-Summary
