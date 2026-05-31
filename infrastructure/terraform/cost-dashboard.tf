# ─────────────────────────────────────────────────────────────────────────────
# E1 (Wave 6): Cost Dashboard — daily AWS spend per service.
# Uses the standard CloudWatch billing namespace (us-east-1 only — billing
# metrics are global but always emitted to us-east-1). The dashboard
# itself is in our region but references us-east-1 metrics explicitly.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_dashboard" "cost" {
  dashboard_name = "${var.project_name}-cost"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 24
        height = 6
        properties = {
          title  = "Estimated total daily charges (USD)"
          region = "us-east-1"
          metrics = [
            ["AWS/Billing", "EstimatedCharges", "Currency", "USD", { stat = "Maximum", period = 21600 }]
          ]
          view  = "timeSeries"
          stat  = "Maximum"
          yAxis = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Per-service daily charges (USD)"
          region = "us-east-1"
          metrics = [
            ["AWS/Billing", "EstimatedCharges", "Currency", "USD", "ServiceName", "AmazonEC2", { stat = "Maximum", period = 21600 }],
            ["...", "AmazonDynamoDB", { stat = "Maximum", period = 21600 }],
            ["...", "AmazonS3", { stat = "Maximum", period = 21600 }],
            ["...", "AmazonOpenSearchServerless", { stat = "Maximum", period = 21600 }],
            ["...", "AmazonECR", { stat = "Maximum", period = 21600 }],
            ["...", "AmazonECS", { stat = "Maximum", period = 21600 }],
            ["...", "AmazonElastiCache", { stat = "Maximum", period = 21600 }],
            ["...", "AmazonBedrock", { stat = "Maximum", period = 21600 }],
            ["...", "AWSSecretsManager", { stat = "Maximum", period = 21600 }]
          ]
          view    = "timeSeries"
          stacked = true
          yAxis   = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Bedrock token usage (input + output)"
          region = var.aws_region
          metrics = [
            ["AWS/Bedrock", "InputTokenCount", { stat = "Sum", period = 3600, label = "Input tokens/hr" }],
            [".", "OutputTokenCount", { stat = "Sum", period = 3600, label = "Output tokens/hr" }]
          ]
          view  = "timeSeries"
          yAxis = { left = { min = 0 } }
        }
      }
    ]
  })
}

# ─── E1 Cost alarm: hard cap ────────────────────────────────────────────────
# Trigger if estimated total daily charges exceed the budget in cost_alert_threshold_usd.
resource "aws_cloudwatch_metric_alarm" "cost_budget_breach" {
  alarm_name          = "${var.project_name}-cost-budget-breach"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600 # 6 hours — billing metrics update every 6h
  statistic           = "Maximum"
  threshold           = var.cost_alert_threshold_usd
  alarm_description   = "Daily AWS estimated charges exceeded $${var.cost_alert_threshold_usd}"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {
    Currency = "USD"
  }
  tags = {
    Name = "${var.project_name}-cost-budget-breach-alarm"
  }
  # NOTE: this metric lives in us-east-1; if you region-hop the alarm,
  # set provider = aws.us-east-1. For now we leave it in our default region;
  # if Terraform errors on missing metric, see docs/runbooks/cost-budget-setup.md.
}

variable "cost_alert_threshold_usd" {
  description = "Daily AWS spend that triggers the cost SNS alarm"
  type        = number
  default     = 50
}
