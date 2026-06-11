# -----------------------------------------------------------------------------
# NanoClaw AWS Infrastructure -- ElastiCache Redis
#
# t7-49: Migrate the standalone aws_elasticache_cluster to an
# aws_elasticache_replication_group with at-rest + in-transit encryption and
# (optional) Multi-AZ failover.
#
# This is a BLUE/GREEN replacement, not an in-place edit:
#   - A standalone cluster CANNOT be converted in place to an encrypted
#     replication group; the new group is created alongside the old cluster.
#   - The primary endpoint hostname CHANGES. The app reads Redis host/port/auth
#     from the nanoclaw/app-config secret, so cutover = update that secret +
#     redeploy (ECS rolling) -- no code change (TLS + AUTH already supported in
#     both the TS and Python clients).
#
# Toggle with redis_use_replication_group:
#   false (default) -> keep the existing standalone cluster (no change)
#   true            -> create the encrypted replication group
#
# CUTOVER RUNBOOK: infrastructure/terraform/REDIS-CUTOVER.md
# -----------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.project_name}-redis-subnet"
  subnet_ids = [aws_subnet.private.id, aws_subnet.private_b.id]

  tags = {
    Name = "${var.project_name}-redis-subnet"
  }

}

# -- Legacy standalone cluster (kept until cutover) --------------------------
# Only created while redis_use_replication_group = false.
resource "aws_elasticache_cluster" "redis" {
  count                = var.redis_use_replication_group ? 0 : 1
  cluster_id           = "${var.project_name}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = var.redis_num_cache_nodes
  port                 = 6379
  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]

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

# -- Encrypted replication group (target state) ------------------------------
# Only created while redis_use_replication_group = true.
#
# Security:
#   - at_rest_encryption_enabled = true
#   - transit_encryption_enabled = true (clients must use rediss:// + AUTH)
#   - auth_token sourced from a variable fed by Secrets Manager (never
#     hard-coded); 16-128 chars
#
# Availability:
#   - num_cache_clusters = redis_replica_count + 1 (1 primary + N replicas)
#   - automatic_failover_enabled / multi_az_enabled when >= 1 replica
resource "aws_elasticache_replication_group" "redis" {
  count                = var.redis_use_replication_group ? 1 : 0
  replication_group_id = "${var.project_name}-redis-rg"
  description          = "${var.project_name} Redis (encrypted, HA)"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]

  num_cache_clusters         = var.redis_replica_count + 1
  automatic_failover_enabled = var.redis_replica_count >= 1
  multi_az_enabled           = var.redis_replica_count >= 1

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token

  maintenance_window       = "sun:05:00-sun:06:00"
  snapshot_retention_limit = 3
  snapshot_window          = "03:00-04:00"

  tags = {
    Name = "${var.project_name}-redis-rg"
  }

  lifecycle {
    ignore_changes = [security_group_ids, subnet_group_name]
  }
}

# -- Active-endpoint resolution (toggle-aware) -------------------------------
# Downstream resources (ec2.tf, secrets.tf) reference these locals instead of a
# specific resource so the count toggle never breaks their references.
locals {
  redis_host = var.redis_use_replication_group ? aws_elasticache_replication_group.redis[0].primary_endpoint_address : aws_elasticache_cluster.redis[0].cache_nodes[0].address
  redis_port = var.redis_use_replication_group ? aws_elasticache_replication_group.redis[0].port : aws_elasticache_cluster.redis[0].cache_nodes[0].port
  redis_tls  = var.redis_use_replication_group

  # CloudWatch ElastiCache metrics are per-node; the replication group's first
  # node is "<id>-001". Used for dashboard/alarm CacheClusterId dimensions.
  redis_metric_cluster_id = var.redis_use_replication_group ? "${aws_elasticache_replication_group.redis[0].replication_group_id}-001" : aws_elasticache_cluster.redis[0].cluster_id
}
