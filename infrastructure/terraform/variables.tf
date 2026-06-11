# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — Variables
# ─────────────────────────────────────────────────────────────────────────────

variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
  default     = "nanoclaw"
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  default     = "production"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

variable "aws_region" {
  description = "AWS region for all resources (Singapore for PDPA compliance)"
  type        = string
  default     = "ap-southeast-1"
}

# ─── Compute ─────────────────────────────────────────────────────────────────

variable "instance_type" {
  description = "EC2 instance type. Start with t3.xlarge (~$120/mo), scale to r6i.4xlarge (~$800/mo) for production load."
  type        = string
  default     = "t3.xlarge"
}

variable "key_pair_name" {
  description = "Name of the EC2 key pair for SSH access. Must be pre-created in the target region."
  type        = string
}

variable "admin_ssh_cidrs" {
  description = "CIDR blocks allowed SSH access to the EC2 instance"
  type        = list(string)
  default     = []
}

variable "admin_https_cidrs" {
  description = "CIDR blocks allowed HTTPS access to the admin UI"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ─── Networking ──────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the public subnet (NAT gateway)"
  type        = string
  default     = "10.0.1.0/24"
}

variable "private_subnet_cidr" {
  description = "CIDR block for the primary private subnet (EC2 instance)"
  type        = string
  default     = "10.0.2.0/24"
}

variable "private_subnet_b_cidr" {
  description = "CIDR block for the secondary private subnet (second AZ, required by ElastiCache subnet group)"
  type        = string
  default     = "10.0.3.0/24"
}

# ─── ElastiCache Redis ───────────────────────────────────────────────────────

variable "redis_node_type" {
  description = "ElastiCache Redis node type. cache.t3.micro for dev, cache.r6g.large for production."
  type        = string
  default     = "cache.t3.micro"
}

variable "redis_num_cache_nodes" {
  description = "Number of Redis cache nodes (1 for single-node, 2+ for replication)"
  type        = number
  default     = 1
}

# t7-49: encrypted replication-group migration toggles
variable "redis_use_replication_group" {
  description = "Use an encrypted aws_elasticache_replication_group instead of the legacy standalone cluster. BLUE/GREEN: flipping this replaces the data store and changes the endpoint (see REDIS-CUTOVER.md)."
  type        = bool
  default     = false
}

variable "redis_replica_count" {
  description = "Number of read replicas in the replication group (0 = primary only, no automatic failover; >=1 enables Multi-AZ failover)."
  type        = number
  default     = 1
}

variable "redis_auth_token" {
  description = "AUTH token for transit-encrypted Redis (16-128 chars). Source from Secrets Manager; never commit a literal. Required only when redis_use_replication_group = true."
  type        = string
  default     = ""
  sensitive   = true
}

# t5-30: queue-depth alarm threshold
variable "queue_depth_alarm_threshold" {
  description = "Dispatch queue depth (messages) that, sustained for 3 minutes, triggers the queue-depth alarm."
  type        = number
  default     = 50
}

# ─── DynamoDB ────────────────────────────────────────────────────────────────

variable "dynamodb_billing_mode" {
  description = "DynamoDB billing mode: PAY_PER_REQUEST (on-demand) or PROVISIONED"
  type        = string
  default     = "PAY_PER_REQUEST"
}

# ─── OpenSearch Serverless ───────────────────────────────────────────────────

variable "opensearch_collection_name" {
  description = "Name of the OpenSearch Serverless collection"
  type        = string
  default     = "nanoclaw-documents"
}

# ─── S3 ──────────────────────────────────────────────────────────────────────

variable "s3_bucket_prefix" {
  description = "Prefix for S3 bucket names (will be suffixed with account ID)"
  type        = string
  default     = "nanoclaw-data"
}

# ─── Tags ────────────────────────────────────────────────────────────────────

variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default = {
    Project     = "nanoclaw"
    ManagedBy   = "terraform"
    Application = "whatsapp-assistant"
    Email       = "sowjanya.k@synapxe.sg" # pre-existing live tag, mirrored to keep plan clean
  }
}

# ─── Wave 6: Alerting endpoints ─────────────────────────────────────────────
variable "alerts_email" {
  description = "Email to receive CloudWatch alarm notifications via SNS"
  type        = string
  default     = "shotsbyseah234@gmail.com"
}

variable "alerts_sms_phone" {
  description = "Phone number for SMS alerts (E.164, e.g. +6584731565). Set empty to disable."
  type        = string
  default     = "+6584731565"
}

# t6-40: Application Load Balancer (zero-downtime HTTP cutover)
variable "enable_alb" {
  description = "Provision an ALB fronting the orchestrator HTTP surface. See BLUE-GREEN-RUNBOOK.md. Apply is user-gated."
  type        = bool
  default     = false
}

variable "public_subnet_b_cidr" {
  description = "CIDR for the second public subnet (AZ-b), required by the ALB."
  type        = string
  default     = "10.0.3.0/24"
}

variable "orchestrator_port" {
  description = "TCP port the orchestrator HTTP server listens on."
  type        = number
  default     = 3000
}

variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the ALB on 80/443."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "alb_certificate_arn" {
  description = "ACM certificate ARN for HTTPS. Empty = HTTP-only (dev); HTTP forwards directly to the target group."
  type        = string
  default     = ""
}

variable "alb_deregistration_delay" {
  description = "Seconds the ALB waits for in-flight requests to drain before deregistering a target (connection draining)."
  type        = number
  default     = 30
}

variable "alb_deletion_protection" {
  description = "Enable ALB deletion protection."
  type        = bool
  default     = false
}

variable "aws_account_id" {
  description = "AWS account ID (used to scope Lambda IAM policy to the exact instance ARN)"
  type        = string
  default     = "709609992277"
}

variable "orchestrator_instance_id" {
  description = "EC2 instance ID of the orchestrator (start-clawd Lambda target)"
  type        = string
  default     = "i-0f9cd20350cfdc1a6"
}

variable "start_clawd_token" {
  description = "Secret token for the start-clawd Lambda Function URL. Set in terraform.tfvars."
  type        = string
  sensitive   = true
}
