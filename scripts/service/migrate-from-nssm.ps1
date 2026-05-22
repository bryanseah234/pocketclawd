# PocketClaw — Migrate from NSSM service to Scheduled Task
#
# One-shot: removes the existing NSSM service AND uninstalls NSSM itself,
# then registers the SYSTEM Scheduled Task as the replacement supervisor.
#
# Run this from a single elevated PowerShell. After this completes, you
# never need elevation again — restart the host with Restart-PocketClaw.ps1
# from a normal shell.
#
# Usage (from repo root, in elevated PowerShell):
#   .\scripts\service\migrate-from-nssm.ps1
#   .\scripts\service\migrate-from-nssm.ps1 -DryRun
#   .\scripts\service\migrate-from-nssm.ps1 -RemoveNssmBinary    # also winget uninstall NSSM

[CmdletBinding()]
param(
    [string]$NssmServiceName = "pocketclaw",
    [string]$TaskName = "PocketClaw",
    [switch]$DryRun,
    [switch]$RemoveNssmBinary
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Write-Step($msg) { Write-Host "[migrate] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[migrate] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[migrate] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[migrate] $msg" -ForegroundColor Red }

# --- 1. Admin check ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "Must run as Administrator."
    exit 1
}

Write-Host ""
Write-Step "=== Migration plan ==="
Write-Host "  1. Stop + remove NSSM service '$NssmServiceName'"
if ($RemoveNssmBinary) {
    Write-Host "  2. Uninstall NSSM binary (winget uninstall NSSM.NSSM)"
} else {
    Write-Host "  2. Leave NSSM binary on PATH (pass -RemoveNssmBinary to also winget-uninstall)"
}
Write-Host "  3. Register Scheduled Task '$TaskName' (SYSTEM, on boot, restart-on-fail)"
Write-Host "  4. Start the task"
Write-Host "  5. Verify node.exe is up running dist\index.js"
Write-Host ""

if ($DryRun) {
    Write-Warn "Dry run — exiting without applying."
    exit 0
}

# --- 2. Stop + remove NSSM service ------------------------------------------
$svc = Get-Service -Name $NssmServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Step "NSSM service '$NssmServiceName' found (status=$($svc.Status), startType=$($svc.StartType))"

    $uninstallScript = Join-Path $repoRoot "scripts\service\uninstall.ps1"
    if (Test-Path $uninstallScript) {
        Write-Step "Running scripts\service\uninstall.ps1..."
        & $uninstallScript -Name $NssmServiceName
        if ($LASTEXITCODE -ne 0) {
            Write-Err "uninstall.ps1 exited with code $LASTEXITCODE — aborting migration."
            exit 1
        }
    } else {
        Write-Warn "uninstall.ps1 not found, falling back to manual removal..."
        $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
        if ($svc.Status -ne "Stopped") {
            if ($nssm) { & $nssm stop $NssmServiceName 2>&1 | Out-Null }
            else { Stop-Service -Name $NssmServiceName -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
        }
        if ($nssm) { & $nssm remove $NssmServiceName confirm 2>&1 | Out-Null }
        & sc.exe delete $NssmServiceName 2>&1 | Out-Null
    }

    Start-Sleep -Seconds 1
    if (Get-Service -Name $NssmServiceName -ErrorAction SilentlyContinue) {
        Write-Err "Service '$NssmServiceName' still exists after removal. Aborting."
        Write-Err "Reboot and re-run this script."
        exit 1
    }
    Write-Ok "NSSM service removed."
} else {
    Write-Warn "No NSSM service '$NssmServiceName' found — skipping removal."
}

# --- 3. Optionally uninstall NSSM binary ------------------------------------
if ($RemoveNssmBinary) {
    Write-Step "Uninstalling NSSM binary..."
    $nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssmCmd) {
        # Try winget first
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            & winget uninstall --id NSSM.NSSM --silent --accept-source-agreements 2>&1 | Out-Null
        }
        # Try chocolatey
        if (Get-Command choco -ErrorAction SilentlyContinue) {
            & choco uninstall nssm -y 2>&1 | Out-Null
        }
        Start-Sleep -Seconds 1
        if (Get-Command nssm -ErrorAction SilentlyContinue) {
            Write-Warn "NSSM is still on PATH — uninstaller couldn't fully remove it."
            Write-Warn "Manual removal: locate nssm.exe and delete its folder, or use the package manager that installed it."
        } else {
            Write-Ok "NSSM binary removed."
        }
    } else {
        Write-Warn "NSSM not on PATH — nothing to uninstall."
    }
}

# --- 4. Install Scheduled Task ----------------------------------------------
$installTaskScript = Join-Path $repoRoot "scripts\service\install-task.ps1"
if (-not (Test-Path $installTaskScript)) {
    Write-Err "install-task.ps1 not found at $installTaskScript"
    exit 1
}

Write-Step "Running scripts\service\install-task.ps1..."
& $installTaskScript -Name $TaskName
if ($LASTEXITCODE -ne 0) {
    Write-Err "install-task.ps1 exited with code $LASTEXITCODE"
    exit 1
}

# --- 5. Final verification --------------------------------------------------
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Err "Task '$TaskName' was not registered. Migration failed."
    exit 1
}

Write-Host ""
Write-Ok "=== Migration complete ==="
Write-Host "  Old NSSM service:  REMOVED"
Write-Host "  New Scheduled Task: $TaskName ($($task.State))"
Write-Host ""
Write-Host "  From now on, restart the host without UAC:"
Write-Host "    pwsh .\scripts\service\Restart-PocketClaw.ps1"
Write-Host ""
Write-Host "  Status:"
Write-Host "    Get-ScheduledTask -TaskName $TaskName | Format-List"
Write-Host "    Get-Content X:\PocketClawData\logs\service.stdout.log -Tail 50 -Wait"
