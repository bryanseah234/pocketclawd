# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — OpenSearch Serverless (Vector Search)
# ─────────────────────────────────────────────────────────────────────────────

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
