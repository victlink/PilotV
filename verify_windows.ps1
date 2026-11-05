# PilotV Windows 部署自检脚本（PowerShell 5.1 兼容，文件需保存为 UTF-8 with BOM）
# 用法：在仓库根目录执行  powershell.exe -ExecutionPolicy Bypass -File verify_windows.ps1
# 退出码 0 = 全部通过；1 = 有失败项。

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $Root 'service/pilotv_gateway.mjs'))) {
    $Root = (Get-Location).Path
}
$fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Host ("[PASS] {0}  {1}" -f $name, $detail) -ForegroundColor Green }
    else     { Write-Host ("[FAIL] {0}  {1}" -f $name, $detail) -ForegroundColor Red; $script:fail++ }
}

Write-Host "=== PilotV Windows deploy verification ==="
Write-Host ("repo: {0}" -f $Root)

# 1. 四个服务端口 + 18790 supervisor 单实例锁
$ports = @{ 8799='artifacts'; 18789='agent gateway'; 3001='web/api'; 5186='frontend'; 18790='supervisor lock' }
foreach ($p in ($ports.Keys | Sort-Object)) {
    $owners = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique)
    Check ("port {0} ({1})" -f $p, $ports[$p]) ($owners.Count -gt 0) ("pid=" + ($owners -join ','))
}

# 2. 三处 upstream 补丁是否落地
$up = Join-Path $Root 'pilotdeck-mobile/upstream-official/src'
$checks = @(
    @{ n='patch 1/3 unhandledRejection'; f=(Join-Path $up 'cli/pilotdeck.ts');                    s='unhandledRejection (gateway stays alive)' },
    @{ n='patch 2/3 partial summary';    f=(Join-Path $up 'context/compaction/CompactionEngine.ts'); s='using partial summary' },
    @{ n='patch 3/3 non-fatal decoder';  f=(Join-Path $up 'tool/builtin/bash/commandRunner.ts'); s='Replacement characters are far better' }
)
foreach ($c in $checks) {
    $hit = $false
    if (Test-Path $c.f) { $hit = [bool](Select-String -LiteralPath $c.f -Pattern $c.s -SimpleMatch -Quiet) }
    Check $c.n $hit $c.f
}

# 3. 所有 .cmd 必须是 CRLF + 纯 ASCII（LF 会让 cmd.exe 逐行读取偏移错乱并陷入死循环）
$cmds = @('start-windows.cmd','scripts/pilotv-boot.cmd','.run/agent-supervisor.cmd')
foreach ($rel in $cmds) {
    $f = Join-Path $Root $rel
    if (-not (Test-Path $f)) { Check ("cmd format {0}" -f $rel) $false 'missing'; continue }
    $b = [System.IO.File]::ReadAllBytes($f)
    $crlf = 0; $lf = 0; $nonAscii = 0
    for ($i = 0; $i -lt $b.Length; $i++) {
        if ($b[$i] -eq 10) { $lf++; if ($i -gt 0 -and $b[$i-1] -eq 13) { $crlf++ } }
        if ($b[$i] -gt 127) { $nonAscii++ }
    }
    $ok = ($lf -eq $crlf) -and ($nonAscii -eq 0) -and ($lf -gt 0)
    Check ("cmd format {0}" -f $rel) $ok ("CRLF={0} bareLF={1} nonAscii={2}" -f $crlf, ($lf-$crlf), $nonAscii)
}

# 4. devices.json 两份必须一致，且不含模板占位符
$pub = Join-Path $Root 'pilotdeck-mobile/upstream-official/ui/public/devices.json'
$dist = Join-Path $Root 'pilotdeck-mobile/upstream-official/ui/dist/devices.json'
if ((Test-Path $pub) -and (Test-Path $dist)) {
    $a = (Get-FileHash $pub -Algorithm SHA256).Hash
    $b = (Get-FileHash $dist -Algorithm SHA256).Hash
    Check 'devices.json public/dist match' ($a -eq $b) $a.Substring(0,12)
    $raw = Get-Content $pub -Raw
    Check 'devices.json no placeholders' (-not ($raw -match 'REPLACE_')) ''
} else { Check 'devices.json present' $false 'public or dist missing' }

# 5. 登录自启入口唯一：Startup 下不应同时存在 .vbs 与 .disabled
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$vbs = @(Get-ChildItem $startup -Filter 'PilotV.vbs*' -ErrorAction SilentlyContinue)
$active = @($vbs | Where-Object { $_.Name -eq 'PilotV.vbs' })
Check 'single autostart entry' ($active.Count -le 1) ("active vbs={0}, disabled={1}" -f $active.Count, ($vbs.Count - $active.Count))

# 6. autostart.log 不应异常膨胀（>5MB 说明又出现死循环）
$log = Join-Path $Root '.run/autostart.log'
if (Test-Path $log) {
    $size = (Get-Item $log).Length
    Check 'autostart.log size' ($size -lt 5MB) ("{0} bytes" -f $size)
} else { Check 'autostart.log size' $true 'absent' }

# 7. gateway 5 秒内 PID 稳定
$p1 = @(Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
Start-Sleep -Seconds 5
$p2 = @(Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
Check 'gateway pid stable (5s)' (($p1.Count -gt 0) -and (($p1 -join ',') -eq ($p2 -join ','))) ("before={0} after={1}" -f ($p1 -join ','), ($p2 -join ','))

# 8. 前端网关 HTTPS 可达。Win10 1803+ 自带 curl.exe；
#    PS 5.1 的 Invoke-WebRequest 对本机自签证书的 Schannel 协商会失败，故不用它。
$curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlExe) {
    $code = (& curl.exe -sk -m 6 -o NUL -w '%{http_code}' 'https://127.0.0.1:5186/api/pilotv/devices' 2>$null | Select-Object -Last 1)
    Check '5186 /api/pilotv/devices' ($code -eq '200') ("http=$code")
} else {
    Check '5186 /api/pilotv/devices' $false 'curl.exe not found'
}

Write-Host ""
if ($fail -eq 0) { Write-Host "ALL CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host ("{0} CHECK(S) FAILED" -f $fail) -ForegroundColor Red
exit 1
