# ─────────────────────────────────────────────────────────────────────────────
# ECS Fargate — Sub-Agent (per-user RAG/persona/slash-command worker)
#
# The sub-agent is the FastAPI Python container at container/sub-agent/. It
# runs the RAG pipeline (Bedrock + Titan embeddings + OpenSearch), persona
# management, slash commands, document processing, and slide generation.
#
# Topology: orchestrator (EC2) LPUSHes work onto Redis queue:agent:<userId>:in,
# sub-agent BRPOPs, processes, LPUSHes reply to queue:orchestrator:responses,
# orchestrator polls and ships via WhatsApp.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name        = "${var.project_name}-cluster"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Task IAM role
resource "aws_iam_role" "sub_agent_task" {
  name = "${var.project_name}-sub-agent-task-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = {
    Name        = "${var.project_name}-sub-agent-task-role"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_iam_role_policy" "sub_agent_task" {
  name = "task-perms" # matches live (imported); was nanoclaw-sub-agent-task-policy
  role = aws_iam_role.sub_agent_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:*:*:inference-profile/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
        ]
        Resource = [
          aws_dynamodb_table.chat_messages.arn,
          aws_dynamodb_table.user_preferences.arn,
          aws_dynamodb_table.system_errors.arn,
          aws_dynamodb_table.webhook_tokens.arn,
          "${aws_dynamodb_table.chat_messages.arn}/index/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetObjectVersion",
        ]
        Resource = [
          aws_s3_bucket.data.arn,
          "${aws_s3_bucket.data.arn}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "aoss:APIAccessAll",
          "aoss:DashboardsAccessAll",
        ]
        Resource = aws_opensearchserverless_collection.documents.arn
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = aws_secretsmanager_secret.app_config.arn
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${aws_cloudwatch_log_group.sub_agent.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "NanoClaw"
          }
        }
      },
    ]
  })
}

# Execution role
resource "aws_iam_role" "sub_agent_execution" {
  name = "${var.project_name}-sub-agent-execution-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = {
    Name        = "${var.project_name}-sub-agent-execution-role"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_iam_role_policy_attachment" "sub_agent_execution_managed" {
  role       = aws_iam_role.sub_agent_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow ECS to inject REDIS_PASSWORD (and any other app-config secret keys) into
# the sub-agent task at launch via the task-def `secrets` block. Scoped to the
# single app-config secret ARN (with version wildcard).
resource "aws_iam_role_policy" "sub_agent_execution_secrets" {
  name = "secrets-access"
  role = aws_iam_role.sub_agent_execution.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadAppConfigSecret"
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = "arn:aws:secretsmanager:ap-southeast-1:709609992277:secret:nanoclaw/app-config-lra7uR*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "sub_agent" {
  name              = "/ecs/${var.project_name}-sub-agent"
  retention_in_days = 30
  tags = {
    Name        = "${var.project_name}-sub-agent-logs"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_security_group" "sub_agent" {
  name        = "${var.project_name}-sub-agent-sg"
  description = "Sub-agent ECS task egress only"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "all egress"
  }

  tags = {
    Name        = "${var.project_name}-sub-agent-sg"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_security_group_rule" "redis_from_sub_agent" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.redis.id
  source_security_group_id = aws_security_group.sub_agent.id
  description              = "Sub-agent ECS task to Redis"
}

resource "aws_ecs_task_definition" "sub_agent" {
  family                   = "${var.project_name}-sub-agent"
  cpu                      = 1024
  memory                   = 2048
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.sub_agent_execution.arn
  task_role_arn            = aws_iam_role.sub_agent_task.arn

  # Ephemeral writable volumes required because readonlyRootFilesystem=true.
  # Fargate provides these from the task's ephemeral storage (no EFS needed).
  volume {
    name = "app-data"
  }
  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name      = "sub-agent"
    image     = "${aws_ecr_repository.agent.repository_url}:feature-latest"
    essential = true

    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "NANOCLAW_ENV", value = "cloud" },
      { name = "DATA_BUCKET", value = aws_s3_bucket.data.bucket },
      { name = "SECRET_ID", value = aws_secretsmanager_secret.app_config.name },
      { name = "OPENSEARCH_ENDPOINT", value = aws_opensearchserverless_collection.documents.collection_endpoint },
      { name = "OPENSEARCH_COLLECTION", value = aws_opensearchserverless_collection.documents.name },
      { name = "ASSISTANT_NAME", value = "Clawd" },
      { name = "PYTHONUNBUFFERED", value = "1" },
      # Model IDs for sub-agent Bedrock calls (Sonnet 4.5 for both LLM and embeddings)
      { name = "BEDROCK_LLM_MODEL_ID", value = "global.anthropic.claude-sonnet-4-5-20250929-v1:0" },
      { name = "BEDROCK_EMBEDDING_MODEL_ID", value = "cohere.embed-v4:0" },
    ]

    portMappings = [{
      containerPort = 8000
      hostPort      = 8000
      protocol      = "tcp"
    }]

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:8000/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    # Harden: immutable root filesystem. Writable paths are explicit Fargate
    # ephemeral volumes (circuit-breaker state under /app/data, Python/OCR
    # scratch under /tmp). Fargate supports readonlyRootFilesystem.
    readonlyRootFilesystem = true

    mountPoints = [
      { sourceVolume = "app-data", containerPath = "/app/data", readOnly = false },
      { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.sub_agent.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }

    user = "1001:1001"
  }])

  tags = {
    Name        = "${var.project_name}-sub-agent-task"
    Environment = var.environment
    Project     = var.project_name
  }

  # CI/CD pipeline registers new revisions (image :feature-latest, env, user);
  # Terraform owns the cluster/service/scaling, not the container spec.
  lifecycle {
    ignore_changes = [container_definitions, volume]
  }
}

