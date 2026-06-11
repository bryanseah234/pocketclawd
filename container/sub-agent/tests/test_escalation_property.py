"""
Property-based tests for escalation trigger logic.

Properties under test (REQ-8.1, REQ-8.2):
  P1. Tracker NEVER reports should_escalate() until at least
      ESCALATION_THRESHOLD consecutive failures have been recorded with
      no intervening success.
  P2. record_outcome(success=True) ALWAYS resets the counter to zero.
  P3. After exactly N consecutive failures, the tracker's failure_count
      equals N (modulo any preceding success which resets to zero).
  P4. get_escalation_event NEVER includes more than ESCALATION_THRESHOLD
      message IDs and never raises for any input sequence.
  P5. The failed_message_ids property returns at most failure_count items
      (never grows unbounded across success-reset boundaries).
"""

from datetime import datetime

from hypothesis import given, settings, strategies as st

from src.persona.escalation import (
    ESCALATION_THRESHOLD,
    TRIGGER_CONSECUTIVE_FAILURES,
    EscalationTracker,
)


# ── Strategies ──────────────────────────────────────────────────────────────


# Each "step" is (success: bool, message_id: str).
_step = st.tuples(
    st.booleans(),
    st.text(min_size=1, max_size=12).map(lambda s: f"m-{s}"),
)
_step_sequence = st.lists(_step, min_size=0, max_size=30)


def _trailing_failures(steps):
    """Count failures since the last success in `steps`."""
    n = 0
    for success, _ in reversed(steps):
        if success:
            return n
        n += 1
    return n


# ── Properties ──────────────────────────────────────────────────────────────


@given(steps=_step_sequence)
@settings(max_examples=300, deadline=None)
def test_should_escalate_only_when_threshold_consecutive_failures(steps):
    """P1: should_escalate() ↔ trailing failures ≥ ESCALATION_THRESHOLD."""
    tracker = EscalationTracker()
    for success, mid in steps:
        tracker.record_outcome(success=success, message_id=mid)

    expected = _trailing_failures(steps) >= ESCALATION_THRESHOLD
    assert tracker.should_escalate() is expected


@given(steps=_step_sequence, final_id=st.text(min_size=1, max_size=8))
@settings(max_examples=300, deadline=None)
def test_success_resets_counter_to_zero(steps, final_id):
    """P2: A success after any sequence drops failure_count to 0."""
    tracker = EscalationTracker()
    for success, mid in steps:
        tracker.record_outcome(success=success, message_id=mid)
    tracker.record_outcome(success=True, message_id=f"final-{final_id}")
    assert tracker.failure_count == 0
    assert tracker.failed_message_ids == []
    assert tracker.should_escalate() is False


@given(steps=_step_sequence)
@settings(max_examples=300, deadline=None)
def test_failure_count_matches_trailing_failures(steps):
    """P3: failure_count equals consecutive failures since last success."""
    tracker = EscalationTracker()
    for success, mid in steps:
        tracker.record_outcome(success=success, message_id=mid)
    assert tracker.failure_count == _trailing_failures(steps)


@given(steps=_step_sequence)
@settings(max_examples=300, deadline=None)
def test_failed_message_ids_bounded_by_failure_count(steps):
    """P5: len(failed_message_ids) == failure_count exactly."""
    tracker = EscalationTracker()
    for success, mid in steps:
        tracker.record_outcome(success=success, message_id=mid)
    assert len(tracker.failed_message_ids) == tracker.failure_count


@given(steps=_step_sequence)
@settings(max_examples=200, deadline=None)
def test_escalation_event_never_raises_and_caps_message_ids(steps):
    """P4: get_escalation_event always returns a valid event with capped IDs."""
    tracker = EscalationTracker()
    for success, mid in steps:
        tracker.record_outcome(success=success, message_id=mid)

    event = tracker.get_escalation_event(session_id="s1", user_id="u1")
    assert event.user_id == "u1"
    assert event.session_id == "s1"
    assert event.trigger == TRIGGER_CONSECUTIVE_FAILURES
    assert len(event.message_ids) <= ESCALATION_THRESHOLD
    # ISO timestamp parses
    datetime.fromisoformat(event.timestamp)
    # context contains the threshold
    assert str(ESCALATION_THRESHOLD) in event.context


@given(n=st.integers(min_value=0, max_value=10))
@settings(max_examples=50, deadline=None)
def test_pure_failure_run_escalates_iff_at_threshold(n):
    """A run of N failures (no successes) escalates ⟺ N ≥ threshold."""
    tracker = EscalationTracker()
    for i in range(n):
        tracker.record_outcome(success=False, message_id=f"f-{i}")
    assert tracker.should_escalate() is (n >= ESCALATION_THRESHOLD)
    assert tracker.failure_count == n


@given(
    pre_failures=st.integers(min_value=0, max_value=5),
    post_failures=st.integers(min_value=0, max_value=5),
)
@settings(max_examples=50, deadline=None)
def test_success_in_middle_resets_window(pre_failures, post_failures):
    """A success between two failure runs makes only the trailing run count."""
    tracker = EscalationTracker()
    for i in range(pre_failures):
        tracker.record_outcome(success=False, message_id=f"pre-{i}")
    tracker.record_outcome(success=True, message_id="reset")
    for i in range(post_failures):
        tracker.record_outcome(success=False, message_id=f"post-{i}")
    assert tracker.failure_count == post_failures
    assert tracker.should_escalate() is (post_failures >= ESCALATION_THRESHOLD)


@given(
    n=st.integers(min_value=ESCALATION_THRESHOLD, max_value=15),
    extra=st.text(min_size=1, max_size=6),
)
@settings(max_examples=50, deadline=None)
def test_escalation_event_uses_last_threshold_ids(n, extra):
    """Event.message_ids is exactly the last ESCALATION_THRESHOLD failure IDs."""
    tracker = EscalationTracker()
    ids = []
    for i in range(n):
        mid = f"{extra}-{i}"
        ids.append(mid)
        tracker.record_outcome(success=False, message_id=mid)
    event = tracker.get_escalation_event(session_id="s", user_id="u")
    assert event.message_ids == ids[-ESCALATION_THRESHOLD:]
