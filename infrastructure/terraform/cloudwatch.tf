# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — CloudWatch Monitoring
# ─────────────────────────────────────────────────────────────────────────────

# ─── Log Groups ──────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "orchestrator" {
  name              = "/nanoclaw/orchestrator"
  retention_in_days = 90

  tags = {
    Name = "${var.project_name}-orchestrator-logs"
  }
}

resource "aws_cloudwatch_log_group" "agent" {
  name              = "/nanoclaw/agent"
  retention_in_days = 90

  tags = {
    Name = "${var.project_name}-agent-logs"
  }
}

resource "aws_cloudwatch_log_group" "system" {
  name              = "/nanoclaw/system"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-system-logs"
  }
}

# ─── SNS Topic for Alerts ───────────────────────────────────────────────────

resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"

  tags = {
    Name = "${var.project_name}-alerts"
  }
}

# ─── CloudWatch Alarms ───────────────────────────────────────────────────────

# High CPU utilization on EC2
resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  alarm_name          = "${var.project_name}-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "EC2 CPU utilization above 80% for 15 minutes"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = aws_instance.main.id
  }

  tags = {
    Name = "${var.project_name}-high-cpu-alarm"
  }
}

# DynamoDB throttling
resource "aws_cloudwatch_metric_alarm" "dynamodb_throttle" {
  alarm_name          = "${var.project_name}-dynamodb-throttle"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ThrottledRequests"
  namespace           = "AWS/DynamoDB"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "DynamoDB throttling detected"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    TableName = aws_dynamodb_table.chat_messages.name
  }

  tags = {
    Name = "${var.project_name}-dynamodb-throttle-alarm"
  }
}

# Custom metric alarm — high error rate (application-emitted)
resource "aws_cloudwatch_metric_alarm" "high_error_rate" {
  alarm_name          = "${var.project_name}-high-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ErrorCount"
  namespace           = "NanoClaw"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "More than 10 errors in 5 minutes"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  tags = {
    Name = "${var.project_name}-high-error-rate-alarm"
  }
}

# Custom metric alarm — high latency
resource "aws_cloudwatch_metric_alarm" "high_latency" {
  alarm_name          = "${var.project_name}-high-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MessageProcessingTime"
  namespace           = "NanoClaw"
  period              = 300
  extended_statistic  = "p95"
  threshold           = 60000 # 60 seconds in ms
  alarm_description   = "P95 message processing time exceeds 60 seconds"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  tags = {
    Name = "${var.project_name}-high-latency-alarm"
  }
}

# ─── B6 Wave 6: Additional alarms (Bedrock throttle + ECS sub-agent failure + WhatsApp disconnect) ───

# Bedrock throttling — caught by sub-agent fallback chain (G_5) but still worth alerting on
resource "aws_cloudwatch_metric_alarm" "bedrock_throttle" {
  alarm_name          = "${var.project_name}-bedrock-throttle"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "InvocationThrottles"
  namespace           = "AWS/Bedrock"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Bedrock InvokeModel throttling — fallback chain may be active"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags = {
    Name = "${var.project_name}-bedrock-throttle-alarm"
  }
}

# ECS sub-agent service failure (no running tasks)
resource "aws_cloudwatch_metric_alarm" "ecs_subagent_no_tasks" {
  alarm_name          = "${var.project_name}-ecs-subagent-no-tasks"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Average"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_description   = "ECS sub-agent has zero running tasks for 10 minutes"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {
    ClusterName = "nanoclaw-cluster"
    ServiceName = "nanoclaw-sub-agent"
  }
  tags = {
    Name = "${var.project_name}-ecs-subagent-no-tasks-alarm"
  }
}

# ─── Wave 6: SNS subscriptions ───────────────────────────────────────────────
# Email + SMS to Bryan. Email needs manual confirmation via the link AWS sends.
# SMS goes via direct subscription; Singapore (+65) is supported by SNS Standard topic
# but if it stops working, replace with `aws_pinpoint_sms_voice_v2_phone_number` topic
# attribution. SMS needs a sandbox-exit request in some regions.

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alerts_email
}

resource "aws_sns_topic_subscription" "alerts_sms" {
  count     = var.alerts_sms_phone != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "sms"
  endpoint  = var.alerts_sms_phone
}
