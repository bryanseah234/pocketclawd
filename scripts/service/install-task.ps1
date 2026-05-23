# PocketClaw — Service Installer (Windows Scheduled Task)
#
# Registers PocketClaw host as a Scheduled Task running as the interactive user (S4U) that:
#   - starts on boot (no logon required, same as NSSM service)
#   - restarts every 1 min if the process exits, indefinitely
#   - logs stdout/stderr to $LOG_PATH (read from .env, default
#     X:\PocketClawData\logs\)
#   - can be stopped/started/restarted from a non-elevated shell
#     via `schtasks /End` and `schtasks /Run` (no UAC prompt)
#
# This replaces the NSSM service. Run uninstall.ps1 first if NSSM
# is still registered, or use the bundled `migrate-from-nssm.ps1`
# wrapper which does both in order.
#
# Requires: PowerShell 5.1+, admin rights for task registration.
#
# Usage (from repo root, in elevated PowerShell):
#   .\scripts\service\install-task.ps1                 # default name "PocketClaw"
#   .\scripts\service\install-task.ps1 -Name custom    # custom name
#   .\scripts\service\install-task.ps1 -DryRun         # show plan, don't apply

[CmdletBinding()]
param(
    [string]$Name = "PocketClaw",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Write-Step($msg) { Write-Host "[install-task] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[install-task] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[install-task] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[install-task] $msg" -ForegroundColor Red }

# --- 1. Admin check ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "This script must run as Administrator (Scheduled Task SYSTEM principal requires it)."
    Write-Err "Re-launch PowerShell with 'Run as administrator' and try again."
    exit 1
}

# --- 2. Locate Node 22 ------------------------------------------------------
$node22 = "C:\Users\bryan\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v22.22.3-win-x64\node.exe"
if (Test-Path $node22) {
    $node = $node22
} else {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $node) {
    Write-Err "Node 22 not found at expected path and no `node` on PATH."
    Write-Err "Install Node 22: winget install OpenJS.NodeJS.22 --scope user"
    exit 1
}
$nodeVer = & $node --version 2>&1
if ($nodeVer -notmatch "^v22\.") {
    Write-Warn "Node version is $nodeVer — expected v22.x. better-sqlite3 may crash with NODE_MODULE_VERSION mismatch."
}
Write-Ok "Node: $node ($nodeVer)"

# --- 3. Verify build artifacts ---------------------------------------------
$mainScript = Join-Path $repoRoot "dist\index.js"
if (-not (Test-Path $mainScript)) {
    Write-Err "Build output missing: $mainScript"
    Write-Err "Run 'pnpm run build' first."
    exit 1
}
Write-Ok "Entry point: $mainScript"

