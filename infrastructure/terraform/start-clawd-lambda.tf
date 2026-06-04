# ── Lambda: start-clawd ─────────────────────────────────────────────────────
# Exposes a Function URL that starts the EC2 orchestrator instance.
# Hermes calls this URL, polls until EC2 is running, then SSMs the ECS scale-up.
# Deploy: terraform apply -target=module.start_clawd (or -target each resource below)

locals {
  start_token = var.start_clawd_token  # set in terraform.tfvars (never commit raw)
}

# ── IAM role ────────────────────────────────────────────────────────────────
resource "aws_iam_role" "start_clawd_lambda" {
  name = "${var.project_name}-start-clawd-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "start_clawd_lambda" {
  name = "start-ec2-only"
  role = aws_iam_role.start_clawd_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Least-privilege: can only start this one instance
        Effect   = "Allow"
        Action   = ["ec2:StartInstances", "ec2:DescribeInstances"]
        Resource = "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:instance/${var.orchestrator_instance_id}"
      },
      {
        # ec2:DescribeInstances requires * resource
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/lambda/${var.project_name}-start-clawd:*"
      }
    ]
  })
}

# ── Lambda function ──────────────────────────────────────────────────────────
data "archive_file" "start_clawd" {
  type        = "zip"
  source_file = "${path.module}/lambda/start_clawd.py"
  output_path = "${path.module}/lambda/start_clawd.zip"
}

resource "aws_lambda_function" "start_clawd" {
  function_name    = "${var.project_name}-start-clawd"
  role             = aws_iam_role.start_clawd_lambda.arn
  runtime          = "python3.12"
  handler          = "start_clawd.lambda_handler"
  filename         = data.archive_file.start_clawd.output_path
  source_code_hash = data.archive_file.start_clawd.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      START_TOKEN = local.start_token
    }
  }
}

# ── Function URL (no auth — token is in the URL itself) ──────────────────────
resource "aws_lambda_function_url" "start_clawd" {
  function_name      = aws_lambda_function.start_clawd.function_name
  authorization_type = "NONE"
}

# ── Outputs ──────────────────────────────────────────────────────────────────
output "start_clawd_url" {
  value       = "${aws_lambda_function_url.start_clawd.function_url}?token=${local.start_token}"
  description = "Webhook URL to start the Clawd EC2 instance. Keep secret."
  sensitive   = true
}
