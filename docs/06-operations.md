# Operations & Runbooks

All commands use `--profile clawd-prod --region ap-southeast-1`.

## Disaster recovery

### Sub-agent down (no replies, 0 ECS tasks)
```bash
aws ecs describe-services --cluster nanoclaw-cluster --services nanoclaw-sub-agent \
  --query 'services[0].{running:runningCount,events:events[0:3]}'
aws logs tail /ecs/nanoclaw-sub-agent --since 30m
aws ecs update-service --cluster nanoclaw-cluster --service nanoclaw-sub-agent --force-new-deployment
```
If new tasks crash on start, roll back the task definition (see
[03-deployment.md](03-deployment.md)).

### Orchestrator (EC2) down
```bash
aws ec2 describe-instances --instance-ids i-0f9cd20350cfdc1a6 \
  --query 'Reservations[0].Instances[0].State.Name'
aws ec2 start-instances --instance-ids i-0f9cd20350cfdc1a6   # if stopped
aws ssm start-session --target i-0f9cd20350cfdc1a6
# On EC2:
sudo systemctl status nanoclaw; sudo systemctl restart nanoclaw
```

### Redis
ElastiCache is managed with automatic Multi-AZ failover. If unreachable, check
cluster status; if failed, raise an AWS support ticket. Sub-agent tasks
backpressure and retry via the DLQ meanwhile.

### DynamoDB (PITR enabled on all tables)
```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name nanoclaw-chat-messages \
  --target-table-name nanoclaw-chat-messages-restore --use-latest-restorable-time
```

### S3 (versioning enabled)
List object versions, then remove the delete marker to restore.

### OpenSearch Serverless
Fully managed, no restart. If the endpoint is unreachable the sub-agent falls
back to LLM-only replies (no personal-KB context) — users still get answers.

### Full rebuild
```bash
cd infrastructure/terraform && terraform init && terraform plan -out=tfplan && terraform apply tfplan
```
Then push code (triggers image build + ECS deploy), bootstrap the new EC2, and
restore DynamoDB from PITR if needed.

---

## Blue/green deploy (zero-downtime, breaking changes)

For a change that can't roll out incrementally. Stand up a green service
alongside blue, wait for it to stabilise, smoke-test via the admin dashboard,
then drain blue to 0 desired count. Roll back by scaling blue up and green down.

```bash
aws ecs update-service --cluster nanoclaw-cluster --service nanoclaw-sub-agent-green \
  --task-definition nanoclaw-sub-agent:<GREEN_REV> --desired-count 2
aws ecs wait services-stable --cluster nanoclaw-cluster --services nanoclaw-sub-agent-green
# smoke test, then:
aws ecs update-service --cluster nanoclaw-cluster --service nanoclaw-sub-agent --desired-count 0
```

---

## Redis cutover (version / instance / endpoint change)

1. Confirm the new cluster is `AVAILABLE`
2. Drain queues on the old cluster (`llen queue:agent:dispatch`, `queue:orchestrator:responses`)
3. `sudo systemctl stop nanoclaw` (maintenance mode)
4. Update `REDIS_URL` in Secrets Manager (read → set → write)
5. `sudo systemctl start nanoclaw`
6. Force ECS redeploy so the sub-agent picks up the new URL
7. Smoke-test via the admin dashboard

Revert `REDIS_URL` and restart both services if anything breaks. Reminders in
the old sorted sets must be migrated by hand if any were set during the window.

---

## Caddy TLS (C9 — pending domain)

Once a domain points at the EC2 box, run on `i-0f9cd20350cfdc1a6`:

```bash
DOMAIN="clawd.YOURDOMAIN.com"; EMAIL="you@YOURDOMAIN.com"
# Amazon Linux 2023:
sudo dnf install -y dnf-plugins-core && sudo dnf copr enable -y @caddy/caddy && sudo dnf install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
{ email ${EMAIL} }
${DOMAIN} {
  encode gzip zstd
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Forwarded-Proto {scheme}
    header_up X-Real-IP {remote_host}
  }
}
EOF
sudo systemctl enable --now caddy && sleep 60 && curl -fsv "https://${DOMAIN}/health"
```

After TLS is live: set `PUBLIC_BASE_URL`, register the Telegram webhook
(`setWebhook` to `https://${DOMAIN}/telegram/webhook`), set
`USE_TELEGRAM_WEBHOOK=true`, close port 3000 to the public, keep 80/443, then
proceed to C10 (Singapore IP lockdown).

**Failure modes:** LE *unauthorized* = DNS not propagated (wait, restart caddy);
LE *too many requests* = weekly rate limit (use ZeroSSL or wait); Caddy 502 =
orchestrator not on :3000 (`docker ps | grep nanoclaw-orchestrator`).

---

## Queue inspection
```bash
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript \
  --parameters commands='["redis-cli -u $REDIS_URL llen queue:agent:dispatch"]'
```
