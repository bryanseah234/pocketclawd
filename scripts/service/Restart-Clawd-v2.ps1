# Clawd — Restart helper v2 (robust, port-3000-anchored)
#
# Why v2: the v1 script identified the service by CommandLine regex, but S4U-launched
# node processes report blank CommandLine to non-admin readers. So the "is it dead?"
# loop trivially "passed" while a zombie node held port 3000, and the subsequent
# /Run failed with 0x1 (EADDRINUSE) silently because schtasks stderr was muted.
#
# v2 anchors identity on Get-NetTCPConnection -LocalPort 3000 (always reliable),
# uses taskkill /F /T to defeat S4U token oddities, and refuses to /Run until the
# port is free. Errors are loud; failure path waits for Enter so you can read them.

[CmdletBinding()]
param(
    [string]$Name = "Clawd",
    [int]$Port    = 3000,
    [int]$KillTimeoutSec = 20,
    [int]$StartTimeoutSec = 30
)

$ErrorActionPreference = "Stop"

function Get-ServicePid {
    param([int]$P)
    $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess } else { return $null }
}

function Wait-PortFree {
    param([int]$P, [int]$Sec)
    $deadline = (Get-Date).AddSeconds($Sec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-ServicePid -P $P)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-PortListening {
    param([int]$P, [int]$Sec, [int]$ExcludePid)
    $deadline = (Get-Date).AddSeconds($Sec)
    while ((Get-Date) -lt $deadline) {
        $newPid = Get-ServicePid -P $P
        if ($newPid -and $newPid -ne $ExcludePid) { return $newPid }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

# --- Self-elevate -----------------------------------------------------------
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "[restart] Not elevated. Spawning UAC prompt..." -ForegroundColor Yellow
    $argList = @("-NoProfile","-ExecutionPolicy","Bypass","-File", $PSCommandPath,
                 "-Name", $Name, "-Port", $Port,
                 "-KillTimeoutSec", $KillTimeoutSec, "-StartTimeoutSec", $StartTimeoutSec)
    Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs
    exit 0
}

trap {
    Write-Host ""
    Write-Host "[restart] FATAL: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
    Read-Host "Press Enter to close"
    exit 99
}

# --- Verify task exists ------------------------------------------------------
$existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[restart] Task '$Name' is not registered. Run install-task.ps1 first." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

# --- Identify current service by port ---------------------------------------
$oldPid = Get-ServicePid -P $Port
if ($oldPid) {
    Write-Host "[restart] Current service: PID=$oldPid holding port $Port (task state: $($existing.State))" -ForegroundColor Cyan
} else {
    Write-Host "[restart] No process holding port $Port (task state: $($existing.State))" -ForegroundColor DarkGray
}

# --- Stop the scheduled task itself (best-effort, don't trust it) -----------
Write-Host "[restart] schtasks /End /TN $Name ..." -ForegroundColor Cyan
$endOut = & schtasks.exe /End /TN $Name 2>&1
$endRc  = $LASTEXITCODE
Write-Host "  rc=$endRc out=$($endOut -join ' ')" -ForegroundColor DarkGray

# --- Hard-kill the port-3000 owner if still alive ---------------------------
if ($oldPid) {
    if (-not (Wait-PortFree -P $Port -Sec 3)) {
        Write-Host "[restart] taskkill /F /T /PID $oldPid ..." -ForegroundColor Cyan
        $killOut = & taskkill.exe /F /T /PID $oldPid 2>&1
        $killRc  = $LASTEXITCODE
        Write-Host "  rc=$killRc out=$($killOut -join ' ')" -ForegroundColor DarkGray
        if ($killRc -ne 0 -and $killRc -ne 128) {
            # 128 = process already gone, which is fine
            try {
                Write-Host "[restart] fallback: Stop-Process -Force -Id $oldPid" -ForegroundColor Yellow
                Stop-Process -Id $oldPid -Force -ErrorAction Stop
            } catch {
                Write-Host "[restart] Stop-Process also failed: $($_.Exception.Message)" -ForegroundColor Red
            }
        }
    }

    if (-not (Wait-PortFree -P $Port -Sec $KillTimeoutSec)) {
        $stuckPid = Get-ServicePid -P $Port
        Write-Host "[restart] FAIL: port $Port still held by PID=$stuckPid after ${KillTimeoutSec}s" -ForegroundColor Red
        Write-Host "[restart] Manual fix: open elevated terminal and run 'taskkill /F /T /PID $stuckPid'" -ForegroundColor Yellow
        Read-Host "Press Enter to close"
        exit 2
    }
    Write-Host "[restart] port $Port is free." -ForegroundColor Green
}

# --- Optional: clear circuit breaker so backoff doesn't bite ----------------
$breaker = "X:\01 REPOSITORIES\clawd\data\circuit-breaker.json"
if (Test-Path $breaker) {
    Remove-Item -Force $breaker
    Write-Host "[restart] cleared circuit breaker" -ForegroundColor DarkGray
}

# --- Start --------------------------------------------------------------------
Write-Host "[restart] schtasks /Run /TN $Name ..." -ForegroundColor Cyan
$runOut = & schtasks.exe /Run /TN $Name 2>&1
$runRc  = $LASTEXITCODE
Write-Host "  rc=$runRc out=$($runOut -join ' ')" -ForegroundColor DarkGray
if ($runRc -ne 0) {
    Write-Host "[restart] FAIL: schtasks /Run returned rc=$runRc" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 3
}

# --- Verify new process is up + listening -----------------------------------
$newPid = Wait-PortListening -P $Port -Sec $StartTimeoutSec -ExcludePid ([int]($oldPid))
if (-not $newPid) {
    Write-Host "[restart] FAIL: nothing started listening on port $Port within ${StartTimeoutSec}s" -ForegroundColor Red
    $info = Get-ScheduledTaskInfo -TaskName $Name
    Write-Host "[restart] task LastResult=0x$([Convert]::ToString($info.LastTaskResult,16))" -ForegroundColor Yellow
    Write-Host "[restart] check stderr: Get-Content X:\ClawdData\logs\service.stderr.log -Tail 80" -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 4
}

$proc = Get-Process -Id $newPid -ErrorAction SilentlyContinue
$started = if ($proc) { $proc.StartTime } else { "?" }
Write-Host ""
Write-Host "[restart] OK: new PID=$newPid started=$started listening on $Port" -ForegroundColor Green
$info = Get-ScheduledTaskInfo -TaskName $Name
Write-Host "[restart] task LastRun=$($info.LastRunTime) LastResult=0x$([Convert]::ToString($info.LastTaskResult,16))" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close"
