# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Production Variables (ap-southeast-1)
# ─────────────────────────────────────────────────────────────────────────────

# ─── Compute ─────────────────────────────────────────────────────────────────
key_pair_name = "nanoclaw-key"
instance_type = "t3.xlarge" # mirrors LIVE (r6i.4xlarge upsize deferred to a deliberate apply)

# ─── Access Control ──────────────────────────────────────────────────────────
admin_ssh_cidrs   = ["0.0.0.0/0"] # mirrors LIVE (open SSH); SHOULD be restricted — see Q-stack
admin_https_cidrs = ["0.0.0.0/0"]

# ─── Networking ──────────────────────────────────────────────────────────────
aws_region          = "ap-southeast-1" # Singapore — PDPA compliance (REQ-7.3)
vpc_cidr            = "10.0.0.0/16"
public_subnet_cidr  = "10.0.1.0/24"
private_subnet_cidr = "10.0.2.0/24"

# ─── ElastiCache Redis ───────────────────────────────────────────────────────
redis_node_type       = "cache.t3.micro" # mirrors LIVE (r6g.large upsize deferred to a deliberate apply)
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
