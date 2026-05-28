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
