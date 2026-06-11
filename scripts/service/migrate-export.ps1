# Clawd — Migrate Export
#
# Bundles everything you need to move Clawd to a new machine:
#   - .env (credentials)
#   - ~/.clawd/secrets/ (Google + MS + Apple OAuth tokens)
#   - ~/.clawd/vault/ (Obsidian wiki + minutes + research + slides)
#   - ~/.mnemon/ (memory graph + oplog)
#   - notes about Node version + mnemon version pinning
#
# Output: a single .zip in the current directory. Move that to the new
# machine, run scripts/service/migrate-import.ps1 there, then install.ps1.
#
# Usage (from repo root):
#   .\scripts\service\migrate-export.ps1                        # writes clawd-export-YYYYMMDD.zip
#   .\scripts\service\migrate-export.ps1 -OutputDir D:\backups  # custom output dir
#   .\scripts\service\migrate-export.ps1 -SkipMnemon            # smaller export, fresh memory on new box

[CmdletBinding()]
param(
    [string]$OutputDir = (Get-Location).Path,
    [switch]$SkipMnemon,
    [switch]$SkipVault
)

$ErrorActionPreference = "Stop"
function Write-Step($msg) { Write-Host "[export] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[export] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[export] $msg" -ForegroundColor Yellow }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pocketDir = Join-Path $env:USERPROFILE ".clawd"
$mnemonDir = Join-Path $env:USERPROFILE ".mnemon"

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$staging = Join-Path $env:TEMP "clawd-export-$stamp"
$zipPath = Join-Path $OutputDir "clawd-export-$stamp.zip"

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

Write-Step "Staging at $staging"

# --- .env ----
if (Test-Path "$repoRoot\.env") {
    Copy-Item "$repoRoot\.env" "$staging\.env"
    Write-Ok "Copied .env"
} else {
    Write-Warn "No .env found at repo root — nothing to copy"
}

# --- secrets ----
$secrets = Join-Path $pocketDir "secrets"
if (Test-Path $secrets) {
    Copy-Item -Recurse $secrets "$staging\secrets"
    $count = (Get-ChildItem $secrets -File).Count
    Write-Ok "Copied secrets/ ($count files: OAuth tokens, app passwords)"
} else {
    Write-Warn "No secrets dir at $secrets"
}

# --- vault ----
if (-not $SkipVault) {
    $vault = Join-Path $pocketDir "vault"
    if (Test-Path $vault) {
        Copy-Item -Recurse $vault "$staging\vault"
        $count = (Get-ChildItem $vault -Recurse -File).Count
        Write-Ok "Copied vault/ ($count files: wiki, meetings, research, slides, speeches)"
    }
}

# --- mnemon ----
if (-not $SkipMnemon) {
    if (Test-Path $mnemonDir) {
        Copy-Item -Recurse $mnemonDir "$staging\mnemon"
        $size = [Math]::Round(((Get-ChildItem $mnemonDir -Recurse | Measure-Object -Sum Length).Sum / 1MB), 2)
        Write-Ok "Copied .mnemon/ ($size MB)"
    } else {
        Write-Warn "No mnemon dir at $mnemonDir"
    }
}

# --- manifest ----
$manifest = @{
    exportedAt    = (Get-Date).ToString("o")
    sourceMachine = $env:COMPUTERNAME
    sourceUser    = $env:USERNAME
    nodeVersion   = (& node --version 2>&1)
    mnemonVersion = (& mnemon version 2>&1 | Out-String).Trim()
    pnpmVersion   = (& pnpm --version 2>&1)
    contents      = @{
        env     = (Test-Path "$staging\.env")
        secrets = (Test-Path "$staging\secrets")
        vault   = (Test-Path "$staging\vault")
        mnemon  = (Test-Path "$staging\mnemon")
    }
} | ConvertTo-Json -Depth 4
Set-Content -Path "$staging\MANIFEST.json" -Value $manifest

# --- README ----
$readme = @"
Clawd Export — $stamp
Source: $($env:COMPUTERNAME)\$($env:USERNAME)

To restore on a new machine:

1. Clone the clawd repo to the same path style (any X:\... or
   D:\... is fine).
2. Install Node 22 (.nvmrc says >=22) and pnpm.
3. Install Go-based mnemon: go install github.com/dipampaul17/mnemon@latest
4. From the repo root: pnpm install --ignore-scripts && pnpm run build
5. Copy this export onto the new machine and unzip.
6. Run: .\scripts\service\migrate-import.ps1 -ExportDir <unzipped-path>
7. Run: .\scripts\service\install.ps1 (as Administrator)

The import script will:
  - Copy .env into the repo root
  - Copy secrets/ into ~/.clawd/secrets/
  - Copy vault/ into ~/.clawd/vault/
  - Copy mnemon/ into ~/.mnemon/

Then the install script registers the Windows service.
"@
Set-Content -Path "$staging\README.txt" -Value $readme

# --- zip ----
Write-Step "Compressing..."
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path "$staging\*" -DestinationPath $zipPath -CompressionLevel Optimal
$zipSize = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Remove-Item -Recurse -Force $staging

Write-Ok "Export ready: $zipPath ($zipSize MB)"
Write-Host ""
Write-Host "Next: copy this zip to the destination machine and run migrate-import.ps1 there."
