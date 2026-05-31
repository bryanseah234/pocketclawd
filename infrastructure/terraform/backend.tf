# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Terraform Remote State Backend (Bootstrap)
#
# These resources create the S3 bucket and DynamoDB table used by the
# Terraform S3 backend for remote state storage and locking.
#
# Bootstrap workflow:
#   1. Comment out the backend "s3" block in versions.tf
#   2. Run: terraform init && terraform apply -target=aws_s3_bucket.terraform_state \
#           -target=aws_s3_bucket_versioning.terraform_state \
#           -target=aws_s3_bucket_server_side_encryption_configuration.terraform_state \
#           -target=aws_s3_bucket_public_access_block.terraform_state \
#           -target=aws_dynamodb_table.terraform_locks
#   3. Uncomment the backend "s3" block in versions.tf
#   4. Run: terraform init -migrate-state
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "terraform_state" {
  bucket = "nanoclaw-tfstate-709609992277"

  # Prevent accidental deletion of the state bucket
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "nanoclaw-tfstate-709609992277"
    Purpose     = "Terraform remote state storage"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# NOTE: The DynamoDB lock table (aws_dynamodb_table.terraform_locks,
# "nanoclaw-terraform-locks") was REMOVED once the S3 backend migrated to
# native locking (use_lockfile = true in versions.tf, TF >= 1.10). S3
# conditional-write locking needs no separate table. If you ever revert to
# dynamodb_table locking, re-add this resource and bootstrap it per the header.
