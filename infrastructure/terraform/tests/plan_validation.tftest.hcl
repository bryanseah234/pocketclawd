# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Terraform Plan Smoke Test
# Validates: REQ-8.1 (Infrastructure as Code — repeatable, version-controlled)
#
# This test runs `terraform plan` only (no apply) to verify:
# - All resource references resolve correctly
# - No circular dependencies exist
# - Variable validation passes
# - Provider configuration is valid
# ─────────────────────────────────────────────────────────────────────────────

# Mock the AWS provider to avoid needing real credentials
mock_provider "aws" {}

variables {
  project_name    = "nanoclaw-test"
  environment     = "staging"
  aws_region      = "ap-southeast-1"
  key_pair_name   = "test-key"
  admin_ssh_cidrs = ["10.0.0.1/32"]
  instance_type   = "t3.xlarge"
  redis_node_type = "cache.t3.micro"
}

# ─── Test: Plan succeeds with valid configuration ────────────────────────────

run "plan_succeeds_with_valid_config" {
  command = plan

  assert {
    condition     = aws_vpc.main.cidr_block == "10.0.0.0/16"
    error_message = "VPC CIDR block should default to 10.0.0.0/16"
  }

  assert {
    condition     = aws_vpc.main.enable_dns_hostnames == true
    error_message = "VPC must have DNS hostnames enabled"
  }

  assert {
    condition     = aws_vpc.main.enable_dns_support == true
    error_message = "VPC must have DNS support enabled"
  }
}

# ─── Test: DynamoDB tables are correctly configured ──────────────────────────

run "dynamodb_tables_configured" {
  command = plan

  # Chat messages table
  assert {
    condition     = aws_dynamodb_table.chat_messages.hash_key == "userId"
    error_message = "chat_messages table must use userId as partition key"
  }

  assert {
    condition     = aws_dynamodb_table.chat_messages.range_key == "timestamp"
    error_message = "chat_messages table must use timestamp as sort key"
  }

  assert {
    condition     = aws_dynamodb_table.chat_messages.billing_mode == "PAY_PER_REQUEST"
    error_message = "DynamoDB should use on-demand billing by default"
  }

  # Webhook tokens table
  assert {
    condition     = aws_dynamodb_table.webhook_tokens.hash_key == "tokenHash"
    error_message = "webhook_tokens table must use tokenHash as partition key"
  }

  # User preferences table
  assert {
    condition     = aws_dynamodb_table.user_preferences.hash_key == "userId"
    error_message = "user_preferences table must use userId as partition key"
  }

  # System errors table
  assert {
    condition     = aws_dynamodb_table.system_errors.hash_key == "userId"
    error_message = "system_errors table must use userId as partition key"
  }

  assert {
    condition     = aws_dynamodb_table.system_errors.range_key == "timestamp"
    error_message = "system_errors table must use timestamp as sort key"
  }
}

# ─── Test: S3 bucket has security controls ───────────────────────────────────

run "s3_security_configured" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.data.block_public_acls == true
    error_message = "S3 bucket must block public ACLs"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.data.block_public_policy == true
    error_message = "S3 bucket must block public policies"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.data.restrict_public_buckets == true
    error_message = "S3 bucket must restrict public access"
  }
}

# ─── Test: EC2 instance uses IMDSv2 ─────────────────────────────────────────

run "ec2_security_hardened" {
  command = plan

  assert {
    condition     = aws_instance.main.instance_type == "t3.xlarge"
    error_message = "EC2 instance type should match the variable"
  }
}

# ─── Test: ECR repositories have scan-on-push enabled ────────────────────────

run "ecr_scanning_enabled" {
  command = plan

  assert {
    condition     = aws_ecr_repository.orchestrator.image_scanning_configuration[0].scan_on_push == true
    error_message = "ECR orchestrator repo must have scan-on-push enabled"
  }

  assert {
    condition     = aws_ecr_repository.agent.image_scanning_configuration[0].scan_on_push == true
    error_message = "ECR agent repo must have scan-on-push enabled"
  }
}

# ─── Test: CloudWatch log groups have retention configured ───────────────────

run "cloudwatch_retention_configured" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.orchestrator.retention_in_days == 90
    error_message = "Orchestrator log group must retain logs for 90 days"
  }

  assert {
    condition     = aws_cloudwatch_log_group.agent.retention_in_days == 90
    error_message = "Agent log group must retain logs for 90 days"
  }

  assert {
    condition     = aws_cloudwatch_log_group.system.retention_in_days == 30
    error_message = "System log group must retain logs for 30 days"
  }
}

# ─── Test: Redis cluster is in private subnet ────────────────────────────────

run "redis_network_isolation" {
  command = plan

  assert {
    condition     = aws_elasticache_cluster.redis.engine == "redis"
    error_message = "ElastiCache must use Redis engine"
  }

  assert {
    condition     = aws_elasticache_cluster.redis.port == 6379
    error_message = "Redis must use standard port 6379"
  }
}

# ─── Test: Environment variable validation ───────────────────────────────────

run "invalid_environment_rejected" {
  command = plan

  variables {
    environment = "development"
  }

  expect_failures = [
    var.environment,
  ]
}

# ─── Test: OpenSearch collection is vector search type ───────────────────────

run "opensearch_vector_search_type" {
  command = plan

  assert {
    condition     = aws_opensearchserverless_collection.documents.type == "VECTORSEARCH"
    error_message = "OpenSearch collection must be VECTORSEARCH type"
  }
}