# --- 3b. Verify better-sqlite3 native binding ------------------------------
$bs3Binding = Join-Path $repoRoot "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
if (-not (Test-Path $bs3Binding)) {
    Write-Warn "better-sqlite3 native binding missing — rebuilding via prebuild-install..."
    $prebuildBin = Join-Path $repoRoot "node_modules\prebuild-install\bin.js"
    if (-not (Test-Path $prebuildBin)) {
        Write-Err "prebuild-install not in node_modules. Run 'pnpm install --ignore-scripts' first."
        exit 1
    }
    Push-Location (Join-Path $repoRoot "node_modules\better-sqlite3")
    try {
        & $node $prebuildBin
        if ($LASTEXITCODE -ne 0) {
            Write-Err "prebuild-install failed. Try: npx node-gyp rebuild --release"
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Ok "Rebuilt better-sqlite3 native binding."
} else {
    Write-Ok "better-sqlite3 native binding present."
}

# --- 4. Verify .env exists --------------------------------------------------
$envFile = Join-Path $repoRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Err ".env missing at $envFile"
    exit 1
}
Write-Ok ".env: $envFile"

# --- 5. Read .env to find LOG_PATH ------------------------------------------
$envHash = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([A-Z_][A-Z0-9_]*)=(.+)$') { $envHash[$Matches[1]] = $Matches[2].Trim() }
}
function Resolve-EnvPath($key, $default) {
    $v = $envHash[$key]
    if (-not $v) { return $default }
    if ($v.StartsWith('~')) { return Join-Path $env:USERPROFILE $v.Substring(2) }
    return $v.Replace('/', '\')
}
$logDir = Resolve-EnvPath "LOG_PATH" (Join-Path $env:USERPROFILE ".pocketclaw\logs")
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Write-Ok "Logs will go to: $logDir"

$stdoutLog = Join-Path $logDir "service.stdout.log"
$stderrLog = Join-Path $logDir "service.stderr.log"

# --- 6. Generate wrapper .cmd ----------------------------------------------
# Scheduled Tasks pass arguments as a single string. A wrapper .cmd lets us
# control quoting precisely AND redirect stdout/stderr to log files (which
# Scheduled Tasks cannot do natively the way NSSM's AppStdout did).
$wrapperBat = Join-Path $repoRoot "scripts\service\.run-host-task.cmd"
$wrapperContent = @"
@echo off
REM Auto-generated by scripts\service\install-task.ps1 — do not edit by hand.
REM Re-run install-task.ps1 to regenerate.
REM Prepend user-installed binary dirs to PATH so chat-ingest can spawn
REM mnemon (Go-installed) and similar tools under NT AUTHORITY\SYSTEM,
REM which does NOT inherit the interactive user's PATH.
set "PATH=C:\Users\bryan\go\bin;C:\Users\bryan\.local\bin;C:\Users\bryan\AppData\Roaming\npm;C:\Users\bryan\AppData\Local\pnpm;%PATH%"
cd /d "$repoRoot"
"$node" --env-file="$envFile" "$mainScript" 1>>"$stdoutLog" 2>>"$stderrLog"
"@
Set-Content -Path $wrapperBat -Value $wrapperContent -Encoding ASCII
Write-Ok "Wrapper script: $wrapperBat"

# --- 7. Plan ---------------------------------------------------------------
Write-Host ""
Write-Step "=== Scheduled Task Plan ==="
Write-Host "  Name:           $Name"
Write-Host "  Wrapper:        $wrapperBat"
Write-Host "  Working dir:    $repoRoot"
Write-Host "  Stdout log:     $stdoutLog"
Write-Host "  Stderr log:     $stderrLog"
Write-Host "  Run-as:         $env:USERDOMAIN\$env:USERNAME (S4U, no password stored)"
Write-Host "  Trigger:        At system startup"
Write-Host "  Restart:        every 1 minute if task exits, unlimited count"
Write-Host ""

if ($DryRun) {
    Write-Warn "Dry run — exiting without applying."
    exit 0
}

# --- 8. Remove existing task if present ------------------------------------
$existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Task '$Name' exists — removing for re-install..."
    # Stop it first if running
    try { Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 500
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Ok "Old task removed."
}

# --- 9. Register task -------------------------------------------------------
Write-Step "Registering Scheduled Task '$Name'..."

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$wrapperBat`"" -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest

# Settings: keep retrying forever, restart on failure.
# IMPORTANT: do NOT put inline ``# comments`` after a backtick line-continuation
# — PowerShell parses them as terminating the command, which makes the next
# `-MultipleInstances` arg look like a standalone command. Comments must go
# above or below, never trailing a backticked line.
# ExecutionTimeLimit (New-TimeSpan -Days 0) means "run indefinitely". Some PS
# versions still serialize that as PT72H, which is why we patch the XML below.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $Name `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "PocketClaw personal AI assistant — Telegram/WhatsApp + cloud ingestion + mnemon memory. Replaces NSSM service." `
    | Out-Null

# --- 9b. Force ExecutionTimeLimit=PT0S via XML patch -----------------------
# Register-ScheduledTask sometimes ignores -ExecutionTimeLimit (TimeSpan zero
# gets serialised as PT72H by some PowerShell versions). Patch the XML directly.
$xml = (Get-ScheduledTask -TaskName $Name | Export-ScheduledTask)
if ($xml -match '<ExecutionTimeLimit>PT72H</ExecutionTimeLimit>' -or $xml -match '<ExecutionTimeLimit>PT3D</ExecutionTimeLimit>') {
    Write-Step "Patching ExecutionTimeLimit to PT0S (run indefinitely)..."
    $xml = $xml -replace '<ExecutionTimeLimit>PT[0-9A-Z]+</ExecutionTimeLimit>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'
    # Re-register with patched XML
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Register-ScheduledTask -TaskName $Name -Xml $xml -Force | Out-Null
    Write-Ok "ExecutionTimeLimit set to PT0S."
}

Write-Ok "Task registered."

# --- 10. Start task ---------------------------------------------------------
Write-Step "Starting task..."
Start-ScheduledTask -TaskName $Name
Start-Sleep -Seconds 5

$task = Get-ScheduledTask -TaskName $Name
$info = Get-ScheduledTaskInfo -TaskName $Name
Write-Host ""
Write-Step "=== Task Status ==="
Write-Host "  State:           $($task.State)"
Write-Host "  Last run time:   $($info.LastRunTime)"
Write-Host "  Last result:     0x$([Convert]::ToString($info.LastTaskResult, 16).ToUpper())"
Write-Host "  Next run time:   $($info.NextRunTime)"

# Verify the host process is actually up by checking node.exe parent
$childProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
$found = $false
foreach ($p in $childProcs) {
    if ($p.CommandLine -and $p.CommandLine -match [regex]::Escape("dist\index.js")) {
        Write-Ok "node.exe PID=$($p.ProcessId) is running PocketClaw host."
        $found = $true
        break
    }
}
if (-not $found) {
    Write-Warn "Could not find a node.exe running dist\index.js yet."
    Write-Warn "Check $stderrLog for errors. The task may still be starting."
}

Write-Host ""
Write-Ok "=== Install complete ==="
Write-Host "  Status:    Get-ScheduledTask -TaskName $Name | Format-List State,*Run*"
Write-Host "  Logs:      Get-Content '$stdoutLog' -Tail 50 -Wait"
Write-Host ""
Write-Host "  Restart (no UAC needed once task exists):"
Write-Host "    schtasks /End /TN $Name; schtasks /Run /TN $Name"
Write-Host "  Or use the helper:"
Write-Host "    pwsh .\scripts\service\Restart-PocketClaw.ps1"
Write-Host ""
Write-Host "  Uninstall: .\scripts\service\uninstall-task.ps1"
