# PocketClaw — Service Installer (Windows + NSSM)
#
# Registers PocketClaw host as a Windows service that auto-starts on boot
# and restarts on crash. Idempotent: safe to re-run (will re-install if
# already present). Does not touch your .env, vault, or mnemon database.
#
# Requires: PowerShell 5.1+, admin rights for service registration.
#
# Usage (from repo root):
#   .\scripts\service\install.ps1                 # default service name "pocketclaw"
#   .\scripts\service\install.ps1 -Name custom    # custom name
#   .\scripts\service\install.ps1 -DryRun         # show plan, don't apply
#
# Tear it down later with: .\scripts\service\uninstall.ps1

[CmdletBinding()]
param(
    [string]$Name = "pocketclaw",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Write-Step($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[install] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[install] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[install] $msg" -ForegroundColor Red }

# --- 1. Admin check ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "This script must run as Administrator (NSSM requires it to register a service)."
    Write-Err "Re-launch PowerShell with 'Run as administrator' and try again."
    exit 1
}

# --- 2. Locate or install NSSM ---------------------------------------------
Write-Step "Checking for NSSM..."
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
    Write-Warn "NSSM not on PATH."
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Step "Installing NSSM via Chocolatey..."
        if (-not $DryRun) { choco install nssm -y --no-progress }
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Step "Installing NSSM via winget..."
        if (-not $DryRun) { winget install --id NSSM.NSSM --silent --accept-source-agreements --accept-package-agreements }
    } else {
        Write-Err "Need NSSM but no package manager found. Install from https://nssm.cc/download then re-run."
        exit 1
    }
    # Refresh PATH for this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
    if (-not $nssm) {
        Write-Err "NSSM install completed but not on PATH. Open a new PowerShell window and try again."
        exit 1
    }
}
Write-Ok "NSSM found: $nssm"

# --- 3. Locate Node 22 ------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    $node22 = "C:\Users\bryan\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v22.22.3-win-x64\node.exe"
    if (Test-Path $node22) { $node = $node22 }
}
if (-not $node) {
    Write-Err "Node not found. Install Node 22+ first."
    exit 1
}
$nodeVer = & $node --version 2>&1
Write-Ok "Node: $node ($nodeVer)"

# --- 4. Verify build artifacts ---------------------------------------------
$mainScript = Join-Path $repoRoot "dist\index.js"
if (-not (Test-Path $mainScript)) {
    Write-Err "Build output missing: $mainScript"
    Write-Err "Run 'pnpm run build' first."
    exit 1
}
Write-Ok "Entry point: $mainScript"

# --- 4b. Verify native modules built ---------------------------------------
# better-sqlite3 ships a native binding that gets skipped if you ran
# `pnpm install --ignore-scripts` (which we do for sharp's broken postinstall).
# Without it the host crash-loops at startup with "Could not locate the bindings file".
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
            Write-Err "prebuild-install failed. You may need a build toolchain. Try: npx node-gyp rebuild --release"
            exit 1
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $bs3Binding)) {
        Write-Err "Rebuild ran but binding still missing at $bs3Binding"
        exit 1
    }
    Write-Ok "Rebuilt better-sqlite3 native binding."
} else {
    Write-Ok "better-sqlite3 native binding present."
}

# --- 5. Verify .env exists --------------------------------------------------
$envFile = Join-Path $repoRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Err ".env missing at $envFile"
    Write-Err "Copy .env.example to .env and fill in credentials before installing the service."
    exit 1
}
Write-Ok ".env: $envFile"

# --- 5b. Read .env to find LOG_PATH (so service logs go to the same place
#         status.ps1 reads from) and PATH-relevant settings ------------------
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

# --- 6. Mnemon on PATH (the host needs it for ingestion) -------------------
$mnemonExe = (Get-Command mnemon -ErrorAction SilentlyContinue).Source
if (-not $mnemonExe) {
    Write-Warn "mnemon CLI not on PATH. Cloud ingestion will error until you install mnemon."
    Write-Warn "Install via: go install github.com/dipampaul17/mnemon@latest (or follow /add-mnemon skill)"
}

