# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — DynamoDB Tables
# ─────────────────────────────────────────────────────────────────────────────

# Chat messages — partition: userId, sort: timestamp, TTL: 90 days
resource "aws_dynamodb_table" "chat_messages" {
  name         = "${var.project_name}-chat-messages"
  billing_mode = var.dynamodb_billing_mode
  hash_key     = "userId"
  range_key    = "timestamp"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-chat-messages"
  }
}

# Webhook tokens — partition: tokenHash, TTL: 15 minutes
resource "aws_dynamodb_table" "webhook_tokens" {
  name         = "${var.project_name}-webhook-tokens"
  billing_mode = var.dynamodb_billing_mode
  hash_key     = "tokenHash"

  attribute {
    name = "tokenHash"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-webhook-tokens"
  }
}

# User preferences — partition: userId, no TTL (retained indefinitely)
resource "aws_dynamodb_table" "user_preferences" {
  name         = "${var.project_name}-user-preferences"
  billing_mode = var.dynamodb_billing_mode
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-user-preferences"
  }
}

# System errors — partition: userId, sort: timestamp, TTL: 30 days
resource "aws_dynamodb_table" "system_errors" {
  name         = "${var.project_name}-system-errors"
  billing_mode = var.dynamodb_billing_mode
  hash_key     = "userId"
  range_key    = "timestamp"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-system-errors"
  }
}
