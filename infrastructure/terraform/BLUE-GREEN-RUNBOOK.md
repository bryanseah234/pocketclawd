# Blue/Green Deploy Runbook

Use this when you need zero-downtime deploy of a change that cannot
roll out incrementally (schema change, breaking config change, etc.).

## Prerequisites

- Two ECS task definitions prepared (blue = current, green = new)
- Both images pushed to ECR

## Steps

1. Stand up the green service alongside blue:
   ```bash
   aws ecs update-service      --cluster nanoclaw-cluster      --service nanoclaw-sub-agent-green      --task-definition nanoclaw-sub-agent:<GREEN_REV>      --desired-count 2      --profile clawd-prod --region ap-southeast-1
   ```

2. Wait for green tasks to reach RUNNING state:
   ```bash
   aws ecs wait services-stable      --cluster nanoclaw-cluster      --services nanoclaw-sub-agent-green      --profile clawd-prod --region ap-southeast-1
   ```

3. Send a test message through the admin dashboard to confirm green is healthy.

4. Drain blue by setting desired count to 0:
   ```bash
   aws ecs update-service      --cluster nanoclaw-cluster      --service nanoclaw-sub-agent      --desired-count 0      --profile clawd-prod --region ap-southeast-1
   ```

5. Monitor for errors in /ecs/nanoclaw-sub-agent logs for 5 minutes.

6. If green is good, delete the blue service or leave at 0 desired count.

7. If green is bad, scale blue back up and drain green.

## Rollback

```bash
aws ecs update-service   --cluster nanoclaw-cluster   --service nanoclaw-sub-agent   --desired-count 2   --profile clawd-prod --region ap-southeast-1
aws ecs update-service   --cluster nanoclaw-cluster   --service nanoclaw-sub-agent-green   --desired-count 0   --profile clawd-prod --region ap-southeast-1
```
