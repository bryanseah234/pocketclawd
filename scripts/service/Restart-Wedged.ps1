param()
$ErrorActionPreference = 'Continue'

Write-Host '=== Pre-kill state ==='
$old = Get-Process -Id 2436 -ErrorAction SilentlyContinue
if ($old) {
    Write-Host ("PID 2436 alive Handles=" + $old.Handles)
} else {
    Write-Host 'PID 2436 not alive'
}

Write-Host ''
Write-Host '=== Kill wedged service node + any mnemon orphans ==='
Stop-Process -Id 2436 -Force -ErrorAction SilentlyContinue
Get-Process mnemon -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$still = Get-Process -Id 2436 -ErrorAction SilentlyContinue
if ($still) {
    Write-Host 'WARNING: PID 2436 still alive after Stop-Process — UAC may not be elevated. Aborting.'
    exit 1
}
Write-Host 'PID 2436 gone.'

Write-Host ''
Write-Host '=== Reset circuit breaker ==='
$cb = 'X:\01 REPOSITORIES\pocketclaw\data\circuit-breaker.json'
if (Test-Path $cb) {
    Remove-Item $cb -Force
    Write-Host 'breaker deleted'
} else {
    Write-Host 'no breaker (clean)'
}

Write-Host ''
Write-Host '=== Restart task ==='
schtasks /Run /TN PocketClaw
Start-Sleep -Seconds 8

Write-Host ''
Write-Host '--- 60s tail ---'
$end = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $end) {
    $err = Get-Content 'X:\PocketClawData\logs\service.stderr.log' -Tail 200 -ErrorAction SilentlyContinue
    $t = ($err | Select-String 'TIMEOUT' | Measure-Object).Count
    $b = ($err | Select-String 'BUSY' | Measure-Object).Count
    $d = ($err | Select-String 'BACKPRESSURE' | Measure-Object).Count
    $port = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    $p = $port -ne $null
    $newNode = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne 26364 -and $_.Id -ne 2436 } | Select-Object -First 1
    $h = if ($newNode) { $newNode.Handles } else { 0 }
    $pid_ = if ($newNode) { $newNode.Id } else { 0 }
    Write-Host ("  t=" + (Get-Date -Format HH:mm:ss) + " pid=" + $pid_ + " timeout=" + $t + " busy=" + $b + " bp=" + $d + " port3000=" + $p + " handles=" + $h)
    Start-Sleep -Seconds 5
}

Write-Host ''
Write-Host '=== Final summary ==='
$err = Get-Content 'X:\PocketClawData\logs\service.stderr.log' -Tail 500 -ErrorAction SilentlyContinue
$tail = Get-Content 'X:\PocketClawData\logs\service.stdout.log' -Tail 10 -ErrorAction SilentlyContinue
Write-Host ("stderr tail TIMEOUT=" + (($err | Select-String 'TIMEOUT' | Measure-Object).Count) + " BUSY=" + (($err | Select-String 'BUSY' | Measure-Object).Count) + " BACKPRESSURE=" + (($err | Select-String 'BACKPRESSURE' | Measure-Object).Count))
Write-Host ''
Write-Host '--- last 10 stdout lines ---'
$tail | ForEach-Object { Write-Host $_ }
