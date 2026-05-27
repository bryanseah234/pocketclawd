"""
Unit tests for the Escalation Logger module.

Tests consecutive failure tracking, escalation event construction,
DynamoDB logging via DataGateway, CloudWatch metric emission, and
graceful fallback behavior.

Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
"""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.persona.escalation import (
    DATA_GATEWAY_QUEUE,
    ESCALATION_THRESHOLD,
    TRIGGER_COMPLIANCE_SENSITIVE,
    TRIGGER_CONSECUTIVE_FAILURES,
    TRIGGER_UNKNOWN_DOMAIN,
    VALID_TRIGGERS,
    EscalationEvent,
    EscalationTracker,
    log_escalation,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class FakeRedis:
    """Minimal fake Redis client for testing escalation logging."""

    def __init__(self, *, should_fail: bool = False):
        self.queues: dict[str, list[str]] = {}
        self._should_fail = should_fail

    async def lpush(self, key: str, value: str) -> int:
        if self._should_fail:
            raise ConnectionError("Redis connection lost")
        if key not in self.queues:
            self.queues[key] = []
        self.queues[key].append(value)
        return len(self.queues[key])

    def get_last_request(self, queue_key: str = DATA_GATEWAY_QUEUE) -> dict | None:
        """Get the last request sent to a queue."""
        if queue_key in self.queues and self.queues[queue_key]:
            return json.loads(self.queues[queue_key][-1])
        return None


@pytest.fixture
def fake_redis():
    return FakeRedis()


@pytest.fixture
def failing_redis():
    return FakeRedis(should_fail=True)


@pytest.fixture
def tracker():
    return EscalationTracker()


@pytest.fixture
def sample_event():
    return EscalationEvent(
        user_id="user-123",
        trigger=TRIGGER_CONSECUTIVE_FAILURES,
        context="3 consecutive failed resolutions",
        session_id="sess-456",
        timestamp=datetime.now(timezone.utc).isoformat(),
        message_ids=["msg-1", "msg-2", "msg-3"],
    )


# ---------------------------------------------------------------------------
# EscalationTracker Tests
# ---------------------------------------------------------------------------


class TestEscalationTracker:
    """Tests for the EscalationTracker class."""

    def test_initial_state_no_escalation(self, tracker):
        """Tracker starts with zero failures and should not escalate."""
        assert tracker.failure_count == 0
        assert tracker.should_escalate() is False
        assert tracker.failed_message_ids == []

    def test_failure_increments_counter(self, tracker):
        """Recording a failure increments the consecutive failure count."""
        tracker.record_outcome(success=False, message_id="msg-1")
        assert tracker.failure_count == 1
        assert tracker.should_escalate() is False

    def test_success_resets_counter(self, tracker):
        """Recording a success resets the consecutive failure count to zero."""
        tracker.record_outcome(success=False, message_id="msg-1")
        tracker.record_outcome(success=False, message_id="msg-2")
        assert tracker.failure_count == 2

        tracker.record_outcome(success=True, message_id="msg-3")
        assert tracker.failure_count == 0
        assert tracker.failed_message_ids == []

    def test_escalation_triggers_at_exactly_3_failures(self, tracker):
        """Escalation triggers at exactly 3 consecutive failures."""
        tracker.record_outcome(success=False, message_id="msg-1")
        assert tracker.should_escalate() is False

        tracker.record_outcome(success=False, message_id="msg-2")
        assert tracker.should_escalate() is False

        tracker.record_outcome(success=False, message_id="msg-3")
        assert tracker.should_escalate() is True

    def test_escalation_remains_true_beyond_threshold(self, tracker):
        """Escalation stays true if failures continue beyond threshold."""
        for i in range(5):
            tracker.record_outcome(success=False, message_id=f"msg-{i}")
        assert tracker.should_escalate() is True
        assert tracker.failure_count == 5

    def test_tracks_failed_message_ids(self, tracker):
        """Tracker records message IDs of consecutive failures."""
        tracker.record_outcome(success=False, message_id="msg-a")
        tracker.record_outcome(success=False, message_id="msg-b")
        tracker.record_outcome(success=False, message_id="msg-c")

        assert tracker.failed_message_ids == ["msg-a", "msg-b", "msg-c"]

    def test_success_clears_message_ids(self, tracker):
        """Success clears the tracked failed message IDs."""
        tracker.record_outcome(success=False, message_id="msg-1")
        tracker.record_outcome(success=False, message_id="msg-2")
        tracker.record_outcome(success=True, message_id="msg-3")

        assert tracker.failed_message_ids == []

    def test_get_escalation_event_builds_correct_event(self, tracker):
        """get_escalation_event builds an EscalationEvent with correct fields."""
        tracker.record_outcome(success=False, message_id="msg-1")
        tracker.record_outcome(success=False, message_id="msg-2")
        tracker.record_outcome(success=False, message_id="msg-3")

        event = tracker.get_escalation_event(session_id="sess-abc", user_id="user-xyz")

        assert event.user_id == "user-xyz"
        assert event.trigger == TRIGGER_CONSECUTIVE_FAILURES
        assert event.session_id == "sess-abc"
        assert event.message_ids == ["msg-1", "msg-2", "msg-3"]
        assert "3" in event.context
        assert event.timestamp  # Non-empty ISO timestamp

    def test_get_escalation_event_uses_last_n_message_ids(self, tracker):
        """When more than threshold failures, event uses last N message IDs."""
        for i in range(5):
            tracker.record_outcome(success=False, message_id=f"msg-{i}")

        event = tracker.get_escalation_event(session_id="sess-1", user_id="user-1")

        # Should use the last 3 (ESCALATION_THRESHOLD) message IDs
        assert event.message_ids == ["msg-2", "msg-3", "msg-4"]

    def test_interleaved_success_failure_no_escalation(self, tracker):
        """Interleaved success/failure never reaches threshold."""
        tracker.record_outcome(success=False, message_id="msg-1")
        tracker.record_outcome(success=False, message_id="msg-2")
        tracker.record_outcome(success=True, message_id="msg-3")
        tracker.record_outcome(success=False, message_id="msg-4")
        tracker.record_outcome(success=False, message_id="msg-5")
        tracker.record_outcome(success=True, message_id="msg-6")

        assert tracker.should_escalate() is False


# ---------------------------------------------------------------------------
# log_escalation Tests
# ---------------------------------------------------------------------------


class TestLogEscalation:
    """Tests for the log_escalation function."""

    @pytest.mark.asyncio
    async def test_logs_to_data_gateway(self, fake_redis, sample_event):
        """Escalation event is logged to DynamoDB via DataGateway queue."""
        with patch("src.persona.escalation._emit_cloudwatch_metric"):
            await log_escalation(fake_redis, sample_event)

        request = fake_redis.get_last_request()
        assert request is not None
        assert request["action"] == "log_system_error"
        assert request["user_id"] == "user-123"
        assert request["error"]["errorType"] == "escalation"
        assert request["error"]["message"] == sample_event.context

    @pytest.mark.asyncio
    async def test_stack_trace_contains_trigger_and_session(self, fake_redis, sample_event):
        """The stackTrace field contains trigger, sessionId, and messageIds."""
        with patch("src.persona.escalation._emit_cloudwatch_metric"):
            await log_escalation(fake_redis, sample_event)

        request = fake_redis.get_last_request()
        stack_trace = json.loads(request["error"]["stackTrace"])

        assert stack_trace["trigger"] == TRIGGER_CONSECUTIVE_FAILURES
        assert stack_trace["sessionId"] == "sess-456"
        assert stack_trace["messageIds"] == ["msg-1", "msg-2", "msg-3"]

    @pytest.mark.asyncio
    async def test_emits_cloudwatch_metric(self, fake_redis, sample_event):
        """CloudWatch metric is emitted for the escalation event."""
        with patch("src.persona.escalation._emit_cloudwatch_metric") as mock_cw:
            await log_escalation(fake_redis, sample_event)

        mock_cw.assert_called_once_with(sample_event, region="ap-southeast-1")

    @pytest.mark.asyncio
    async def test_graceful_handling_when_redis_fails(self, failing_redis, sample_event):
        """When DynamoDB write fails, logs to CloudWatch without raising."""
        with patch("src.persona.escalation._emit_cloudwatch_metric") as mock_cw:
            # Should not raise
            await log_escalation(failing_redis, sample_event)

        # CloudWatch metric should still be emitted
        mock_cw.assert_called_once()

    @pytest.mark.asyncio
    async def test_fallback_logs_to_cloudwatch_on_redis_failure(self, failing_redis, sample_event):
        """When Redis fails, structured event is logged via logger (CloudWatch Logs)."""
        with (
            patch("src.persona.escalation._emit_cloudwatch_metric"),
            patch("src.persona.escalation.logger") as mock_logger,
        ):
            await log_escalation(failing_redis, sample_event)

        # Should log the fallback error with structured data
        mock_logger.error.assert_called_once()
        call_args = mock_logger.error.call_args
        assert "ESCALATION_FALLBACK" in call_args[0][0]


# ---------------------------------------------------------------------------
# EscalationEvent Tests
# ---------------------------------------------------------------------------


class TestEscalationEvent:
    """Tests for the EscalationEvent dataclass."""

    def test_valid_trigger_types(self):
        """All valid trigger types are supported."""
        assert TRIGGER_CONSECUTIVE_FAILURES in VALID_TRIGGERS
        assert TRIGGER_UNKNOWN_DOMAIN in VALID_TRIGGERS
        assert TRIGGER_COMPLIANCE_SENSITIVE in VALID_TRIGGERS
        assert len(VALID_TRIGGERS) == 3

    def test_event_construction(self):
        """EscalationEvent can be constructed with all required fields."""
        event = EscalationEvent(
            user_id="user-1",
            trigger=TRIGGER_UNKNOWN_DOMAIN,
            context="Query about quantum physics outside configured domains",
            session_id="sess-1",
            timestamp="2024-01-15T10:30:00Z",
            message_ids=["msg-1"],
        )

        assert event.user_id == "user-1"
        assert event.trigger == TRIGGER_UNKNOWN_DOMAIN
        assert event.session_id == "sess-1"
        assert event.message_ids == ["msg-1"]


# ---------------------------------------------------------------------------
# CloudWatch Metric Tests
# ---------------------------------------------------------------------------


class TestCloudWatchMetric:
    """Tests for CloudWatch metric emission."""

    def test_emit_metric_calls_boto3(self, sample_event):
        """_emit_cloudwatch_metric calls boto3 CloudWatch put_metric_data."""
        from src.persona.escalation import _emit_cloudwatch_metric

        mock_client = MagicMock()
        with patch("src.persona.escalation.boto3.client", return_value=mock_client):
            _emit_cloudwatch_metric(sample_event)

        mock_client.put_metric_data.assert_called_once()
        call_kwargs = mock_client.put_metric_data.call_args[1]
        assert call_kwargs["Namespace"] == "NanoClaw/Escalation"
        assert call_kwargs["MetricData"][0]["MetricName"] == "EscalationTriggered"
        assert call_kwargs["MetricData"][0]["Value"] == 1.0

    def test_emit_metric_includes_dimensions(self, sample_event):
        """CloudWatch metric includes Trigger and UserId dimensions."""
        from src.persona.escalation import _emit_cloudwatch_metric

        mock_client = MagicMock()
        with patch("src.persona.escalation.boto3.client", return_value=mock_client):
            _emit_cloudwatch_metric(sample_event)

        metric_data = mock_client.put_metric_data.call_args[1]["MetricData"][0]
        dimensions = {d["Name"]: d["Value"] for d in metric_data["Dimensions"]}
        assert dimensions["Trigger"] == TRIGGER_CONSECUTIVE_FAILURES
        assert dimensions["UserId"] == "user-123"

    def test_emit_metric_does_not_raise_on_failure(self, sample_event):
        """CloudWatch metric emission failure is logged but does not raise."""
        from src.persona.escalation import _emit_cloudwatch_metric

        with patch("src.persona.escalation.boto3.client", side_effect=Exception("AWS error")):
            # Should not raise
            _emit_cloudwatch_metric(sample_event)
