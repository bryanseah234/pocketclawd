# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Outputs
# ─────────────────────────────────────────────────────────────────────────────

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "ec2_instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.main.id
}

output "ec2_private_ip" {
  description = "EC2 private IP address"
  value       = aws_instance.main.private_ip
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = "${aws_elasticache_cluster.redis.cache_nodes[0].address}:${aws_elasticache_cluster.redis.cache_nodes[0].port}"
}

output "dynamodb_tables" {
  description = "DynamoDB table names"
  value = {
    chat_messages    = aws_dynamodb_table.chat_messages.name
    webhook_tokens   = aws_dynamodb_table.webhook_tokens.name
    user_preferences = aws_dynamodb_table.user_preferences.name
    system_errors    = aws_dynamodb_table.system_errors.name
  }
}

output "s3_bucket" {
  description = "S3 data bucket name"
  value       = aws_s3_bucket.data.id
}

output "opensearch_endpoint" {
  description = "OpenSearch Serverless collection endpoint"
  value       = aws_opensearchserverless_collection.documents.collection_endpoint
}

output "ecr_repositories" {
  description = "ECR repository URLs"
  value = {
    orchestrator = aws_ecr_repository.orchestrator.repository_url
    agent        = aws_ecr_repository.agent.repository_url
  }
}

output "secrets_manager_arn" {
  description = "Secrets Manager secret ARN"
  value       = aws_secretsmanager_secret.app_config.arn
}

output "cloudwatch_log_groups" {
  description = "CloudWatch log group names"
  value = {
    orchestrator = aws_cloudwatch_log_group.orchestrator.name
    agent        = aws_cloudwatch_log_group.agent.name
    system       = aws_cloudwatch_log_group.system.name
  }
}

output "sns_alerts_topic" {
  description = "SNS topic ARN for alerts"
  value       = aws_sns_topic.alerts.arn
}
