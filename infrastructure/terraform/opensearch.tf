# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — OpenSearch Serverless (Vector Search)
# ─────────────────────────────────────────────────────────────────────────────

# ⚠️ AOSS dual-IAM gotcha — DO NOT REMOVE THIS COMMENT
# AOSS requires BOTH (a) the data-access policy above AND (b) the IAM action
# ``aoss:APIAccessAll`` granted to the principal role. Missing (b) yields an
# opaque 403 with no AOSS-specific error message — costs hours to diagnose.
#
# The ``nanoclaw-ec2-role`` (referenced in ec2.tf as a data source) currently
# has an inline policy ``aoss-api-access`` granting ``aoss:APIAccessAll`` on
# the collection ARN. Because the role is pre-created manually with
# AdministratorAccess, this Terraform does NOT manage that inline policy.
#
# If you ever recreate the role from scratch (or migrate to TF-managed IAM),
# remember to attach an inline policy equivalent to:
#
#   {
#     "Version": "2012-10-17",
#     "Statement": [{
#       "Effect": "Allow",
#       "Action": "aoss:APIAccessAll",
#       "Resource": "arn:aws:aoss:${var.aws_region}:${data.aws_caller_identity.current.account_id}:collection/*"
#     }]
#   }
# Encryption policy (required before collection creation)
resource "aws_opensearchserverless_security_policy" "encryption" {
  name = "${var.project_name}-encryption"
  type = "encryption"

  policy = jsonencode({
    Rules = [
      {
        Resource     = ["collection/${var.opensearch_collection_name}"]
        ResourceType = "collection"
      }
    ]
    AWSOwnedKey = true
  })
}

# Network policy — allow access from VPC
resource "aws_opensearchserverless_security_policy" "network" {
  name = "${var.project_name}-network"
  type = "network"

  policy = jsonencode([
    {
      Rules = [
        {
          Resource     = ["collection/${var.opensearch_collection_name}"]
          ResourceType = "collection"
        },
        {
          Resource     = ["collection/${var.opensearch_collection_name}"]
          ResourceType = "dashboard"
        }
      ]
      AllowFromPublic = true # Restrict to VPC endpoint in production
    }
  ])
}

# Data access policy — allow EC2 role to read/write
resource "aws_opensearchserverless_access_policy" "data" {
  name = "${var.project_name}-data-access"
  type = "data"

  policy = jsonencode([
    {
      Rules = [
        {
          Resource     = ["collection/${var.opensearch_collection_name}"]
          ResourceType = "collection"
          Permission = [
            "aoss:CreateCollectionItems",
            "aoss:DeleteCollectionItems",
            "aoss:UpdateCollectionItems",
            "aoss:DescribeCollectionItems"
          ]
        },
        {
          Resource     = ["index/${var.opensearch_collection_name}/*"]
          ResourceType = "index"
          Permission = [
            "aoss:CreateIndex",
            "aoss:DeleteIndex",
            "aoss:UpdateIndex",
            "aoss:DescribeIndex",
            "aoss:ReadDocument",
            "aoss:WriteDocument"
          ]
        }
      ]
      Principal = [data.aws_iam_role.ec2.arn]
    }
  ])
}

# OpenSearch Serverless collection (vector search type)
resource "aws_opensearchserverless_collection" "documents" {
  name = var.opensearch_collection_name
  type = "VECTORSEARCH"

  depends_on = [
    aws_opensearchserverless_security_policy.encryption,
    aws_opensearchserverless_security_policy.network,
    aws_opensearchserverless_access_policy.data
  ]

  tags = {
    Name = "${var.project_name}-documents"
  }
}
