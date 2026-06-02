# ─────────────────────────────────────────────────────────────────────────────
# ECS Fargate — Indexer (dedicated document indexing worker)  [Wave 5]
#
# The indexer is the SAME image as the sub-agent (container/sub-agent), launched
# with a different command: `python -m src.indexer`. It exists so document
# extraction/embedding never shares a queue with user chat — a large PDF can no
# longer block a conversation (head-of-line blocking on the chat worker pool).
#
# Topology: upload-worker / s3-reindex / data-gateway-worker LPUSH index_file
# jobs onto queue:orchestrator:indexing; the indexer BRPOPs, downloads from S3,
# extracts + chunks + embeds, LPUSHes index_document chunks onto
# queue:orchestrator:data_gateway (handled by the DG worker -> AOSS), and
# notifies the user via queue:orchestrator:responses.
#
# It reuses the sub-agent's task role (Bedrock + S3 + AOSS + Secrets) and
# execution role (ECR pull + app-config secret injection), and the same egress
# SG / Redis ingress rule. No new IAM surface.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "indexer" {
  name              = "/ecs/${var.project_name}-indexer"
  retention_in_days = 30
  tags = {
    Name        = "${var.project_name}-indexer-logs"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_ecs_task_definition" "indexer" {
  family                   = "${var.project_name}-indexer"
  cpu                      = 512
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.sub_agent_execution.arn
  task_role_arn            = aws_iam_role.sub_agent_task.arn

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name      = "indexer"
    image     = "${aws_ecr_repository.agent.repository_url}:feature-latest"
    essential = true

    # Override the image ENTRYPOINT (uvicorn API) with the indexer worker loop.
    entryPoint = ["python", "-m", "src.indexer"]

    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "NANOCLAW_ENV", value = "cloud" },
      { name = "DATA_BUCKET", value = aws_s3_bucket.data.bucket },
      { name = "SECRET_ID", value = aws_secretsmanager_secret.app_config.name },
      { name = "OPENSEARCH_ENDPOINT", value = aws_opensearchserverless_collection.documents.collection_endpoint },
      { name = "OPENSEARCH_COLLECTION", value = aws_opensearchserverless_collection.documents.name },
      { name = "ASSISTANT_NAME", value = "Clawd" },
      { name = "PYTHONUNBUFFERED", value = "1" },
      { name = "BEDROCK_LLM_MODEL_ID", value = "global.anthropic.claude-sonnet-4-5-20250929-v1:0" },
      { name = "BEDROCK_EMBEDDING_MODEL_ID", value = "cohere.embed-v4:0" },
    ]

    # Queue worker — no inbound port, no HTTP health check. Liveness is the
    # ECS task state; the BRPOP loop reconnects to Redis on failure.
    readonlyRootFilesystem = true
    mountPoints = [
      { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.indexer.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }

    user = "1001:1001"
  }])

  tags = {
    Name        = "${var.project_name}-indexer-task"
    Environment = var.environment
    Project     = var.project_name
  }

  # CI/CD owns the container spec (image tag, env); Terraform owns topology.
  lifecycle {
    ignore_changes = [container_definitions, volume]
  }
}

resource "aws_ecs_service" "indexer" {
  name            = "${var.project_name}-indexer"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.indexer.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [aws_subnet.private.id]
    security_groups  = [aws_security_group.sub_agent.id]
    assign_public_ip = true
  }

  enable_execute_command = true

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = {
    Name        = "${var.project_name}-indexer-service"
    Environment = var.environment
    Project     = var.project_name
  }
}

# Scale 1..3 on CPU. Indexing is bursty (a user dumps several files at once);
# scale-out is cheap and scale-in conservative so a half-done batch isn't killed.
resource "aws_appautoscaling_target" "indexer" {
  max_capacity       = 3
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.indexer.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "indexer_cpu" {
  name               = "${var.project_name}-indexer-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.indexer.resource_id
  scalable_dimension = aws_appautoscaling_target.indexer.scalable_dimension
  service_namespace  = aws_appautoscaling_target.indexer.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 70.0
    scale_in_cooldown  = 600
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

output "ecs_indexer_service" {
  value       = aws_ecs_service.indexer.name
  description = "Indexer ECS service — force-new-deployment to roll a new image"
}

output "ecs_indexer_log_group" {
  value       = aws_cloudwatch_log_group.indexer.name
  description = "CloudWatch log group for indexer task logs"
}
