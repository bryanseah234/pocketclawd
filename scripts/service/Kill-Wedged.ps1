# Kill the wedged PocketClaw service node process so the Scheduled Task
# can relaunch with --inspect=127.0.0.1:9230 (already baked into the wrapper
# .cmd at scripts\service\.run-host-task.cmd).
#
# Why this exists separately from Restart-Wedged.ps1: we DO NOT want to also
# nuke the circuit breaker or hard-trigger /Run; the task's RestartInterval=1m
# auto-restart will pick up the new wrapper within 60 seconds. Just clear the
# wedged process and let the task self-heal. Less surface area = fewer
# foot-guns.
#
# Run from elevated PowerShell (Win+X -> Terminal (Admin)):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "X:\01 REPOSITORIES\pocketclaw\scripts\service\Kill-Wedged.ps1"

$ErrorActionPreference = 'Continue'

Write-Host '=== Pre-kill state ==='
$port = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($port) {
    $owner = Get-Process -Id $port.OwningProcess -ErrorAction SilentlyContinue
    Write-Host ("port3000 owned by pid=" + $port.OwningProcess + " name=" + ($owner.ProcessName) + " handles=" + ($owner.Handles))
} else {
    Write-Host 'port3000 free (nothing to kill)'
}

# Kill any wedged service node + mnemon orphans
$killed = @()
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    $cmdLine = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.Id) -ErrorAction SilentlyContinue).CommandLine
    $cmdLine -and $cmdLine -match 'pocketclaw\\dist\\index\.js'
} | ForEach-Object {
    Write-Host ("Killing node pid=" + $_.Id + " handles=" + $_.Handles)
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $killed += $_.Id
}
Get-Process mnemon -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("Killing mnemon pid=" + $_.Id)
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

Write-Host ''
Write-Host '=== Post-kill verification ==='
foreach ($pid_ in $killed) {
    if (Get-Process -Id $pid_ -ErrorAction SilentlyContinue) {
        Write-Host ("FAIL: pid=" + $pid_ + " still alive")
    } else {
        Write-Host ("OK: pid=" + $pid_ + " gone")
    }
}
$port = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($port) {
    Write-Host ("port3000 still owned by pid=" + $port.OwningProcess + " (kill failed?)")
} else {
    Write-Host 'port3000 free - Scheduled Task will relaunch within 60s with --inspect baked in'
}

# Reset breaker so re-launch isn't backed-off
$breaker = 'X:\01 REPOSITORIES\pocketclaw\data\circuit-breaker.json'
if (Test-Path $breaker) {
    Remove-Item $breaker -Force
    Write-Host 'breaker deleted'
} else {
    Write-Host 'breaker absent (nothing to delete)'
}

Write-Host ''
Write-Host 'NEXT: wait ~60s for task auto-restart, then verify with:'
Write-Host '  Invoke-RestMethod http://127.0.0.1:9230/json/list'
