# PocketClaw — Bedrock SSO credential refresh
#
# Keeps short-lived AWS credentials current in .env so the NanoClaw
# host (and the agent containers it spawns) can call Bedrock via the
# standard AWS credential chain.
#
# How it works:
#   1. Probe whether the cached SSO token is still valid
#   2. Export the short-lived role credentials via AWS CLI
#   3. Write them into .env (gitignored) for the host process and
#      Docker containers to pick up
#
# AWS CLI handles the heavy lifting: while the SSO session is alive
# (org-configured, typically 8h), each `export-credentials` call
# returns a fresh ~1h role-credential set automatically.
#
# When the SSO session itself expires, the user must re-run:
#   aws sso login --sso-session pocketclaw
# The script will print a clear message and exit non-zero so a
# scheduled task knows to skip silently.
#
# Recommended schedule: every 30 minutes via Task Scheduler.
#
# Usage:
#   ./scripts/refresh-bedrock-creds.ps1
#
# Exit codes:
#   0 = creds refreshed and written to .env
#   1 = SSO session expired (user action required)
#   2 = unexpected error

[CmdletBinding()]
param(
    [string]$Profile = "pocketclaw-bedrock",
    [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"

# Step 1 - confirm SSO is alive
$identity = & aws sts get-caller-identity --profile $Profile 2>&1
if ($LASTEXITCODE -ne 0) {
    if ($identity -match "SSO|expired|TokenRefreshError|sso login") {
        Write-Host "[refresh-bedrock] SSO session expired." -ForegroundColor Yellow
        Write-Host "[refresh-bedrock] Run: aws sso login --sso-session pocketclaw" -ForegroundColor Yellow
        exit 1
    }
    Write-Error "[refresh-bedrock] AWS auth error: $identity"
    exit 2
}

# Step 2 - export short-lived creds
$credsRaw = & aws configure export-credentials --profile $Profile --format process 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "[refresh-bedrock] Failed to export credentials: $credsRaw"
    exit 2
}
$creds = $credsRaw | ConvertFrom-Json

# Step 3 - upsert the relevant keys in .env
$updates = [ordered]@{
    "AWS_ACCESS_KEY_ID" = $creds.AccessKeyId
    "AWS_SECRET_ACCESS_KEY" = $creds.SecretAccessKey
    "AWS_SESSION_TOKEN" = $creds.SessionToken
    "AWS_REGION" = $Region
    "AWS_DEFAULT_REGION" = $Region
    "CLAUDE_CODE_USE_BEDROCK" = "1"
}

if (-not (Test-Path $envFile)) {
    New-Item -ItemType File -Path $envFile -Force | Out-Null
}

$envContent = Get-Content $envFile -Raw -ErrorAction SilentlyContinue
if (-not $envContent) { $envContent = "" }

foreach ($key in $updates.Keys) {
    $value = $updates[$key]
    $line = "$key=$value"
    $pattern = "(?m)^" + [regex]::Escape($key) + "=.*$"
    if ($envContent -match $pattern) {
        $envContent = [regex]::Replace($envContent, $pattern, $line)
    } else {
        if (-not $envContent.EndsWith("`n") -and $envContent.Length -gt 0) {
            $envContent += "`n"
        }
        $envContent += "$line`n"
    }
}

# Atomic write
Set-Content -Path $envFile -Value $envContent -NoNewline -Encoding UTF8

$expiresAt = $creds.Expiration
$expiresIn = [math]::Round(([datetime]$expiresAt - (Get-Date).ToUniversalTime()).TotalMinutes)
Write-Host "[refresh-bedrock] OK - .env updated (creds valid ~$expiresIn min, until $expiresAt UTC)" -ForegroundColor Green
exit 0
