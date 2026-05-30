# ─────────────────────────────────────────────────────────────────────────────
# IAM — EC2 Orchestrator Role + ECS Task Roles
#
# EC2 orchestrator: needs Bedrock, DynamoDB, S3, SecretsManager, ECR, ECS, SSM
# ECS sub-agent task role: defined in ecs.tf (aws_iam_role.sub_agent_task)
# ─────────────────────────────────────────────────────────────────────────────

# ── EC2 orchestrator role ────────────────────────────────────────────────────

resource "aws_iam_role" "orchestrator_ec2" {
  name = "${var.project_name}-orchestrator-ec2-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = {
    Name        = "${var.project_name}-orchestrator-ec2-role"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_iam_instance_profile" "orchestrator_ec2" {
  name = "${var.project_name}-orchestrator-ec2-profile"
  role = aws_iam_role.orchestrator_ec2.name
}

resource "aws_iam_role_policy" "orchestrator_ec2" {
  name = "${var.project_name}-orchestrator-ec2-policy"
  role = aws_iam_role.orchestrator_ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BedrockInvoke"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:ListInferenceProfiles",
          "bedrock:ListFoundationModels",
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:*:*:inference-profile/*",
        ]
      },
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
          "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ]
        Resource = [
          "arn:aws:dynamodb:${var.aws_region}:*:table/${var.project_name}-*",
          "arn:aws:dynamodb:${var.aws_region}:*:table/${var.project_name}-*/index/*",
        ]
      },
      {
        Sid    = "S3DataBucket"
        Effect = "Allow"
        Action = [
          "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
          "s3:ListBucket", "s3:GetBucketLocation",
        ]
        Resource = [
          "arn:aws:s3:::${var.project_name}-data-*",
          "arn:aws:s3:::${var.project_name}-data-*/*",
        ]
      },
      {
        Sid    = "SecretsManager"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = [
          "arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.project_name}/*",
        ]
      },
      {
        Sid    = "SSMParameterStore"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:*:parameter/nanoclaw/*",
        ]
      },
      {
        Sid    = "ECRPull"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = "*"
      },
      {
        Sid    = "ECSControl"
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices", "ecs:UpdateService",
          "ecs:DescribeTasks", "ecs:ListTasks",
        ]
        Resource = "*"
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup", "logs:CreateLogStream",
          "logs:PutLogEvents", "logs:DescribeLogGroups",
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/nanoclaw/*"
      },
      {
        Sid    = "CloudWatchMetrics"
        Effect = "Allow"
        Action = ["cloudwatch:PutMetricData"]
        Resource = "*"
      },
      {
        Sid    = "AOSSAccess"
        Effect = "Allow"
        # aoss:APIAccessAll is required — data-access policy alone is insufficient
        # for the OpenSearch Serverless collection.
        Action = ["aoss:APIAccessAll"]
        Resource = "arn:aws:aoss:${var.aws_region}:*:collection/*"
      },
    ]
  })
}

# SSM Session Manager — allows EC2 Instance Connect / SSM shell without SSH port open
resource "aws_iam_role_policy_attachment" "orchestrator_ssm" {
  role       = aws_iam_role.orchestrator_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
