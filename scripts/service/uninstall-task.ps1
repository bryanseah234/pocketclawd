# Clawd — Scheduled Task Uninstaller
#
# Cleanly removes the Clawd Scheduled Task. By default leaves
# .env, vault, mnemon DB, and logs intact. Pass -Purge to wipe data.
#
# Usage (from repo root, in elevated PowerShell):
#   .\scripts\service\uninstall-task.ps1                # remove task only, keep data
#   .\scripts\service\uninstall-task.ps1 -Name custom   # custom task name
#   .\scripts\service\uninstall-task.ps1 -Purge         # also delete vault, mnemon, logs
#   .\scripts\service\uninstall-task.ps1 -DryRun        # show plan, don't apply

[CmdletBinding()]
param(
    [string]$Name = "Clawd",
    [switch]$Purge,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
function Write-Step($msg) { Write-Host "[uninstall-task] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[uninstall-task] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[uninstall-task] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[uninstall-task] $msg" -ForegroundColor Red }

# --- 1. Admin check ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "Must run as Administrator. Re-launch PowerShell elevated."
    exit 1
}

# --- 2. Plan ----------------------------------------------------------------
$pocketDir = "X:\ClawdData"
$mnemonDir = Join-Path $env:USERPROFILE ".mnemon"

Write-Host ""
Write-Step "=== Uninstall Plan ==="
Write-Host "  Task:        $Name"
$existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  State:       $($existing.State)"
} else {
    Write-Host "  State:       not registered"
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

# --- 3. Stop + remove task --------------------------------------------------
if ($existing) {
    Write-Step "Stopping task..."
    try {
        Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    } catch {}
    Start-Sleep -Seconds 2

    # Kill any node.exe child still running the host (in case Stop-ScheduledTask
    # asked nicely but node didn't exit)
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $nodeProcs) {
        if ($p.CommandLine -and $p.CommandLine -match 'clawd.*dist\\index\.js') {
            Write-Warn "Killing leftover node.exe PID $($p.ProcessId)..."
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Step "Removing Scheduled Task..."
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Ok "Task removed."
} else {
    Write-Warn "No task '$Name' to remove."
}

# --- 4. Optional purge ------------------------------------------------------
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
}
