# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — ElastiCache Redis
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.project_name}-redis-subnet"
  subnet_ids = [aws_subnet.private.id, aws_subnet.private_b.id]

  tags = {
    Name = "${var.project_name}-redis-subnet"
  }

  lifecycle {
    ignore_changes = [subnet_ids]
  }
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${var.project_name}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = var.redis_num_cache_nodes
  port                 = 6379
  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]

  # Note: at_rest_encryption requires a replication group (not standalone cluster)
  # For production HA, migrate to aws_elasticache_replication_group

  # Maintenance
  maintenance_window       = "sun:05:00-sun:06:00"
  snapshot_retention_limit = 3
  snapshot_window          = "03:00-04:00"

  tags = {
    Name = "${var.project_name}-redis"
  }

  lifecycle {
    ignore_changes = [security_group_ids, subnet_group_name]
  }
}
