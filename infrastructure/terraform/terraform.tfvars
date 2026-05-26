# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Production Variables (ap-southeast-1)
# ─────────────────────────────────────────────────────────────────────────────

# ─── Compute ─────────────────────────────────────────────────────────────────
key_pair_name = "nanoclaw-key"
instance_type = "r6i.4xlarge" # 16 vCPU, 128 GB RAM — production target (REQ-1.1)

# ─── Access Control ──────────────────────────────────────────────────────────
admin_ssh_cidrs   = [] # TODO: restrict to admin IPs before production deploy
admin_https_cidrs = ["0.0.0.0/0"]

# ─── Networking ──────────────────────────────────────────────────────────────
aws_region          = "ap-southeast-1" # Singapore — PDPA compliance (REQ-7.3)
vpc_cidr            = "10.0.0.0/16"
public_subnet_cidr  = "10.0.1.0/24"
private_subnet_cidr = "10.0.2.0/24"

# ─── ElastiCache Redis ───────────────────────────────────────────────────────
redis_node_type       = "cache.r6g.large" # Production-grade for message queue (REQ-4.2)
redis_num_cache_nodes = 1

# ─── DynamoDB ────────────────────────────────────────────────────────────────
dynamodb_billing_mode = "PAY_PER_REQUEST" # On-demand for cost efficiency (REQ-2.1)

# ─── OpenSearch Serverless ───────────────────────────────────────────────────
opensearch_collection_name = "nanoclaw-documents"

# ─── S3 ──────────────────────────────────────────────────────────────────────
s3_bucket_prefix = "nanoclaw-data"

# ─── Environment ─────────────────────────────────────────────────────────────
environment = "production"

# ─── Tags ────────────────────────────────────────────────────────────────────
tags = {
  Project     = "nanoclaw"
  ManagedBy   = "terraform"
  Application = "whatsapp-assistant"
  Region      = "ap-southeast-1"
}
