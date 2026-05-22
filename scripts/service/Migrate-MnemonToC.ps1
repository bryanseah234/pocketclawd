<#
.SYNOPSIS
  Migrate PocketClaw mnemon SQLite store from X: (exFAT) to C: (NTFS).
  Run elevated.

.DESCRIPTION
  Root cause of SQLITE_BUSY / 15s+ TIMEOUT: X: is exFAT. exFAT lacks
  proper byte-range locking primitives, so SQLite WAL mode wedges
  even from an idle shell. Reproduced: `mnemon status` against the
  X: store fails with SQLITE_BUSY without any concurrent writer.

  Fix: keep ONLY the mnemon SQLite on C: (NTFS). All other PocketClaw
  data — vault, photos, logs, ingest staging, processed.db — stays
  on X:. Mnemon is capped via periodic `mnemon gc` cron.

  This script:
    1. Direct-kills the wedged service node + any mnemon orphans
       (does NOT use `schtasks /End` — it dirty-shuts and trips
       the circuit breaker on next start).
    2. Snapshot-copies X:\PocketClawData\mnemon -> C:\Users\bryan\.mnemon-pocketclaw
    3. Verifies the C: copy (mnemon status → reads insight count).
    4. Deletes circuit-breaker.json (safe to do; we're about to start
       cleanly).
    5. `schtasks /Run` and tail-watches stderr for 60s, counting
       TIMEOUT/BUSY events. Reports SUCCESS if both stay at 0.

  Idempotent. Re-runnable. The X: copy is preserved as a backup.

.NOTES
  .env is already pointing at C:\Users\bryan\.mnemon-pocketclaw — the
  running service has the OLD path cached because it started before
  the .env change. This script does NOT modify .env.
#>

[CmdletBinding()]
param(
  [switch]$SkipRestart,
  [string]$DataDir = 'C:\Users\bryan\.mnemon-pocketclaw'
)

$ErrorActionPreference = 'Stop'

# Elevation check
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '[ERR] Not elevated. Open PowerShell as Administrator and re-run.' -ForegroundColor Red
  exit 1
}

$repo    = 'X:\01 REPOSITORIES\pocketclaw'
$srcDir  = 'X:\PocketClawData\mnemon'
$dstDir  = $DataDir
$cbFile  = Join-Path $repo 'data\circuit-breaker.json'
$mnBin   = 'C:\Users\bryan\go\bin\mnemon.exe'

Write-Host '======================================================'
Write-Host ' PocketClaw mnemon migration: X: (exFAT) -> C: (NTFS)'
Write-Host '======================================================'
Write-Host ''
Write-Host ('  src: ' + $srcDir)
Write-Host ('  dst: ' + $dstDir)
Write-Host ''

# Verify the destination volume is NTFS — if it's somehow not, abort.
$dstVol = Get-Volume -DriveLetter ($dstDir.Substring(0,1)) -ErrorAction SilentlyContinue
if ($dstVol -and $dstVol.FileSystem -ne 'NTFS') {
  Write-Host ('[ERR] Destination volume is ' + $dstVol.FileSystem + ', not NTFS. Refusing.') -ForegroundColor Red
  Write-Host '       Pick an NTFS volume via -DataDir <path>'
  exit 4
}

# 1. Stop service + kill orphans (NO schtasks /End — that dirty-shuts and
#    trips circuit breaker. Direct process kill is clean enough; the host's
#    shutdown handlers are best-effort anyway.)
Write-Host '[1/5] Killing service host + any mnemon orphans...'

$killed = @()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine.Contains('pocketclaw')) {
    Write-Host ("  Killing node PID={0}" -f $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += "node:$($_.ProcessId)"
  }
}
Get-Process mnemon -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host ("  Killing mnemon PID={0}" -f $_.Id)
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  $killed += "mnemon:$($_.Id)"
}

# Wait up to 10s for handles to release.
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  $stillNode = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('pocketclaw') }
  $stillMn   = Get-Process mnemon -ErrorAction SilentlyContinue
  if (-not $stillNode -and -not $stillMn) { break }
}

$remain = @()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine.Contains('pocketclaw')) { $remain += "node:$($_.ProcessId)" }
}
Get-Process mnemon -ErrorAction SilentlyContinue | ForEach-Object { $remain += "mnemon:$($_.Id)" }
if ($remain.Count -gt 0) {
  Write-Host ('[ERR] Still alive after 10s: ' + ($remain -join ', '))
  Write-Host '       Kill them in Task Manager, then re-run.'
  exit 2
}
if ($killed.Count -gt 0) {
  Write-Host ('  Killed: ' + ($killed -join ', '))
} else {
  Write-Host '  Nothing to kill (already stopped).'
}
Write-Host ''

