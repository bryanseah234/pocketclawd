# PocketClaw — Migrate Import
#
# Restores a PocketClaw export onto a new machine. Run this BEFORE
# install.ps1 so the service has all its credentials + memory.
#
# Usage (from repo root, on the destination machine):
#   .\scripts\service\migrate-import.ps1 -ExportDir C:\path\to\unzipped-export
#
# After this completes, run .\scripts\service\install.ps1 (as admin).

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ExportDir,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
function Write-Step($msg) { Write-Host "[import] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[import] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[import] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[import] $msg" -ForegroundColor Red }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pocketDir = Join-Path $env:USERPROFILE ".pocketclaw"
$mnemonDir = Join-Path $env:USERPROFILE ".mnemon"

if (-not (Test-Path $ExportDir)) {
    Write-Err "ExportDir not found: $ExportDir"
    exit 1
}
if (-not (Test-Path "$ExportDir\MANIFEST.json")) {
    Write-Err "No MANIFEST.json in $ExportDir — is this a PocketClaw export?"
    exit 1
}

$manifest = Get-Content "$ExportDir\MANIFEST.json" | ConvertFrom-Json
Write-Step "Importing export from $($manifest.exportedAt) (source: $($manifest.sourceMachine)\$($manifest.sourceUser))"

# Safety: refuse to overwrite without -Force
if (-not $Force) {
    $clashes = @()
    if ((Test-Path "$repoRoot\.env") -and ($manifest.contents.env)) { $clashes += ".env at repo root" }
    if ((Test-Path "$pocketDir\secrets") -and ($manifest.contents.secrets)) { $clashes += "secrets at $pocketDir\secrets" }
    if ((Test-Path "$mnemonDir") -and ($manifest.contents.mnemon)) { $clashes += "mnemon at $mnemonDir" }
    if ($clashes.Count -gt 0) {
        Write-Warn "Existing data detected — refusing to overwrite without -Force:"
        $clashes | ForEach-Object { Write-Warn "  - $_" }
        exit 1
    }
}

# .env
if ($manifest.contents.env) {
    Copy-Item "$ExportDir\.env" "$repoRoot\.env" -Force
    Write-Ok "Restored .env to repo root"
}

# secrets
if ($manifest.contents.secrets) {
    if (-not (Test-Path $pocketDir)) { New-Item -ItemType Directory -Path $pocketDir | Out-Null }
    if (Test-Path "$pocketDir\secrets") { Remove-Item -Recurse -Force "$pocketDir\secrets" }
    Copy-Item -Recurse "$ExportDir\secrets" "$pocketDir\secrets"
    Write-Ok "Restored secrets/ to $pocketDir\secrets"
}

# vault
if ($manifest.contents.vault) {
    if (-not (Test-Path $pocketDir)) { New-Item -ItemType Directory -Path $pocketDir | Out-Null }
    if (Test-Path "$pocketDir\vault") { Remove-Item -Recurse -Force "$pocketDir\vault" }
    Copy-Item -Recurse "$ExportDir\vault" "$pocketDir\vault"
    Write-Ok "Restored vault/ to $pocketDir\vault"
}

# mnemon
if ($manifest.contents.mnemon) {
    if (Test-Path $mnemonDir) { Remove-Item -Recurse -Force $mnemonDir }
    Copy-Item -Recurse "$ExportDir\mnemon" $mnemonDir
    Write-Ok "Restored mnemon/ to $mnemonDir"
}

Write-Host ""
Write-Ok "=== Import complete ==="
Write-Host "Next: .\scripts\service\install.ps1 (as Administrator)"
