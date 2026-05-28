# Clawd — Service Uninstaller
#
# Cleanly removes the Clawd Windows service. By default leaves
# .env, vault, mnemon DB, and logs intact so you can reinstall later
# without losing data. Pass -Purge to wipe everything.
#
# Usage (from repo root):
#   .\scripts\service\uninstall.ps1                # remove service only, keep data
#   .\scripts\service\uninstall.ps1 -Name custom   # custom service name
#   .\scripts\service\uninstall.ps1 -Purge         # also delete vault, mnemon, logs, secrets
#   .\scripts\service\uninstall.ps1 -DryRun        # show plan, don't apply

[CmdletBinding()]
param(
    [string]$Name = "clawd",
    [switch]$Purge,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
function Write-Step($msg) { Write-Host "[uninstall] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[uninstall] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[uninstall] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[uninstall] $msg" -ForegroundColor Red }

# --- 1. Admin check ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "Must run as Administrator. Re-launch PowerShell elevated."
    exit 1
}

# --- 2. Locate NSSM ---------------------------------------------------------
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
    Write-Warn "NSSM not on PATH; will fall back to sc.exe to remove the service."
}

# --- 3. Show plan -----------------------------------------------------------
$pocketDir = Join-Path $env:USERPROFILE ".clawd"
$mnemonDir = Join-Path $env:USERPROFILE ".mnemon"

Write-Host ""
Write-Step "=== Uninstall Plan ==="
Write-Host "  Service:        $Name"
$existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Status:         $($existing.Status)"
} else {
    Write-Host "  Status:         not registered"
}
Write-Host ""
if ($Purge) {
    Write-Warn "  -Purge mode: WILL DELETE the following directories:"
    Write-Warn "    $pocketDir  (vault, secrets, logs, watch, processed.db)"
    Write-Warn "    $mnemonDir  (entire memory graph + oplog)"
    Write-Warn "  This is IRREVERSIBLE."
} else {
    Write-Host "  Keeping (use -Purge to delete):"
    Write-Host "    $pocketDir"
    Write-Host "    $mnemonDir"
}
Write-Host ""

if ($DryRun) {
    Write-Warn "Dry run — exiting without applying."
    exit 0
}

if ($Purge) {
    $confirm = Read-Host "Type 'yes' to confirm purging vault + mnemon"
    if ($confirm -ne 'yes') { Write-Warn "Cancelled."; exit 0 }
}

# --- 4. Stop + remove service ----------------------------------------------
if ($existing) {
    # Handle Disabled / Paused / Running states properly. Windows SCM may
    # have moved the service to Paused+Disabled after a crash-loop, both of
    # which block `nssm stop` and `nssm remove` from working cleanly.
    if ($existing.StartType -eq "Disabled") {
        Write-Step "Service is Disabled — re-enabling for clean removal..."
        & sc.exe config $Name start= demand 2>&1 | Out-Null
    }

    if ($existing.Status -eq "Paused") {
        Write-Step "Service is Paused — sending continue before stop..."
        if ($nssm) { & $nssm continue $Name 2>&1 | Out-Null }
        else { & sc.exe continue $Name 2>&1 | Out-Null }
        Start-Sleep -Seconds 1
    }

    Write-Step "Stopping service..."
    if ($nssm) { & $nssm stop $Name 2>&1 | Out-Null }
    else { Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2

    # Force-kill the supervising NSSM process if it's still up
    $svcPid = (Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue).ProcessId
    if ($svcPid -and $svcPid -gt 0) {
        Write-Warn "Force-killing NSSM supervisor PID $svcPid..."
        Stop-Process -Id $svcPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    Write-Step "Removing service registration..."
    if ($nssm) {
        & $nssm remove $Name confirm 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 1

    # sc.exe delete as a fallback hammer
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        & sc.exe delete $Name 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    }

    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        Write-Warn "Service still listed (Windows may need a moment, or a reboot)."
        Write-Warn "If it persists, reboot and re-run uninstall.ps1."
    } else {
        Write-Ok "Service removed."
    }
} else {
    Write-Warn "No service '$Name' to remove."
}

# --- 5. Optional purge ------------------------------------------------------
if ($Purge) {
    foreach ($dir in @($pocketDir, $mnemonDir)) {
        if (Test-Path $dir) {
            Write-Step "Deleting $dir..."
            Remove-Item -Recurse -Force $dir
            Write-Ok "Deleted $dir"
        }
    }
}

Write-Host ""
Write-Ok "=== Uninstall complete ==="
if (-not $Purge) {
    Write-Host "  Your vault, mnemon, secrets, and logs remain at:"
    Write-Host "    $pocketDir"
    Write-Host "    $mnemonDir"
    Write-Host "  To wipe them, re-run with -Purge."
    Write-Host ""
    Write-Host "  To migrate to another machine, run:"
    Write-Host "    .\scripts\service\migrate-export.ps1"
}
