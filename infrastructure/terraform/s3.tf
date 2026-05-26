# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — S3 Storage
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "data" {
  bucket = "${var.s3_bucket_prefix}-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.project_name}-data"
  }
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket = aws_s3_bucket.data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  # Clean up staging files after 24 hours (malware scan should complete well before)
  rule {
    id     = "cleanup-staging"
    status = "Enabled"

    filter {
      prefix = "staging/"
    }

    expiration {
      days = 1
    }
  }

  # Move old exports to Glacier after 30 days, delete after 90
  rule {
    id     = "archive-exports"
    status = "Enabled"

    filter {
      prefix = "exports/"
    }

    transition {
      days          = 30
      storage_class = "GLACIER"
    }

    expiration {
      days = 90
    }
  }

  # Delete old non-current versions after 30 days
  rule {
    id     = "cleanup-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# CORS configuration for potential admin UI uploads
resource "aws_s3_bucket_cors_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["*"] # Restrict to admin domain in production
    max_age_seconds = 3600
  }
}