# 2. Copy mnemon store
Write-Host '[2/5] Copying mnemon store...'
if (-not (Test-Path "$srcDir\data\default\mnemon.db")) {
  Write-Host ('[ERR] Source not found: ' + "$srcDir\data\default\mnemon.db") -ForegroundColor Red
  exit 3
}
if (Test-Path $dstDir) {
  $backup = $dstDir + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Write-Host ('  Existing dst found; backing up to ' + $backup)
  Move-Item $dstDir $backup
}
New-Item -ItemType Directory -Path "$dstDir\data\default" -Force | Out-Null

Copy-Item "$srcDir\data\default\mnemon.db" "$dstDir\data\default\mnemon.db" -Force
foreach ($side in @('mnemon.db-wal', 'mnemon.db-shm')) {
  $sf = "$srcDir\data\default\$side"
  if (Test-Path $sf) { Copy-Item $sf "$dstDir\data\default\$side" -Force }
}
$dbSize = (Get-Item "$dstDir\data\default\mnemon.db").Length
Write-Host ('  Copied: ' + [math]::Round($dbSize/1MB,2) + ' MB')
Write-Host ''

# 3. Verify
Write-Host '[3/5] Verifying C: copy with mnemon status...'
$env:MNEMON_DATA_DIR = $dstDir
$env:MNEMON_DB_PATH  = "$dstDir\data\default\mnemon.db"
$verify = & $mnBin status 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $verify -notmatch 'total_insights') {
  Write-Host '[ERR] mnemon status failed against C: copy:' -ForegroundColor Red
  Write-Host $verify
  exit 5
}
$insights = ([regex]'"total_insights":\s*(\d+)').Match($verify).Groups[1].Value
$dbpath   = ([regex]'"db_path":\s*"([^"]+)"').Match($verify).Groups[1].Value
Write-Host ('  insights=' + $insights + ' db=' + $dbpath)
Write-Host ''

# 4. Reset circuit breaker (next start should be clean)
Write-Host '[4/5] Resetting circuit breaker...'
if (Test-Path $cbFile) {
  Remove-Item $cbFile -Force
  Write-Host '  Deleted circuit-breaker.json'
} else {
  Write-Host '  Already absent'
}
Write-Host ''

# 5. Restart and watch
if ($SkipRestart) {
  Write-Host '[5/5] -SkipRestart set; not relaunching.'
  exit 0
}

Write-Host '[5/5] Relaunching scheduled task and watching for 60s...'
schtasks /Run /TN PocketClaw 2>&1 | Out-Null
Start-Sleep -Seconds 5

$stderrLog = 'X:\PocketClawData\logs\service.stderr.log'
$startMark = Get-Date
$busy = 0
$timeout = 0
$lastSize = 0
if (Test-Path $stderrLog) { $lastSize = (Get-Item $stderrLog).Length }

for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  if (Test-Path $stderrLog) {
    $tail = Get-Content $stderrLog -Tail 100 -ErrorAction SilentlyContinue
    foreach ($line in $tail) {
      if ($line -match 'TIMEOUT retry')  { $timeout++ }
      if ($line -match 'BUSY retry')     { $busy++ }
    }
  }
  $elapsed = ((Get-Date) - $startMark).TotalSeconds
  $port3000 = (Test-NetConnection 127.0.0.1 -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue)
  Write-Host ('  +' + [int]$elapsed + 's: timeout=' + $timeout + ' busy=' + $busy + ' port3000=' + $port3000)
}

Write-Host ''
Write-Host '======================================================'
if ($timeout -eq 0 -and $busy -eq 0) {
  Write-Host ' [SUCCESS] No mnemon contention errors in 60s' -ForegroundColor Green
  Write-Host ''
  Write-Host ' (Note: port 3000 may take 10-15 min to bind due to the'
  Write-Host '  Telegram bot adapter network warm-up — that is unrelated'
  Write-Host '  to mnemon and is the bridge.setup retry loop.)'
} else {
  Write-Host (' [PARTIAL] Errors: timeout=' + $timeout + ' busy=' + $busy) -ForegroundColor Yellow
  Write-Host '            Tail X:\PocketClawData\logs\service.stderr.log'
}
Write-Host '======================================================'
