# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Teardown Script
# Destroys ALL resources in account 709609992277 (ap-southeast-1)
# Run from: infrastructure/terraform/
# ─────────────────────────────────────────────────────────────────────────────

param(
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$env:AWS_PROFILE = "nanoclaw"

Write-Host "=== NanoClaw Teardown ===" -ForegroundColor Red
Write-Host "Account: 709609992277" -ForegroundColor Yellow
Write-Host "Region:  ap-southeast-1" -ForegroundColor Yellow
Write-Host ""

# Verify identity
$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
if ($identity.Account -ne "709609992277") {
    Write-Host "ERROR: Wrong account! Expected 709609992277, got $($identity.Account)" -ForegroundColor Red
    exit 1
}
Write-Host "Authenticated as: $($identity.Arn)" -ForegroundColor Green

if (-not $Force -and -not $DryRun) {
    Write-Host ""
    Write-Host "This will DESTROY all NanoClaw infrastructure including:" -ForegroundColor Red
    Write-Host "  - EC2 instance (and its data disk)" -ForegroundColor Red
    Write-Host "  - DynamoDB tables (all data lost)" -ForegroundColor Red
    Write-Host "  - S3 bucket (all files lost)" -ForegroundColor Red
    Write-Host "  - Redis cluster" -ForegroundColor Red
    Write-Host "  - OpenSearch collection (all vectors lost)" -ForegroundColor Red
    Write-Host "  - VPC, subnets, NAT gateway" -ForegroundColor Red
    Write-Host "  - ECR repositories" -ForegroundColor Red
    Write-Host "  - Secrets Manager secrets" -ForegroundColor Red
    Write-Host "  - CloudWatch log groups" -ForegroundColor Red
    Write-Host ""
    $confirm = Read-Host "Type 'DESTROY' to confirm"
    if ($confirm -ne "DESTROY") {
        Write-Host "Aborted." -ForegroundColor Yellow
        exit 0
    }
}

Push-Location "$PSScriptRoot\terraform"

try {
    if ($DryRun) {
        Write-Host "`n--- DRY RUN: showing what would be destroyed ---" -ForegroundColor Cyan
        terraform plan -destroy
    } else {
        Write-Host "`n--- Emptying S3 bucket first (required before delete) ---" -ForegroundColor Yellow
        $bucket = terraform output -raw s3_bucket 2>$null
        if ($bucket) {
            aws s3 rm "s3://$bucket" --recursive --profile nanoclaw 2>$null
            Write-Host "S3 bucket emptied: $bucket"
        }

        Write-Host "`n--- Running terraform destroy ---" -ForegroundColor Yellow
        terraform destroy -auto-approve

        Write-Host "`n=== Teardown complete ===" -ForegroundColor Green
        Write-Host "All NanoClaw resources in 709609992277 have been destroyed."
        Write-Host "Monthly cost is now $0."
    }
} finally {
    Pop-Location
}
