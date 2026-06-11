# Clawd — Restart helper (self-elevating)
#
# Stops and restarts the Clawd Scheduled Task. Because the task runs as
# NT AUTHORITY\SYSTEM with RunLevel=Highest, schtasks /End and /Run both require
# admin to call. This script auto-elevates via UAC if launched non-elevated.
#
# Usage:
#   pwsh .\scripts\service\Restart-Clawd.ps1
#   pwsh .\scripts\service\Restart-Clawd.ps1 -Name custom

[CmdletBinding()]
param(
    [string]$Name = "Clawd"
)

$ErrorActionPreference = "Stop"

# --- Self-elevate -----------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "[restart] Not elevated. Spawning UAC prompt..." -ForegroundColor Yellow
    $argList = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-Name", $Name
    )
    Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs
    exit 0
}

# --- Restart logic (runs elevated) -----------------------------------------
$existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[restart] Task '$Name' is not registered. Run install-task.ps1 first." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "[restart] Stopping task '$Name' (current state: $($existing.State))..." -ForegroundColor Cyan
& schtasks.exe /End /TN $Name 2>&1 | Out-Null

# Wait for node.exe child to actually exit
$timeout = [DateTime]::Now.AddSeconds(15)
while ([DateTime]::Now -lt $timeout) {
    $stillUp = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'clawd.*dist\\index\.js' }
    if (-not $stillUp) { break }
    Start-Sleep -Milliseconds 500
}

$state = (Get-ScheduledTask -TaskName $Name).State
Write-Host "[restart] Task state after stop: $state" -ForegroundColor DarkGray

Write-Host "[restart] Starting task..." -ForegroundColor Cyan
& schtasks.exe /Run /TN $Name 2>&1 | Out-Null

Start-Sleep -Seconds 4
$info = Get-ScheduledTaskInfo -TaskName $Name
$state = (Get-ScheduledTask -TaskName $Name).State
Write-Host "[restart] State:        $state" -ForegroundColor Green
Write-Host "[restart] Last run:     $($info.LastRunTime)" -ForegroundColor Green
Write-Host "[restart] Last result:  0x$([Convert]::ToString($info.LastTaskResult, 16).ToUpper())" -ForegroundColor Green

$nodeProc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'clawd.*dist\\index\.js' } |
    Select-Object -First 1
if ($nodeProc) {
    Write-Host "[restart] node.exe PID=$($nodeProc.ProcessId) is up." -ForegroundColor Green
} else {
    Write-Host "[restart] WARN: no node.exe matching dist\index.js found yet — task may still be spawning." -ForegroundColor Yellow
    Write-Host "[restart] Check logs: Get-Content X:\ClawdData\logs\service.stderr.log -Tail 50" -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to close"
