<#
  PilotV 前端网关 TLS 证书自动续期（Windows 版）
  -----------------------------------------------
  对应仓库里的 scripts/renew_gateway_tls.sh（Linux 版）。语义一致：

    1. 读取当前证书的 NotAfter；剩余有效期 > MinValidHours（默认 720h = 30 天）就直接跳过。
    2. 否则用 tailscale cert 在临时目录签发一张新证书（Let's Encrypt，SAN = MagicDNS 域名）。
    3. 校验新证书：能解析、有效期在未来、域名对得上、密钥非空。
    4. 与现有证书比对：完全一样就不动文件、不重启。
    5. 替换证书（先写 .new 再 Move，避免半截文件），然后只重启 5186 前端网关那一个进程，
       其余三个服务（8799 / 18789 / 3001）保持不动。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\renew_gateway_tls.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\renew_gateway_tls.ps1 -Force   # 忽略剩余有效期，强制重签
#>
[CmdletBinding()]
param(
    [int]$MinValidHours = 720,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$TlsDir    = Join-Path $env:USERPROFILE '.pilotdeck\tls'
$CertPath  = Join-Path $TlsDir 'pilotv-fullchain.pem'
$KeyPath   = Join-Path $TlsDir 'pilotv-key.pem'
$TsExe     = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
$RunDir    = Join-Path $Root '.run'
$LogFile   = Join-Path $RunDir 'tls-renew.log'
$UiPort    = 5186

function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Force -Path $RunDir | Out-Null }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
    } catch { }
}

# 从 PEM 里取第一张证书并解析成 X509Certificate2
# 注意两点：
#   1) 不能 new X509Certificate2($pemPath)：fullchain 里有多张证书，只有走正则取第一段才稳；
#   2) 不能写 New-Object X509Certificate2($der) —— byte[] 会被 PowerShell 展开成
#      几百个位置参数（报「找不到重载，参数计数为 923」），必须用 ::new() 或 -ArgumentList (,$der)。
function Read-PemCert([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $pem = [System.IO.File]::ReadAllText($Path)
        $m = [regex]::Match($pem, '-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----')
        if ($m.Success) {
            $b64 = ($m.Value -replace '-----BEGIN CERTIFICATE-----', '' -replace '-----END CERTIFICATE-----', '' -replace '\s', '')
            $der = [Convert]::FromBase64String($b64)
            return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
        }
        return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($Path)
    } catch {
        try { return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($Path) } catch { return $null }
    }
}

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Test-Port([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port)
        $c.Close()
        return $true
    } catch { return $false }
}