# --- 7. Plan ---------------------------------------------------------------
$stdoutLog = Join-Path $logDir "service.stdout.log"
$stderrLog = Join-Path $logDir "service.stderr.log"

# Write a wrapper batch file. NSSM cannot reliably pass arguments containing
# spaces (the AppParameters value is a single space-tokenised string). A
# wrapper .cmd file lets NSSM call ONE thing and the wrapper handles the
# quoting itself. This file is regenerated on every install.
$wrapperBat = Join-Path $repoRoot "scripts\service\.run-host.cmd"
$wrapperContent = @"
@echo off
REM Auto-generated by scripts\service\install.ps1 — do not edit by hand.
REM Re-run install.ps1 to regenerate.
cd /d "$repoRoot"
"$node" --env-file="$envFile" "$mainScript"
"@
Set-Content -Path $wrapperBat -Value $wrapperContent -Encoding ASCII
Write-Ok "Wrapper script: $wrapperBat"

Write-Host ""
Write-Step "=== Service Plan ==="
Write-Host "  Name:           $Name"
Write-Host "  Wrapper:        $wrapperBat"
Write-Host "  Working dir:    $repoRoot"
Write-Host "  Stdout log:     $stdoutLog"
Write-Host "  Stderr log:     $stderrLog"
Write-Host "  Startup type:   Automatic (auto-start on boot)"
Write-Host "  Restart policy: NSSM AppRestartDelay=10000ms (10s after exit)"
Write-Host "  Run-as:         LocalSystem (default)"
Write-Host ""

if ($DryRun) {
    Write-Warn "Dry run — exiting without applying."
    exit 0
}

# --- 8. Stop + remove existing if present -----------------------------------
$existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Service '$Name' exists — stopping + removing for re-install..."
    if ($existing.Status -eq "Running") { & $nssm stop $Name 2>&1 | Out-Null }
    & $nssm remove $Name confirm 2>&1 | Out-Null
    Start-Sleep -Seconds 2
}

# --- 9. Install service -----------------------------------------------------
Write-Step "Registering NSSM service..."
# Point NSSM at the wrapper batch — single token, no quoting headaches.
& $nssm install $Name $wrapperBat
& $nssm set $Name AppDirectory $repoRoot
& $nssm set $Name DisplayName "PocketClaw Personal Assistant"
& $nssm set $Name Description "Personal AI assistant — Telegram/WhatsApp + cloud ingestion + mnemon memory."
& $nssm set $Name Start SERVICE_AUTO_START
& $nssm set $Name AppStdout $stdoutLog
& $nssm set $Name AppStderr $stderrLog
& $nssm set $Name AppRotateFiles 1
& $nssm set $Name AppRotateBytes 10485760  # 10 MB rotate
& $nssm set $Name AppRestartDelay 10000    # restart 10s after crash
& $nssm set $Name AppExit Default Restart  # always try to restart on exit

# Pass through PATH so node, mnemon, ollama are findable
$serviceEnv = "Path=$($env:Path)"
& $nssm set $Name AppEnvironmentExtra $serviceEnv

Write-Ok "Service registered."

# --- 10. Start service ------------------------------------------------------
Write-Step "Starting service..."
& $nssm start $Name 2>&1 | Out-String | Write-Host
Start-Sleep -Seconds 3
$status = (Get-Service -Name $Name).Status
if ($status -eq "Running") {
    Write-Ok "Service is running."
} else {
    Write-Warn "Service status: $status"
    Write-Warn "Check $stderrLog for errors."
}

Write-Host ""
Write-Ok "=== Install complete ==="
Write-Host "  Status:    Get-Service $Name"
Write-Host "  Logs:      Get-Content '$stdoutLog' -Tail 50 -Wait"
Write-Host "  Stop:      nssm stop $Name"
Write-Host "  Start:     nssm start $Name"
Write-Host "  Uninstall: .\scripts\service\uninstall.ps1"
