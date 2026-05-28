# Clawd — Self-elevating service installer
#
# Spawns an elevated PowerShell that cd's to the repo root and runs
# install.ps1. Use when your normal shell isn't admin and you don't
# want to manually right-click PowerShell + cd back to the repo.
#
# Usage from non-admin terminal at repo root:
#   pnpm svc:install:elevated
#
# A UAC prompt pops up. Click "Yes". A new admin window runs install.ps1
# and pauses on completion so you can read the output.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installScript = Join-Path $repoRoot "scripts\service\install.ps1"

if (-not (Test-Path $installScript)) {
    Write-Host "[elevate] install.ps1 not found at $installScript" -ForegroundColor Red
    exit 1
}

Write-Host "[elevate] Launching elevated PowerShell..." -ForegroundColor Cyan
Write-Host "[elevate] A UAC prompt should appear — click Yes." -ForegroundColor Cyan

# Build an inline command that:
#   1. Sets the location to the repo root
#   2. Runs install.ps1 with passthru args
#   3. Pauses so the new window stays open with the output visible
$argsForInstall = $args -join ' '
$inner = "Set-Location -LiteralPath '$repoRoot'; & '$installScript' $argsForInstall; Write-Host ''; Read-Host 'Press Enter to close this window'"

# -Verb RunAs triggers UAC. -Wait so we know when it finishes.
try {
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$inner `
        -Verb RunAs `
        -Wait
    Write-Host "[elevate] Elevated install completed." -ForegroundColor Green
} catch {
    Write-Host "[elevate] UAC prompt was cancelled or failed: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
