# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Secrets Manager
# ─────────────────────────────────────────────────────────────────────────────

# Application secrets (populated manually or via CI/CD)
resource "aws_secretsmanager_secret" "app_config" {
  name        = "${var.project_name}/app-config"
  description = "NanoClaw application configuration secrets"

  tags = {
    Name = "${var.project_name}-app-config"
  }
}

# Placeholder secret version — values populated post-deploy
resource "aws_secretsmanager_secret_version" "app_config" {
  secret_id = aws_secretsmanager_secret.app_config.id

  secret_string = jsonencode({
    # WhatsApp (Baileys) — no secret needed, session-based auth
    WHATSAPP_SESSION_S3_PREFIX = "sessions/"

    # Redis connection (auto-populated from Terraform)
    REDIS_HOST = aws_elasticache_cluster.redis.cache_nodes[0].address
    REDIS_PORT = tostring(aws_elasticache_cluster.redis.cache_nodes[0].port)

    # OpenSearch endpoint (auto-populated)
    OPENSEARCH_ENDPOINT = aws_opensearchserverless_collection.documents.collection_endpoint

    # S3 bucket (auto-populated)
    S3_BUCKET = aws_s3_bucket.data.id

    # DynamoDB table names (auto-populated)
    DYNAMODB_CHAT_MESSAGES  = aws_dynamodb_table.chat_messages.name
    DYNAMODB_WEBHOOK_TOKENS = aws_dynamodb_table.webhook_tokens.name
    DYNAMODB_USER_PREFS     = aws_dynamodb_table.user_preferences.name
    DYNAMODB_SYSTEM_ERRORS  = aws_dynamodb_table.system_errors.name

    # Bedrock model IDs
    BEDROCK_LLM_MODEL_ID       = "anthropic.claude-3-5-sonnet-20241022-v2:0"
    BEDROCK_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0"

    # Application config
    RATE_LIMIT_PER_USER_PER_MIN = "20"
    RATE_LIMIT_GLOBAL_PER_HOUR  = "200"
    NOTIFICATION_TIMEZONE       = "Asia/Singapore"
  })
}
