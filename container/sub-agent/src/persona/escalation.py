"""
Escalation Logger — tracks consecutive failures and logs escalation events.

Logs escalation events to DynamoDB via the DataGateway Worker (using the existing
`log_system_error` action with `errorType: "escalation"`) and emits a CloudWatch
metric. Implements best-effort logging: if DynamoDB write fails, logs directly to
CloudWatch; never blocks user-facing response.

Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

import boto3
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DATA_GATEWAY_QUEUE = "queue:orchestrator:data_gateway"
ESCALATION_THRESHOLD = 3
CLOUDWATCH_NAMESPACE = "NanoClaw/Escalation"
CLOUDWATCH_METRIC_NAME = "EscalationTriggered"

# Valid trigger types
TRIGGER_CONSECUTIVE_FAILURES = "consecutive_failures"
TRIGGER_UNKNOWN_DOMAIN = "unknown_domain"
TRIGGER_COMPLIANCE_SENSITIVE = "compliance_sensitive"

VALID_TRIGGERS = {
    TRIGGER_CONSECUTIVE_FAILURES,
    TRIGGER_UNKNOWN_DOMAIN,
    TRIGGER_COMPLIANCE_SENSITIVE,
}


# ---------------------------------------------------------------------------
# Data Models
# ---------------------------------------------------------------------------


@dataclass
class EscalationEvent:
    """Structured escalation event for logging and tracking."""

    user_id: str
    trigger: str  # "consecutive_failures" | "unknown_domain" | "compliance_sensitive"
    context: str  # Summary of what triggered escalation
    session_id: str
    timestamp: str  # ISO 8601
    message_ids: list[str]  # Related message IDs


# ---------------------------------------------------------------------------
# Escalation Tracker
# ---------------------------------------------------------------------------


@dataclass
class EscalationTracker:
    """
    Tracks consecutive failures per session.

    Increments a counter on failed resolution, resets on success,
    and triggers escalation at ESCALATION_THRESHOLD (3) consecutive failures.
    """

    _failure_count: int = field(default=0, init=False)
    _failed_message_ids: list[str] = field(default_factory=list, init=False)

    def record_outcome(self, success: bool, message_id: str) -> None:
        """
        Record a resolution outcome.

        On failure: increment counter and track the message ID.
        On success: reset counter and clear tracked message IDs.
        """
        if success:
            self._failure_count = 0
            self._failed_message_ids = []
        else:
            self._failure_count += 1
            self._failed_message_ids.append(message_id)

    def should_escalate(self) -> bool:
        """Return True when consecutive failures reach the threshold (3)."""
        return self._failure_count >= ESCALATION_THRESHOLD

    def get_escalation_event(self, session_id: str, user_id: str) -> EscalationEvent:
        """
        Build an EscalationEvent from the current tracker state.

        Uses the last ESCALATION_THRESHOLD message IDs as the related messages.
        """
        # Take only the last N message IDs corresponding to the threshold
        related_ids = self._failed_message_ids[-ESCALATION_THRESHOLD:]

        return EscalationEvent(
            user_id=user_id,
            trigger=TRIGGER_CONSECUTIVE_FAILURES,
            context=f"{ESCALATION_THRESHOLD} consecutive failed resolutions",
            session_id=session_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            message_ids=related_ids,
        )

    @property
    def failure_count(self) -> int:
        """Current consecutive failure count."""
        return self._failure_count

    @property
    def failed_message_ids(self) -> list[str]:
        """Message IDs of consecutive failures."""
        return list(self._failed_message_ids)


# ---------------------------------------------------------------------------
# CloudWatch Metric Emission
# ---------------------------------------------------------------------------


def _emit_cloudwatch_metric(event: EscalationEvent, region: str = "ap-southeast-1") -> None:
    """
    Emit a CloudWatch metric for the escalation event.

    Best-effort: logs warning on failure but never raises.
    """
    try:
        client = boto3.client("cloudwatch", region_name=region)
        client.put_metric_data(
            Namespace=CLOUDWATCH_NAMESPACE,
            MetricData=[
                {
                    "MetricName": CLOUDWATCH_METRIC_NAME,
                    "Dimensions": [
                        {"Name": "Trigger", "Value": event.trigger},
                        {"Name": "UserId", "Value": event.user_id},
                    ],
                    "Timestamp": datetime.fromisoformat(event.timestamp),
                    "Value": 1.0,
                    "Unit": "Count",
                },
            ],
        )
    except Exception as e:
        logger.warning("Failed to emit CloudWatch metric: %s", e)


# ---------------------------------------------------------------------------
# Escalation Logging
# ---------------------------------------------------------------------------


async def log_escalation(
    redis: aioredis.Redis,
    event: EscalationEvent,
    region: str = "ap-southeast-1",
) -> None:
    """
    Log escalation to DynamoDB via DataGateway and emit CloudWatch metric.

    Uses the existing `log_system_error` action with `errorType: "escalation"`.
    Best-effort: if DynamoDB write fails, logs directly to CloudWatch.
    Never blocks user-facing response.

    Args:
        redis: Redis client for communicating with DataGateway Worker.
        event: The escalation event to log.
        region: AWS region for CloudWatch metric emission.
    """
    # Build the DataGateway request using the log_system_error action format
    stack_trace_data = json.dumps({
        "trigger": event.trigger,
        "sessionId": event.session_id,
        "messageIds": event.message_ids,
    })

    request = {
        "action": "log_system_error",
        "user_id": event.user_id,
        "error": {
            "errorType": "escalation",
            "message": event.context,
            "stackTrace": stack_trace_data,
        },
    }

    # Attempt DynamoDB write via DataGateway
    dynamo_success = False
    try:
        await redis.lpush(DATA_GATEWAY_QUEUE, json.dumps(request))
        dynamo_success = True
        logger.info(
            "Escalation event logged to DataGateway: user_id=%s trigger=%s session_id=%s",
            event.user_id,
            event.trigger,
            event.session_id,
        )
    except Exception as e:
        logger.warning(
            "Failed to log escalation to DataGateway (will fallback to CloudWatch): %s", e
        )

    # Always emit CloudWatch metric
    _emit_cloudwatch_metric(event, region=region)

    # If DynamoDB write failed, log structured event directly to CloudWatch via logger
    # (CloudWatch Logs picks up stdout/stderr from the container)
    if not dynamo_success:
        logger.error(
            "ESCALATION_FALLBACK: %s",
            json.dumps({
                "user_id": event.user_id,
                "trigger": event.trigger,
                "context": event.context,
                "session_id": event.session_id,
                "timestamp": event.timestamp,
                "message_ids": event.message_ids,
            }),
        )
