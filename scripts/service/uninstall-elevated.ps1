# PocketClaw — Self-elevating service uninstaller
#
# Same pattern as install-elevated.ps1 but for uninstall.
# Pass -Purge through if you want to also wipe X:\PocketClawData.
#
# Usage:
#   pnpm svc:uninstall:elevated
#   pnpm svc:uninstall:elevated -Purge

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$uninstallScript = Join-Path $repoRoot "scripts\service\uninstall.ps1"

if (-not (Test-Path $uninstallScript)) {
    Write-Host "[elevate] uninstall.ps1 not found at $uninstallScript" -ForegroundColor Red
    exit 1
}

Write-Host "[elevate] Launching elevated PowerShell..." -ForegroundColor Cyan

$argsForUninstall = $args -join ' '
$inner = "Set-Location -LiteralPath '$repoRoot'; & '$uninstallScript' $argsForUninstall; Write-Host ''; Read-Host 'Press Enter to close this window'"

try {
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$inner `
        -Verb RunAs `
        -Wait
    Write-Host "[elevate] Elevated uninstall completed." -ForegroundColor Green
} catch {
    Write-Host "[elevate] UAC prompt was cancelled or failed: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
