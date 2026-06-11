# Terraform Plan Smoke Tests

Plan-only validation tests for the NanoClaw AWS infrastructure.
These tests verify resource references resolve, no circular dependencies exist,
and configuration is valid — without provisioning any real resources.

## Prerequisites

- Terraform >= 1.6.0 (uses native `terraform test` framework)
- No AWS credentials required (tests use `mock_provider`)

## Running Tests

From the `infrastructure/terraform/` directory:

```bash
terraform test
```

To run with verbose output:

```bash
terraform test -verbose
```

## What These Tests Validate

| Test | Purpose |
|------|---------|
| `plan_succeeds_with_valid_config` | VPC configuration resolves correctly |
| `dynamodb_tables_configured` | All DynamoDB tables have correct keys and billing |
| `s3_security_configured` | S3 bucket blocks public access |
| `ec2_security_hardened` | EC2 uses correct instance type and IMDSv2 |
| `ecr_scanning_enabled` | ECR repos scan images on push |
| `cloudwatch_retention_configured` | Log groups have correct retention periods |
| `redis_network_isolation` | Redis uses correct engine and port |
| `invalid_environment_rejected` | Invalid environment values are rejected |
| `opensearch_vector_search_type` | OpenSearch collection is VECTORSEARCH type |

## CI Integration

These tests run as part of the GitHub Actions CI pipeline (see `.github/workflows/ci.yml`).
The `terraform test` command exits non-zero on any failure, making it suitable for CI gates.
