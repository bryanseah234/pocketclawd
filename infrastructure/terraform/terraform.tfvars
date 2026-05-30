# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Production Variables (ap-southeast-1)
# ─────────────────────────────────────────────────────────────────────────────

# ─── Compute ─────────────────────────────────────────────────────────────────
key_pair_name = "nanoclaw-key"
instance_type = "r6i.4xlarge" # PRODUCTION TARGET (upsize now)

# ─── Access Control ──────────────────────────────────────────────────────────
admin_ssh_cidrs   = [] # SSH CLOSED — access via SSM Session Manager only (port 22 revoked live)
admin_https_cidrs = ["0.0.0.0/0"]

# ─── Networking ──────────────────────────────────────────────────────────────
aws_region          = "ap-southeast-1" # Singapore — PDPA compliance (REQ-7.3)
vpc_cidr            = "10.0.0.0/16"
public_subnet_cidr  = "10.0.1.0/24"
private_subnet_cidr = "10.0.2.0/24"

# ─── ElastiCache Redis ───────────────────────────────────────────────────────
redis_node_type       = "cache.r6g.large" # PRODUCTION TARGET (upsize now)
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
