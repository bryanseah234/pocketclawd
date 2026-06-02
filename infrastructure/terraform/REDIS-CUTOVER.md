# Redis Cutover Runbook

Use when migrating to a new Redis cluster (version upgrade, instance type change,
or endpoint change).

## Before cutover

1. Confirm new cluster is in AVAILABLE state:
   ```bash
   aws elasticache describe-cache-clusters      --cache-cluster-id nanoclaw-redis-new      --profile clawd-prod --region ap-southeast-1      --query 'CacheClusters[0].CacheClusterStatus'
   ```

2. Check current queue depths on the old cluster. Wait for queues to drain:
   ```bash
   # Via SSM on EC2
   redis-cli -u $REDIS_URL llen queue:agent:dispatch
   redis-cli -u $REDIS_URL llen queue:orchestrator:responses
   ```

3. Put the orchestrator in maintenance mode (stop accepting new messages):
   ```bash
   sudo systemctl stop nanoclaw
   ```

## Cutover

4. Update REDIS_URL in nanoclaw/app-config (Secrets Manager):
   read -> set REDIS_URL to new endpoint -> write back

5. Restart orchestrator:
   ```bash
   sudo systemctl start nanoclaw
   ```

6. Trigger ECS force-redeploy so sub-agent picks up new REDIS_URL:
   ```bash
   aws ecs update-service      --cluster nanoclaw-cluster --service nanoclaw-sub-agent      --force-new-deployment      --profile clawd-prod --region ap-southeast-1
   ```

7. Send a test message via admin dashboard. Confirm response is delivered.

## If something breaks

Revert REDIS_URL in Secrets Manager to old endpoint and restart both services.
Reminders in the old Redis sorted sets will need to be migrated manually if
any were set by users during the outage window.
