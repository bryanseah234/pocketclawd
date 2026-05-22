# PocketClaw — Self-elevating NSSM-to-Task migration
#
# Spawns an elevated PowerShell that runs migrate-from-nssm.ps1.
# Single UAC prompt for the entire migration.
#
# Usage from non-admin terminal at repo root:
#   pwsh .\scripts\service\migrate-from-nssm-elevated.ps1
#   pwsh .\scripts\service\migrate-from-nssm-elevated.ps1 -RemoveNssmBinary

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$migrateScript = Join-Path $repoRoot "scripts\service\migrate-from-nssm.ps1"

if (-not (Test-Path $migrateScript)) {
    Write-Host "[elevate] migrate-from-nssm.ps1 not found at $migrateScript" -ForegroundColor Red
    exit 1
}

Write-Host "[elevate] Launching elevated PowerShell to migrate from NSSM..." -ForegroundColor Cyan
Write-Host "[elevate] A UAC prompt should appear — click Yes." -ForegroundColor Cyan

$argsForMigrate = $args -join ' '
$inner = "Set-Location -LiteralPath '$repoRoot'; & '$migrateScript' $argsForMigrate; Write-Host ''; Read-Host 'Press Enter to close this window'"

try {
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$inner `
        -Verb RunAs `
        -Wait
    Write-Host "[elevate] Migration completed." -ForegroundColor Green
} catch {
    Write-Host "[elevate] UAC prompt was cancelled or failed: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