resource "aws_ecs_service" "sub_agent" {
  name            = "${var.project_name}-sub-agent"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.sub_agent.arn
  desired_count   = 2 # Minimum 2 for high availability
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    # Mirrors live: service runs in the single private subnet with public IP.
    # private_b exists for the Multi-AZ Redis RG; migrating the service to it
    # is a separate deliberate change.
    subnets          = [aws_subnet.private.id]
    security_groups  = [aws_security_group.sub_agent.id]
    assign_public_ip = true
  }

  availability_zone_rebalancing = "ENABLED" # matches live
  enable_execute_command        = true

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = {
    Name        = "${var.project_name}-sub-agent-service"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_opensearchserverless_access_policy" "sub_agent" {
  name = "${var.project_name}-sub-agent" # matches live (imported); was -aoss
  type = "data"

  policy = jsonencode([{
    Rules = [
      {
        ResourceType = "collection"
        Resource     = ["collection/${aws_opensearchserverless_collection.documents.name}"]
        Permission = [
          "aoss:CreateCollectionItems",
          "aoss:DescribeCollectionItems",
          "aoss:UpdateCollectionItems",
          "aoss:DeleteCollectionItems",
        ]
      },
      {
        ResourceType = "index"
        Resource     = ["index/${aws_opensearchserverless_collection.documents.name}/*"]
        Permission = [
          "aoss:CreateIndex",
          "aoss:DescribeIndex",
          "aoss:ReadDocument",
          "aoss:WriteDocument",
          "aoss:UpdateIndex",
          "aoss:DeleteIndex",
        ]
      },
    ]
    Principal = [aws_iam_role.sub_agent_task.arn]
  }])
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.main.name
  description = "ECS cluster hosting the sub-agent service"
}

output "ecs_sub_agent_service" {
  value       = aws_ecs_service.sub_agent.name
  description = "Use with aws ecs update-service --force-new-deployment to roll a new image"
}

output "ecs_sub_agent_log_group" {
  value       = aws_cloudwatch_log_group.sub_agent.name
  description = "CloudWatch log group for sub-agent task logs"
}



# ── ECS Auto-scaling ─────────────────────────────────────────────────────────
# Scale the sub-agent between 2 and 10 tasks based on CPU utilization.
# This handles burst load (viral WhatsApp group messages) without requiring
# manual intervention.

resource "aws_appautoscaling_target" "sub_agent" {
  max_capacity       = 10
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.sub_agent.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "sub_agent_cpu" {
  name               = "${var.project_name}-sub-agent-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.sub_agent.resource_id
  scalable_dimension = aws_appautoscaling_target.sub_agent.scalable_dimension
  service_namespace  = aws_appautoscaling_target.sub_agent.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}



