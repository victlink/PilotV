<#
  PilotV Windows 启动脚本
  ----------------------
  代替仓库里的 start.sh（依赖 Linux 的 setsid / ss / hostname -I，Windows 下不可用）。

  用法：
    .\start-windows.ps1            启动成果台 + Agent 网关 + Web/API 服务 + 前端网关
    .\start-windows.ps1 -Status    只看状态
    .\start-windows.ps1 -Stop      停掉本脚本起的进程

  进程拓扑（五个进程，缺一不可）：
    8799   成果台 API（service/serve_artifacts.py，用项目内 .venv；房间编排器随它启动）
    18789  PilotV Agent 网关（upstream-official，tsx 跑 src/cli/pilotdeck.ts server）
    3001   Web/API 服务（upstream-official/ui/server/index.js）—— 页面上所有 /api/* 都由它提供
    5186   前端 + 反向代理（service/pilotv_gateway.mjs，把 /api、/ws 转发到 3001）
    8801   成果台 MCP 侧车（artifacts-mcp.mjs，房间成员回写转录要用）

  易错点：3001 是 Express 的 Web/API 服务，不能把 Agent 网关开在 3001。
          Agent 网关开在 3001 时，页面能渲染，但所有 /api/* 会落到 SPA 兜底 HTML，
          表现就是「添加模型失败 / 新建工作区失败」这类 JSON 解析错误。

  前置：Node 24 LTS（22.22.2 的 V8 cppgc 断言会让网关在长上下文并发时崩溃，
        见 docs/COMMANDER-LOOP.md §12）、Python 3.10+，且已完成依赖安装
        （.venv 里的 aiohttp、upstream-official 下的 pnpm 依赖与 ui/dist 构建产物）。
        换 node 主版本后 better-sqlite3 必须同步换成对应 ABI 的原生模块。
  说明：这里不用 Start-Process —— 本机环境同时存在 http_proxy / HTTP_PROXY，
        它构造环境字典时会抛「已添加项」而失败，所以统一走 .NET 进程 + cmd 重定向。
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$RunDir = Join-Path $Root '.run'
$PidFile = Join-Path $RunDir 'pids.json'
$CmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'

$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Upstream = Join-Path $Root 'pilotdeck-mobile\upstream-official'
$UiDir = Join-Path $Upstream 'ui'
$UiDist = Join-Path $UiDir 'dist'
$TsxPkg = Join-Path $Upstream 'node_modules\tsx'

$ArtifactsPort = 8799
$AgentPort = 18789
$WebPort = 3001
$UiPort = 5186
$McpPort = 8801

# 计划任务/开机启动不继承 WorkBuddy 注入的 PATH，这里自行解析 node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeRoot = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
    $nodeExe = Get-ChildItem -LiteralPath $nodeRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object -MemberName FullName | Where-Object { $null -ne $_ } | ForEach-Object { [System.IO.Path]::Combine($_, 'node.exe') } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($nodeExe) {
        $env:Path = (Split-Path -Parent $nodeExe) + ';' + $env:Path
        Write-Host "node 不在 PATH 中，已注入 $(Split-Path -Parent $nodeExe)"
    } else {
        Write-Warning "未找到 node，请确认 $nodeRoot 下存在 node.exe"
    }
}

# PilotV 专用 Node 运行时：优先 PILOTDECK_NODE，其次 %USERPROFILE%\tools\node-v24*，
# 最后才退回 PATH 里的 node。优先级与 .run\*.cmd 保持一致。
# 22.22.2 触发过 V8 "Check failed: marking_done_"；升级主版本后 better-sqlite3
# 要用 ABI 137 的预编译包（本机已换，旧 ABI 127 备份在同目录 *.abi127.original）。
$NodeExe = $env:PILOTDECK_NODE
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) {
    $NodeExe = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE 'tools') -Directory -Filter 'node-v24*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'node.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
}
if (-not $NodeExe) { $NodeExe = 'node' }
Write-Host "PilotV node runtime: $NodeExe"

# 清掉宿主 shell（WorkBuddy / Claude Code）注入的 bash 钩子与回合上下文。
#
# 现场：从 Agent 的终端里启动本脚本时，环境里会带
#   BASH_ENV=<宿主 shim>、BASH_FUNC_rm%% 等导出函数、CODEBUDDY_TURN_ID ...
#   PATH 最前面还有 ...\cli\vendor\shim\safe-bin（包装过的 rm/rmdir）
# PilotV 的 agent 会继承这些，它每次派 bash 执行命令都会重新装上包装函数；
# 删除操作于是被宿主的「单回合删除配额」拦下（用的是宿主那个回合的计数器），
# 整个 turn 直接失败：
#   gateway_submit_failed: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {...}
# 表现就是页面上「Messages could not be displayed」。
# 手动从资源管理器/普通终端启动时这些变量本来就没有，这里清一遍是无害的。
function Clear-HostShellHooks {
    $processVars = [System.Environment]::GetEnvironmentVariables('Process')
    foreach ($key in @($processVars.Keys)) {
        if ($key -eq 'BASH_ENV' -or $key -eq 'ENV' -or
            $key -like 'BASH_FUNC_*' -or $key -like 'CODEBUDDY_*' -or
            $key -eq 'CLAUDE_PROJECT_DIR' -or $key -eq 'CLAUDE_CODE_ENTRYPOINT') {
            try { [System.Environment]::SetEnvironmentVariable($key, $null, 'Process') } catch { }
        }
    }
    if ($env:PATH) {
        $kept = @()
        foreach ($dir in ($env:PATH -split ';')) {
            if (-not $dir) { continue }
            if ($dir -match '\\shim\\') { continue }
            $kept += $dir
        }
        $env:PATH = ($kept -join ';')
    }
}

Clear-HostShellHooks

function Test-Port([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port)
        $c.Close()
        return $true
    } catch { return $false }
}

function Wait-Port([int]$Port, [int]$Millis) {
    $steps = [Math]::Ceiling($Millis / 500)
    for ($i = 0; $i -lt $steps; $i++) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (Test-Port $Port)
}

# 用 .NET 起进程：cmd /c 把 stdout/stderr 落到日志文件，进程本身脱离启动器存活
function Start-Svc([string]$Exe, [string]$ArgLine, [string]$WorkDir, [string]$LogName) {
    $log = Join-Path $RunDir $LogName
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $CmdExe
    $psi.Arguments = '/c ""' + $Exe + '" ' + $ArgLine + ' >> "' + $log + '" 2>&1"'
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($psi)
}

# 有 TLS 证书时网关跑 HTTPS，且证书只对 MagicDNS 域名有效（用 IP / localhost 会证书不匹配），
# 状态页必须给出真实可点的地址，否则照抄一个 http://127.0.0.1 过去只会打不开。
function Get-FrontendUrl {
    $cert = Join-Path (Join-Path $env:USERPROFILE '.pilotdeck\tls') 'pilotv-fullchain.pem'
    $key = Join-Path (Join-Path $env:USERPROFILE '.pilotdeck\tls') 'pilotv-key.pem'
    if (-not ((Test-Path $cert) -and (Test-Path $key))) { return "http://127.0.0.1:$UiPort/" }
    $frontHost = ''
    try {
        $tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
        if (Test-Path $tsExe) {
            $json = & $tsExe status --json 2>$null | ConvertFrom-Json
            $frontHost = ($json.Self.DNSName -as [string]).TrimEnd('.')
        }
    } catch { $frontHost = '' }
    if (-not $frontHost) { $frontHost = 'localhost' }
    return "https://${frontHost}:${UiPort}/"
}

function Show-Status {
    $front = Get-FrontendUrl
    $rows = @(
        @{ Name = '成果台';      Port = $ArtifactsPort; Url = "http://127.0.0.1:$ArtifactsPort/healthz" },
        @{ Name = 'Agent 网关';  Port = $AgentPort;     Url = "ws://127.0.0.1:$AgentPort/ws" },
        @{ Name = 'Web/API';     Port = $WebPort;       Url = "http://127.0.0.1:$WebPort/api/config" },
        @{ Name = '前端网关';    Port = $UiPort;        Url = $front },
        @{ Name = 'MCP 侧车';    Port = $McpPort;       Url = "http://127.0.0.1:$McpPort/api/artifacts-mcp" }
    )
    foreach ($r in $rows) {
        $mark = if (Test-Port $r.Port) { '[运行中]' } else { '[未启动]' }
        '{0,-12} {1,-6} {2,-9} {3}' -f $r.Name, $r.Port, $mark, $r.Url
    }
}

function Stop-All {
    # 不再信任 pids.json：里面是 cmd 包装进程的旧 PID，而 Windows 会复用 PID，
    # 直接 taskkill /T /F 有误杀无关进程的风险。改为按端口反查 + 命令行校验。
    $targets = @(
        @{ Name = '成果台';    Port = $ArtifactsPort; Match = 'serve_artifacts.py' },
        @{ Name = 'Agent 网关'; Port = $AgentPort;     Match = 'pilotdeck.ts' },
        @{ Name = 'Web/API';   Port = $WebPort;       Match = 'server/index.js' },
        @{ Name = '前端网关';  Port = $UiPort;        Match = 'pilotv_gateway.mjs' },
        @{ Name = 'MCP 侧车';  Port = $McpPort;       Match = 'artifacts-mcp.mjs' }
    )
    foreach ($t in $targets) {
        $owners = @()
        try {
            $owners = @(Get-NetTCPConnection -LocalPort $t.Port -State Listen -ErrorAction Stop |
                        Select-Object -ExpandProperty OwningProcess -Unique)
        } catch { $owners = @() }
        $procs = @()
        foreach ($ownerPid in $owners) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
            if ($proc -and $proc.CommandLine -like "*$($t.Match)*") { $procs += $proc }
            $procs += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownerPid" -ErrorAction SilentlyContinue |
                        Where-Object { $_.CommandLine -like "*$($t.Match)*" })
        }
        $procs = @($procs | Sort-Object ProcessId -Unique)
        if ($procs.Count -eq 0) { Write-Host "$($t.Name) 未运行，跳过"; continue }
        foreach ($p in $procs) {
            & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null
            Write-Host "已停止 $($t.Name) (PID $($p.ProcessId)，命令行已校验)"
        }
    }
    Write-Host '注意：18789 gateway 由 detached supervisor 守护，-Stop 后会自动重启；'
    Write-Host '      要彻底停止需先结束 supervisor 或停用 gateway-keeper 插件。'
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if ($Status) { Show-Status; return }
if ($Stop) { Stop-All; return }

# --- 前置检查 -------------------------------------------------------------
if (-not (Test-Path $Python)) { throw "缺少虚拟环境：$Python`n先执行 python -m venv .venv 并 pip install -r requirements.txt" }
if (-not (Test-Path (Join-Path $UiDist 'index.html'))) { throw "前端未构建：$UiDist 不存在，先 cd `"$UiDir`" 执行 npm run build" }
if (-not (Test-Path $TsxPkg)) { throw "缺少 tsx：$TsxPkg（在 upstream-official 下执行 corepack pnpm install --no-frozen-lockfile 补齐）" }
# 统一机器令牌：必须与 NAS 网关的 PILOTV_ARTIFACTS_TOKEN 是同一把。
# 网关转发 /api/artifacts 时会把浏览器凭据换成自己持有的令牌，两边不一致就会 401。
# 放在分支外，保证网关无论本次是否补启都拿得到令牌。
$ArtifactsTokenFile = Join-Path $env:USERPROFILE '.pilotdeck\artifacts-token'
if (-not (Test-Path $ArtifactsTokenFile)) { throw "缺少成果台令牌文件：$ArtifactsTokenFile" }
$env:PILOTV_ARTIFACTS_TOKEN = (Get-Content $ArtifactsTokenFile -Raw).Trim()

# 房间编排器：与 NAS 的 pilotv-artifacts.service 对齐。Start-Svc 起的子进程继承
# 这里的环境；不开的话房间只存明文，@成员时不会自动唤起 worker / reviewer 会话。
# 20 次是房间终身投递预算（防互相 @ 死循环），用完要新建房间。
$env:PILOTV_ROOM_ORCHESTRATOR = '1'
$env:PILOTV_ROOM_GATEWAY_WS = "ws://127.0.0.1:$AgentPort/ws"
$env:PILOTV_ROOM_DELIVERY_BUDGET = '20'

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$pids = @{}

# --- 1. 成果台 ------------------------------------------------------------
if (Test-Port $ArtifactsPort) {
    Write-Host "成果台已在 $ArtifactsPort 运行，沿用现有实例"
} else {
    # 对 Tailscale 网络开放：NAS 网关切到本机设备时直连 <TailscaleIP>:8799。
    # serve_artifacts.py 会拒绝「非回环绑定 + 无令牌」，令牌走文件而不是命令行/脚本。
    $p = Start-Svc $Python "service/serve_artifacts.py --host 0.0.0.0 --port $ArtifactsPort --token-file `"$ArtifactsTokenFile`"" $Root 'artifacts.log'
    $pids.artifacts = $p.Id
    if (Wait-Port $ArtifactsPort 15000) { Write-Host "成果台已启动    http://127.0.0.1:$ArtifactsPort/" }
    else { Write-Warning "成果台启动超时，见 .run\artifacts.log" }
}

# --- 2. Agent 网关（18789）------------------------------------------------
# 必须是 18789：Web/API 服务默认按 ws://127.0.0.1:18789/ws 连它。
if (Test-Port $AgentPort) {
    Write-Host "Agent 网关已在 $AgentPort 运行，沿用现有实例"
} else {
    # Agent 网关不用 pnpm 的 tsx.CMD 转发：那是个批处理壳，cmd /c 再套一层批处理，
    # 启动器一退出控制台就跟着关，node 收到 CTRL_CLOSE 事件会「优雅」自杀——
    # 现象是刚报「已启动」、几秒后端口就没了，日志里连报错都没有。
    # 直接用 node + tsx 的 loader 跑，和 Web/API 服务同一条路，才活得下来。
    $p = Start-Svc $NodeExe "--import tsx src/cli/pilotdeck.ts server --port $AgentPort" $Upstream 'agent.log'
    $pids.agent = $p.Id
    if (Wait-Port $AgentPort 90000) {
        # 端口通了不等于活下来：若启动器所在的控制台很快被回收，node 会收到控制台关闭
        # 事件而静默退出（日志里没有任何报错）。这里再等 6 秒复核一次，避免误报「已启动」。
        Start-Sleep -Seconds 6
        if (Test-Port $AgentPort) {
            Write-Host "Agent 网关已启动 ws://127.0.0.1:$AgentPort/ws"
        } else {
            Write-Warning "Agent 网关起来后又退出了（6 秒内端口消失）。多半是启动器所在的控制台被关掉了："
            Write-Warning "  请在资源管理器里双击 start-windows.cmd，或在普通 PowerShell 窗口运行本脚本。"
        }
    }
    else { Write-Warning "Agent 网关启动超时，见 .run\agent.log（多半是 ~/.pilotdeck/pilotdeck.yaml 缺 agent/model 段）" }
}

# --- 3. Web/API 服务（3001）-----------------------------------------------
# Express 服务：静态 dist + 全部 /api/*。缺了它，页面能开但所有操作都会失败。
if (Test-Port $WebPort) {
    Write-Host "Web/API 已在 $WebPort 运行，沿用现有实例"
} else {
    $env:SERVER_PORT = "$WebPort"
    # 对 Tailscale 网络开放：NAS 的 PilotV 网关按 IP:3001 转发，绑回环会直接连不上。
    # 必须同时开启密码鉴权，否则等于把免登录后端暴露给整个 Tailscale 网络。
    $env:HOST = '0.0.0.0'
    $env:PILOTDECK_DISABLE_LOCAL_AUTH = '0'
    $env:PILOTDECK_GATEWAY_URL = "ws://127.0.0.1:$AgentPort/ws"
    $p = Start-Svc $NodeExe '--import tsx server/index.js' $UiDir 'web.log'
    $pids.web = $p.Id
    if (Wait-Port $WebPort 90000) { Write-Host "Web/API 已启动  http://127.0.0.1:$WebPort/api/config" }
    else { Write-Warning "Web/API 启动超时，见 .run\web.log" }
}

# --- 4. 前端 + 网关（5186）------------------------------------------------
if (Test-Port $UiPort) {
    Write-Host "前端网关已在 $UiPort 运行，沿用现有实例"
} else {
    # 网关用 service/data/devices.local.json.lock 记自己的 PID。进程被强杀后锁会留下，
    # 而 Windows 会复用 PID，于是下次启动可能误判「已有网关在跑」而拒绝启动。
    $lockFile = Join-Path $Root 'service\data\devices.local.json.lock'
    if (Test-Path $lockFile) {
        $lockPid = (Get-Content $lockFile -Raw).Trim()
        $owner = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
        if (-not $owner -or $owner.ProcessName -notmatch 'node') {
            Remove-Item $lockFile -Force
            Write-Host "清理残留网关锁（PID $lockPid 已不是 node 进程）"
        }
    }

    $env:UI_PORT = "$UiPort"
    $env:PROXY_HOST = '127.0.0.1'
    $env:SERVER_PORT = "$WebPort"
    $env:PILOTDECK_BACKEND = "127.0.0.1:$WebPort"
    $env:PILOTV_DIST = $UiDist
    $env:PILOTV_DEVICES = Join-Path $UiDir 'public\devices.json'
    $env:PILOTV_ARTIFACTS_TARGET = "http://127.0.0.1:$ArtifactsPort"
    $env:PILOTV_ARTIFACTS_PER_DEVICE = '1'
    $env:PILOTV_WEKNORA_PORT = '8080'

    # HTTPS：优先用 Tailscale 签发的可信证书（Let's Encrypt，SAN = MagicDNS 域名）。
    # 安卓浏览器把 PilotV 装成桌面应用（PWA）需要安全上下文，纯 HTTP 不满足。
    # 证书由 scripts\renew_gateway_tls.ps1 自动续期。
    # 注意：证书只对 MagicDNS 域名有效，对外访问请用 https://<MagicDNS 域名>:5186/，
    # 直接用 Tailscale IP 会证书不匹配。
    $TlsDir = Join-Path $env:USERPROFILE '.pilotdeck\tls'
    $TlsCert = Join-Path $TlsDir 'pilotv-fullchain.pem'
    $TlsKey = Join-Path $TlsDir 'pilotv-key.pem'
    if ((Test-Path $TlsCert) -and (Test-Path $TlsKey)) {
        $env:PILOTV_TLS_CERT = $TlsCert
        $env:PILOTV_TLS_KEY = $TlsKey
        Write-Host "HTTPS 已启用（证书 $TlsCert）"
    } else {
        Write-Warning "未找到 TLS 证书（$TlsDir），网关将以 HTTP 启动；先运行 scripts\renew_gateway_tls.ps1 签发"
    }

    $p = Start-Svc 'node' 'service/pilotv_gateway.mjs' $Root 'gateway.log'
    $pids.gateway = $p.Id
    if (Wait-Port $UiPort 20000) { Write-Host "前端已启动      $(Get-FrontendUrl)" }
    else { Write-Warning "前端启动超时，见 .run\gateway.log" }
}

# --- 5. 成果台 MCP 侧车（8801）-------------------------------------------
# 房间成员靠 post_room_message / read_room_messages 回写转录，工具由这个侧车提供。
# SDK 在 vendored upstream-official 的 node_modules 里，显式指过去，免得去找
# Linux 默认的 ~/PilotDeck-src（本机不存在）。
if (Test-Port $McpPort) {
    Write-Host "MCP 侧车已在 $McpPort 运行，沿用现有实例"
} else {
    $env:PILOTDECK_SRC = $Upstream
    $env:ARTIFACTS_API = "http://127.0.0.1:$ArtifactsPort"
    $env:ARTIFACTS_PORT = "$McpPort"
    $p = Start-Svc 'node' 'artifacts-mcp.mjs' $Root 'mcp.log'
    $pids.mcp = $p.Id
    if (Wait-Port $McpPort 20000) { Write-Host "MCP 侧车已启动  http://127.0.0.1:$McpPort/api/artifacts-mcp" }
    else { Write-Warning "MCP 侧车启动超时，见 .run\mcp.log" }
}

# 本轮可能只补启了部分服务（其余沿用现有实例），合并旧记录，
# 否则 -Stop 会因为 PID 文件被覆盖而漏杀还在跑的那几个。
if (Test-Path $PidFile) {
    try {
        $old = Get-Content $PidFile -Raw | ConvertFrom-Json
        foreach ($prop in $old.PSObject.Properties) {
            if ($prop.Name -ne 'pids' -and -not $pids.ContainsKey($prop.Name)) {
                $stillThere = Get-Process -Id $prop.Value -ErrorAction SilentlyContinue
                if ($stillThere) { $pids[$prop.Name] = $prop.Value }
            }
        }
    } catch { }
}
$pids | ConvertTo-Json | Set-Content -Path $PidFile -Encoding utf8

Write-Host ''
Show-Status
Write-Host ''
Write-Host "打开 $(Get-FrontendUrl)    停止 .\start-windows.ps1 -Stop"