$tmp = $null
try {
    # --- 0. 前置 ---------------------------------------------------------
    if (-not (Test-Path -LiteralPath $TsExe)) {
        Write-Log "找不到 tailscale.exe（$TsExe），无法签发证书。"
        exit 2
    }

    # MagicDNS 域名：证书只对这个名字有效，用 Tailscale IP 会证书不匹配
    $dnsName = ''
    try {
        $tsJson = (& $TsExe status --json 2>$null | Out-String) | ConvertFrom-Json
        $dnsName = ($tsJson.Self.DNSName -as [string]).TrimEnd('.')
    } catch { $dnsName = '' }
    if (-not $dnsName) {
        Write-Log '取不到本机的 MagicDNS 域名（tailscale status --json 失败），放弃续期。'
        exit 3
    }
    Write-Log "MagicDNS 域名：$dnsName"

    # --- 1. 现有证书还够用吗 ---------------------------------------------
    $current = Read-PemCert $CertPath
    if ($current -and -not $Force) {
        $remainHours = ($current.NotAfter - (Get-Date)).TotalHours
        Write-Log ("当前证书：{0}  到期 {1}  剩余 {2:N1} 小时" -f $current.Subject, $current.NotAfter, $remainHours)
        if ($remainHours -gt $MinValidHours) {
            Write-Log ("剩余有效期 > {0}h，跳过续期。" -f $MinValidHours)
            exit 0
        }
        Write-Log '剩余有效期不足，开始续期。'
    } elseif ($Force) {
        Write-Log '指定 -Force，忽略现有证书有效期，强制重新签发。'
    } else {
        Write-Log '当前没有可用证书，直接签发。'
    }

    # --- 2. 临时目录里签发新证书 ----------------------------------------
    $tmp = Join-Path $env:TEMP ('pilotv-tls-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $newCert = Join-Path $tmp 'fullchain.pem'
    $newKey  = Join-Path $tmp 'key.pem'

    Write-Log "签发中：tailscale cert --min-validity=$($MinValidHours)h $dnsName"
    # tailscale 会把提示写到 stderr，PS 5.1 下会抛 NativeCommandError，这里临时降级
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $TsExe cert --cert-file $newCert --key-file $newKey --min-validity="$($MinValidHours)h" $dnsName 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($code -ne 0) {
        Write-Log "tailscale cert 失败（exit=$code）：$out"
        exit 4
    }
    if (-not (Test-Path -LiteralPath $newCert) -or -not (Test-Path -LiteralPath $newKey)) {
        Write-Log '签发命令没有产出证书文件，放弃。'
        exit 5
    }

    # --- 3. 校验新证书 ---------------------------------------------------
    $new = Read-PemCert $newCert
    if (-not $new) {
        Write-Log '新证书无法解析，放弃。'
        exit 6
    }
    if ($new.NotAfter -le (Get-Date).AddHours(1)) {
        Write-Log ("新证书已经过期或即将过期（{0}），放弃。" -f $new.NotAfter)
        exit 7
    }
    if ($new.Subject -notlike ("*CN=$dnsName*")) {
        Write-Log ("新证书的 CN 与域名不符：{0}（期望 CN={1}），放弃。" -f $new.Subject, $dnsName)
        exit 8
    }
    $keyText = ''
    try { $keyText = [System.IO.File]::ReadAllText($newKey) } catch { }
    if ($keyText -notlike '*PRIVATE KEY*') {
        Write-Log '新私钥文件格式不对，放弃。'
        exit 9
    }
    Write-Log ("新证书校验通过：{0}  到期 {1}" -f $new.Subject, $new.NotAfter)

    # --- 4. 和现有证书比一比 ---------------------------------------------
    if ($current -and (Get-FileSha256 $newCert) -eq (Get-FileSha256 $CertPath) -and
        (Get-FileSha256 $newKey) -eq (Get-FileSha256 $KeyPath)) {
        Write-Log '新证书与现有证书完全相同，无需替换，也不重启网关。'
        exit 0
    }

    # --- 5. 替换证书 -----------------------------------------------------
    if (-not (Test-Path -LiteralPath $TlsDir)) { New-Item -ItemType Directory -Force -Path $TlsDir | Out-Null }
    Copy-Item -LiteralPath $newCert -Destination ($CertPath + '.new') -Force
    Copy-Item -LiteralPath $newKey  -Destination ($KeyPath + '.new')  -Force
    Move-Item -LiteralPath ($CertPath + '.new') -Destination $CertPath -Force
    Move-Item -LiteralPath ($KeyPath + '.new')  -Destination $KeyPath  -Force
    Write-Log "证书已替换：$CertPath"

    # --- 6. 只重启 5186 前端网关 -----------------------------------------
    # 绝不信任 pids.json 里的 PID：那只是 cmd 包装进程的 PID，服务重启后会变旧，
    # 而 Windows 会复用 PID，taskkill /T /F 有可能误杀无关进程甚至 agent 网关。
    # 改为按 5186 端口反查占用者，并校验命令行确实含 pilotv_gateway.mjs。
    function Get-FrontendGatewayProcesses {
        $owners = @()
        try {
            $owners = @(Get-NetTCPConnection -LocalPort $UiPort -State Listen -ErrorAction Stop |
                        Select-Object -ExpandProperty OwningProcess -Unique)
        } catch { $owners = @() }
        $found = @()
        foreach ($ownerPid in $owners) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
            if ($proc -and $proc.CommandLine -like '*pilotv_gateway.mjs*') { $found += $proc }
            $found += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownerPid" -ErrorAction SilentlyContinue |
                        Where-Object { $_.CommandLine -like '*pilotv_gateway.mjs*' })
        }
        if ($found.Count -eq 0) {
            # 端口反查不可用时的兜底：只按命令行找，仍不碰旧 PID。
            $found = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                       Where-Object { $_.CommandLine -like '*pilotv_gateway.mjs*' })
        }
        return ($found | Sort-Object ProcessId -Unique)
    }
    $gwProcs = @(Get-FrontendGatewayProcesses)
    if ($gwProcs.Count -eq 0) {
        Write-Log "端口 $UiPort 未找到命令行可校验的前端网关进程，跳过停止（不按旧 PID 误杀）"
    } else {
        foreach ($gwProc in $gwProcs) {
            Write-Log "停止前端网关（PID $($gwProc.ProcessId)，命令行已校验）"
            & taskkill.exe /PID $gwProc.ProcessId /T /F 2>&1 | Out-Null
        }
    }
    # 网关用 devices.local.json.lock 记自己的 PID，进程被强杀后锁会留下，
    # 而 Windows 会复用 PID，下次启动可能误判「已有网关在跑」而拒绝启动。
    $lockFile = Join-Path $Root 'service\data\devices.local.json.lock'
    if (Test-Path -LiteralPath $lockFile) {
        $lockPid = (Get-Content -LiteralPath $lockFile -Raw).Trim()
        $owner = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
        if (-not $owner -or $owner.ProcessName -notmatch 'node') {
            Remove-Item -LiteralPath $lockFile -Force
            Write-Log "清理残留网关锁（PID $lockPid 已不是 node 进程）"
        }
    }
    for ($i = 0; $i -lt 20 -and (Test-Port $UiPort); $i++) { Start-Sleep -Milliseconds 500 }
    Write-Log ("端口 {0} 已释放：{1}" -f $UiPort, (-not (Test-Port $UiPort)))

    Write-Log '用 start-windows.ps1 重新拉起前端网关（其余三个服务沿用现有实例）'
    $startScript = Join-Path $Root 'start-windows.ps1'
    $outLog = Join-Path $RunDir 'renew-restart.log'
    $errLog = Join-Path $RunDir 'renew-restart.err.log'
    # 用 Start-Process + 重定向到文件，不能用 & powershell.exe ... | ForEach-Object：
    # 新起的 cmd/node 会继承管道写端，管道永远不 EOF，调用方会一直挂着。
    $proc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $startScript) `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $proc.WaitForExit(120000) | Out-Null
    if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Tail 12 | ForEach-Object { Write-Log "  $_" } }
    if ((Test-Path -LiteralPath $errLog) -and (Get-Item -LiteralPath $errLog).Length -gt 0) {
        Get-Content -LiteralPath $errLog -Tail 12 | ForEach-Object { Write-Log "  [err] $_" }
    }

    # --- 7. 复核 ---------------------------------------------------------
    for ($i = 0; $i -lt 30 -and -not (Test-Port $UiPort); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Port $UiPort)) {
        Write-Log "网关没有起来，端口 $UiPort 无监听。详见 .run\gateway.log"
        exit 10
    }
    try {
        $resp = Invoke-WebRequest -Uri ("https://{0}:{1}/" -f $dnsName, $UiPort) -UseBasicParsing -TimeoutSec 20
        Write-Log ("HTTPS 自检通过：https://{0}:{1}/  → {2}" -f $dnsName, $UiPort, [int]$resp.StatusCode)
    } catch {
        Write-Log ("HTTPS 自检失败：{0}" -f $_.Exception.Message)
        exit 11
    }
    Write-Log '续期完成。'
    exit 0
} finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
