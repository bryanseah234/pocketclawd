# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Provider Configuration
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state — S3 backend with DynamoDB locking
  # Bootstrap the state bucket and lock table first (see backend.tf),
  # then uncomment this block and run `terraform init -migrate-state`.
  backend "s3" {
    bucket         = "nanoclaw-terraform-state"
    key            = "infrastructure/terraform.tfstate"
    region         = "ap-southeast-1"
    dynamodb_table = "nanoclaw-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region  = var.aws_region
  profile = "nanoclaw"

  default_tags {
    tags = merge(var.tags, {
      Environment = var.environment
    })
  }
}

# Data source for current AWS account
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
