# Redis Cutover Runbook (t7-49)

Migrate from the standalone `aws_elasticache_cluster` to an encrypted,
highly-available `aws_elasticache_replication_group` (at-rest + in-transit
encryption, Multi-AZ failover).

## Why this is blue/green, not in-place

A standalone ElastiCache cluster cannot be converted in place to an encrypted
replication group. Encryption flags (`at_rest_encryption_enabled`,
`transit_encryption_enabled`) are immutable at creation. So we stand up the new
group, cut traffic over, then retire the old cluster.

The application reads Redis connection details (host, port, password/AUTH, TLS)
from the `nanoclaw/app-config` Secrets Manager secret. Both clients already
support TLS + AUTH:
- TS (orchestrator): `ioredis` with `tls: {}` + `password` (src/cloud/bootstrap.ts)
- Python (sub-agent): `redis.asyncio` with `ssl=True` + `password` (container/sub-agent/src/main.py)

So cutover requires **no code change** — only config + a redeploy.

## Data loss expectations

Redis here is a queue + ephemeral cache (dispatch queue, PDPA flow TTLs,
scheduler dedup flags, rate-limit counters). It is NOT the system of record
(DynamoDB + S3 + OpenSearch are). A brief flush of in-flight queue entries on
cutover is acceptable given no SLA. If you must preserve in-flight messages,
drain the dispatch queue first (scale sub-agent workers up, orchestrator down).

## Steps

1. Generate an AUTH token (16-128 chars, no `/ @ "` spaces):
   ```
   openssl rand -base64 32 | tr -d '/+=@" ' | cut -c1-48
   ```

2. Store it as a TF var (CI secret or `terraform.tfvars`, never committed):
   ```
   redis_use_replication_group = true
   redis_replica_count         = 1
   redis_auth_token            = "<token>"
   ```

3. Apply — creates the replication group alongside the old cluster:
   ```
   terraform plan -out tf.plan
   terraform apply tf.plan
   terraform output redis_endpoint   # new primary endpoint:port
   ```

4. Update the `nanoclaw/app-config` secret:
   - `redis_host` = new primary endpoint
   - `redis_port` = 6379
   - `redis_password` = the AUTH token
   - `redis_tls` = true   (TS reads this; sub-agent reads REDIS_SSL — set both)
   For the sub-agent ECS task-def env: `REDIS_SSL=true`, `REDIS_PASSWORD=<token>`,
   `REDIS_HOST=<endpoint>`.

5. Roll the services (orchestrator EC2 + sub-agent ECS). Verify:
   - orchestrator log: "Cloud bootstrap: Redis connected"
   - sub-agent log: "Starting queue poll loop on key=queue:agent:dispatch"
   - send a test WhatsApp message end-to-end

6. Once healthy, retire the old cluster: the `count` toggle already set its
   count to 0, so the next `apply` (step 3) destroyed it. Confirm with
   `aws elasticache describe-cache-clusters`.

## Rollback

Set `redis_use_replication_group = false`, restore the prior `nanoclaw/app-config`
values (old endpoint, no AUTH, `redis_tls=false`), apply, redeploy. The old
cluster is recreated (empty). Acceptable because Redis is not the system of record.
