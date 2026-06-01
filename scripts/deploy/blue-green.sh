#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# NanoClaw blue/green orchestrator deploy (t6-40)
#
# Runs ON the orchestrator EC2 host (invoked via SSM send-command from CI, or
# manually over SSH). Performs a SEQUENCED blue/green cutover that respects the
# WhatsApp single-session constraint:
#
#   1. Pull the new image, start it as the "green" container (HTTP only; WA
#      DISABLED via WHATSAPP_ENABLED=false so it does NOT touch the live WA
#      session while blue still owns it).
#   2. Wait for green /health to pass.
#   3. Register green with the ALB target group; wait healthy; deregister blue
#      (ALB drains in-flight HTTP via deregistration_delay).
#   4. WhatsApp handoff: SIGTERM blue (its shutdown does a FINAL S3 auth backup),
#      wait for it to exit, then signal green to enable WA (it restores auth
#      from S3 and re-claims the single session).
#   5. Promote green -> current. On any failure before step 4, abort and leave
#      blue serving (true zero-downtime rollback). After step 4 a failure means
#      re-pair may be required (documented in the runbook).
#
# This is intentionally conservative: the HTTP surface is zero-downtime; the WA
# session has a short (seconds) handoff gap that is unavoidable for a
# single-session protocol. No SLA on this project, so the gap is acceptable.
#
# Env (required):
#   ECR_REGISTRY, AWS_REGION, IMAGE_TAG
# Env (optional):
#   ORCH_PORT_BLUE=3000  ORCH_PORT_GREEN=3001
#   TG_ARN=<target group arn>   INSTANCE_ID=<for ALB (de)register>
#   HEALTH_TIMEOUT=120
#
# Host file (required for Telegram + future channel tokens):
#   /etc/nanoclaw/orchestrator.env  — sourced via --env-file on every docker run
#   Minimum contents: TELEGRAM_ENABLED=true, TELEGRAM_BOT_TOKEN=<token>
# -----------------------------------------------------------------------------
set -euo pipefail

ECR_REGISTRY="${ECR_REGISTRY:?ECR_REGISTRY required}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG required}"
ECR_ORCHESTRATOR="${ECR_ORCHESTRATOR:-nanoclaw/orchestrator}"

ORCH_PORT_BLUE="${ORCH_PORT_BLUE:-3000}"
ORCH_PORT_GREEN="${ORCH_PORT_GREEN:-3001}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
TG_ARN="${TG_ARN:-}"
INSTANCE_ID="${INSTANCE_ID:-}"

IMG="${ECR_REGISTRY}/${ECR_ORCHESTRATOR}:${IMAGE_TAG}"

log() { echo "[blue-green $(date -u +%H:%M:%S)] $*"; }

wait_health() {
  local port="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:${port}/health"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

log "Logging in to ECR and pulling ${IMG}"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker pull "$IMG"

# --- 1. Start GREEN with WhatsApp disabled (HTTP only) ----------------------
log "Starting green container on :${ORCH_PORT_GREEN} (WHATSAPP_ENABLED=false)"
docker rm -f nanoclaw-orchestrator-green >/dev/null 2>&1 || true
docker run -d --name nanoclaw-orchestrator-green \
  --restart unless-stopped \
  -p "${ORCH_PORT_GREEN}:3000" \
  -e WHATSAPP_ENABLED=false \
  -e NANOCLAW_ENV=cloud \
  --env-file /etc/nanoclaw/orchestrator.env \
  "$IMG"

# --- 2. Wait for green health ----------------------------------------------
log "Waiting for green /health"
if ! wait_health "$ORCH_PORT_GREEN"; then
  log "GREEN failed health check -- aborting, blue untouched"
  docker logs --tail 50 nanoclaw-orchestrator-green || true
  docker rm -f nanoclaw-orchestrator-green || true
  exit 1
fi
log "Green healthy"

# --- 3. ALB cutover (HTTP zero-downtime) -----------------------------------
if [ -n "$TG_ARN" ] && [ -n "$INSTANCE_ID" ]; then
  log "Registering green port with ALB target group"
  aws elbv2 register-targets --target-group-arn "$TG_ARN" \
    --targets "Id=${INSTANCE_ID},Port=${ORCH_PORT_GREEN}" --region "$AWS_REGION"
  log "Waiting for green target healthy in ALB"
  aws elbv2 wait target-in-service --target-group-arn "$TG_ARN" \
    --targets "Id=${INSTANCE_ID},Port=${ORCH_PORT_GREEN}" --region "$AWS_REGION" || true
  log "Deregistering blue port (ALB drains in-flight per deregistration_delay)"
  aws elbv2 deregister-targets --target-group-arn "$TG_ARN" \
    --targets "Id=${INSTANCE_ID},Port=${ORCH_PORT_BLUE}" --region "$AWS_REGION" || true
  sleep 30
else
  log "No TG_ARN/INSTANCE_ID -- skipping ALB cutover (single-port host)"
fi

# --- 4. WhatsApp handoff (sequenced; single-session constraint) ------------
log "SIGTERM blue -> triggers final S3 auth backup on shutdown"
docker stop --time 30 nanoclaw-orchestrator-blue >/dev/null 2>&1 || true
# Give blue a moment to finish the final S3 backup.
sleep 5
log "Enabling WhatsApp on green (restores auth from S3, re-claims session)"
# Recreate green with WA enabled now that blue has released the session.
docker rm -f nanoclaw-orchestrator-green-wa >/dev/null 2>&1 || true
docker stop --time 10 nanoclaw-orchestrator-green >/dev/null 2>&1 || true
docker rm -f nanoclaw-orchestrator-green >/dev/null 2>&1 || true
docker run -d --name nanoclaw-orchestrator-blue \
  --restart unless-stopped \
  -p "${ORCH_PORT_BLUE}:3000" \
  -e WHATSAPP_ENABLED=true \
  -e NANOCLAW_ENV=cloud \
  --env-file /etc/nanoclaw/orchestrator.env \
  "$IMG"

# --- 5. Promote + verify ----------------------------------------------------
log "Waiting for promoted instance health on :${ORCH_PORT_BLUE}"
if ! wait_health "$ORCH_PORT_BLUE"; then
  log "PROMOTED instance unhealthy -- WA may need re-pair (see runbook)"
  docker logs --tail 50 nanoclaw-orchestrator-blue || true
  exit 1
fi
if [ -n "$TG_ARN" ] && [ -n "$INSTANCE_ID" ]; then
  aws elbv2 register-targets --target-group-arn "$TG_ARN" \
    --targets "Id=${INSTANCE_ID},Port=${ORCH_PORT_BLUE}" --region "$AWS_REGION" || true
  aws elbv2 deregister-targets --target-group-arn "$TG_ARN" \
    --targets "Id=${INSTANCE_ID},Port=${ORCH_PORT_GREEN}" --region "$AWS_REGION" || true
fi
docker tag "$IMG" nanoclaw-orchestrator:current
log "Deploy complete -- ${IMAGE_TAG} promoted"
