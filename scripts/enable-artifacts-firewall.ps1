# PilotV artifacts inbound firewall rule. Run in an elevated PowerShell.
#
# Why: on Windows the artifacts service (python.exe) listening on 0.0.0.0:8799
# has no inbound allow rule, while node.exe (3001 / 5186) does. Without this
# rule the NAS gateway times out when it forwards artifacts to this machine.
# Only the three known Tailscale peers are allowed; everything else stays blocked.

$ErrorActionPreference = 'Stop'
$ruleName = 'PilotV Artifacts 8799 (Tailscale only)'

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Rule already exists: $ruleName"
    $existing | Select-Object DisplayName, Enabled, Action, Direction, Profile
    exit 0
}

New-NetFirewallRule -DisplayName $ruleName `
    -Direction Inbound -Protocol TCP -LocalPort 8799 `
    -RemoteAddress '100.90.196.104', '100.117.103.34', '100.108.86.109' `
    -Action Allow -Profile Private,Public

Write-Host "Created: $ruleName"
Get-NetFirewallRule -DisplayName $ruleName |
    Select-Object DisplayName, Enabled, Action, Direction, Profile
