# Kill the wedged Clawd service node process and trigger the
# Scheduled Task to relaunch (the AtStartup trigger does NOT auto-fire
# again after manual exit; an explicit /Run is required).
#
# Run from elevated PowerShell (Win+X -> Terminal (Admin)):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "X:\01 REPOSITORIES\clawd\scripts\service\Kill-Wedged.ps1"

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
    $cmdLine -and $cmdLine -match 'clawd\\dist\\index\.js'
} | ForEach-Object {
    Write-Host ("Killing node pid=" + $_.Id + " handles=" + $_.Handles)
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $killed += $_.Id
}
Get-Process mnemon -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("Killing mnemon pid=" + $_.Id)
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

# Wait for the wedged process(es) to actually exit. A node holding 50k+
# handles can take 5-15s to fully tear down after Stop-Process; checking
# at 2s as the previous version did would always FAIL falsely.
Write-Host ''
Write-Host '=== Waiting for processes to exit (up to 30s) ==='
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $stillAlive = @($killed | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($stillAlive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
}

Write-Host ''
Write-Host '=== Post-kill verification ==='
foreach ($pid_ in $killed) {
    if (Get-Process -Id $pid_ -ErrorAction SilentlyContinue) {
        Write-Host ("FAIL: pid=" + $pid_ + " still alive after 30s")
    } else {
        Write-Host ("OK: pid=" + $pid_ + " gone")
    }
}
$port = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($port) {
    Write-Host ("port3000 still owned by pid=" + $port.OwningProcess + " (kill failed?)")
} else {
    Write-Host 'port3000 free'
}

# Reset breaker so re-launch isnt backed-off
$breaker = 'X:\01 REPOSITORIES\clawd\data\circuit-breaker.json'
if (Test-Path $breaker) {
    Remove-Item $breaker -Force
    Write-Host 'breaker deleted'
} else {
    Write-Host 'breaker absent (nothing to delete)'
}

# Explicit /Run - AtStartup trigger does not auto-fire after manual exit,
# so RestartInterval=1m on the failed task does NOT replace this. Tested
# 22 May 2026: without /Run the host stays down indefinitely.
Write-Host ''
Write-Host '=== Triggering Scheduled Task ==='
$proc = Start-Process -FilePath schtasks.exe -ArgumentList '/Run','/TN','Clawd' -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -eq 0) {
    Write-Host 'schtasks /Run Clawd OK'
} else {
    Write-Host ("schtasks /Run failed rc=" + $proc.ExitCode + " - run manually: schtasks /Run /TN Clawd")
}

Write-Host ''
Write-Host 'NEXT: ~10-20s for service to come up, then verify with:'
Write-Host '  Get-NetTCPConnection -LocalPort 3000 -State Listen'
Write-Host '  Get-Content X:\ClawdData\logs\service.stdout.log -Tail 10'
