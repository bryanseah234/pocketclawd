# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — CloudWatch Dashboard & Additional Alarms
# ─────────────────────────────────────────────────────────────────────────────

# ─── CloudWatch Dashboard ────────────────────────────────────────────────────

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_name}-operations"

  dashboard_body = jsonencode({
    widgets = [
      # ── Row 1: Application Health Overview ──────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 6
        height = 6
        properties = {
          title  = "Active Containers"
          region = var.aws_region
          metrics = [
            ["NanoClaw/Application", "ActiveContainers", { stat = "Maximum", period = 60 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 6
        y      = 0
        width  = 6
        height = 6
        properties = {
          title  = "Messages Per Minute"
          region = var.aws_region
          metrics = [
            ["NanoClaw/Application", "MessagesPerMinute", { stat = "Sum", period = 60 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 6
        height = 6
        properties = {
          title  = "Error Rate (5 min)"
          region = var.aws_region
          metrics = [
            ["NanoClaw", "ErrorCount", { stat = "Sum", period = 300, color = "#d62728" }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 18
        y      = 0
        width  = 6
        height = 6
        properties = {
          title  = "P95 Processing Latency (ms)"
          region = var.aws_region
          metrics = [
            ["NanoClaw/Application", "ProcessingLatency", { stat = "p95", period = 300 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },

      # ── Row 2: EC2 Compute Metrics ─────────────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "EC2 CPU Utilization (%)"
          region = var.aws_region
          metrics = [
            ["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.main.id, { stat = "Average", period = 60 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0, max = 100 }
          }
          annotations = {
            horizontal = [
              { value = 80, label = "Alarm threshold", color = "#d62728" }
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "EC2 Memory Utilization (%)"
          region = var.aws_region
          metrics = [
            ["NanoClaw/Application", "MemoryUtilization", "InstanceId", aws_instance.main.id, { stat = "Average", period = 60 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0, max = 100 }
          }
        }
      },

      # ── Row 3: DynamoDB Consumed Capacity ──────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "DynamoDB Read Consumed Capacity"
          region = var.aws_region
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.chat_messages.name, { stat = "Sum", period = 300, label = "chat_messages" }],
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.user_preferences.name, { stat = "Sum", period = 300, label = "user_preferences" }],
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.webhook_tokens.name, { stat = "Sum", period = 300, label = "webhook_tokens" }],
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.system_errors.name, { stat = "Sum", period = 300, label = "system_errors" }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "DynamoDB Write Consumed Capacity"
          region = var.aws_region
          metrics = [
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", aws_dynamodb_table.chat_messages.name, { stat = "Sum", period = 300, label = "chat_messages" }],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", aws_dynamodb_table.user_preferences.name, { stat = "Sum", period = 300, label = "user_preferences" }],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", aws_dynamodb_table.webhook_tokens.name, { stat = "Sum", period = 300, label = "webhook_tokens" }],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", aws_dynamodb_table.system_errors.name, { stat = "Sum", period = 300, label = "system_errors" }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },

      # ── Row 4: Redis Metrics ───────────────────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 8
        height = 6
        properties = {
          title  = "Redis Memory Usage (Bytes)"
          region = var.aws_region
          metrics = [
            ["AWS/ElastiCache", "BytesUsedForCache", "CacheClusterId", local.redis_metric_cluster_id, { stat = "Average", period = 300 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 18
        width  = 8
        height = 6
        properties = {
          title  = "Redis Current Connections"
          region = var.aws_region
          metrics = [
            ["AWS/ElastiCache", "CurrConnections", "CacheClusterId", local.redis_metric_cluster_id, { stat = "Average", period = 60 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 18
        width  = 8
        height = 6
        properties = {
          title  = "Redis CPU Utilization (%)"
          region = var.aws_region
          metrics = [
            ["AWS/ElastiCache", "CPUUtilization", "CacheClusterId", local.redis_metric_cluster_id, { stat = "Average", period = 60 }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0, max = 100 }
          }
        }
      },

      # ── Row 5: Application Custom Metrics ──────────────────────────────────
      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 8
        height = 6
        properties = {
          title  = "LLM Latency (ms)"
          region = var.aws_region
          metrics = [
            ["NanoClaw/Application", "LLMLatency", { stat = "p95", period = 300, label = "P95" }],
            ["NanoClaw/Application", "LLMLatency", { stat = "Average", period = 300, label = "Average" }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 24
        width  = 8
        height = 6
        properties = {
          title  = "Vector Search Latency (ms)"
          region = var.aws_region
          metrics = [
            ["NanoClaw/Application", "VectorSearchLatency", { stat = "p95", period = 300, label = "P95" }],
            ["NanoClaw/Application", "VectorSearchLatency", { stat = "Average", period = 300, label = "Average" }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0 }
          }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 24
        width  = 8
        height = 6
        properties = {
          title  = "Docker Daemon & Session Health"
          region = var.aws_region
          metrics = [
            ["NanoClaw/Application", "DockerDaemonHealthy", { stat = "Minimum", period = 60, label = "Docker Daemon" }],
            ["NanoClaw/Application", "WhatsAppSessionHealthy", { stat = "Minimum", period = 60, label = "WhatsApp Session" }]
          ]
          view = "timeSeries"
          yAxis = {
            left = { min = 0, max = 1 }
          }
        }
      }
    ]
  })
}

# ─── Additional Alarms ───────────────────────────────────────────────────────

# Docker daemon down — triggers when the custom health check metric reports unhealthy
resource "aws_cloudwatch_metric_alarm" "docker_daemon_down" {
  alarm_name          = "${var.project_name}-docker-daemon-down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DockerDaemonHealthy"
  namespace           = "NanoClaw/Application"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "Docker daemon health check reporting unhealthy for 2 consecutive minutes"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  treat_missing_data = "breaching"

  tags = {
    Name = "${var.project_name}-docker-daemon-down-alarm"
  }
}

# WhatsApp session expiring — triggers when session health metric reports unhealthy
resource "aws_cloudwatch_metric_alarm" "whatsapp_session_expiring" {
  alarm_name          = "${var.project_name}-whatsapp-session-expiring"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "WhatsAppSessionHealthy"
  namespace           = "NanoClaw/Application"
  period              = 300
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "WhatsApp session health check reporting session expired or expiring"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  treat_missing_data = "breaching"

  tags = {
    Name = "${var.project_name}-whatsapp-session-expiring-alarm"
  }
}
