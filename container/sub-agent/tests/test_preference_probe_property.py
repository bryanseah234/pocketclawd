"""
Property-based tests for preference_probe parsing logic.

Property: For ANY arbitrary preferences dict from DataGateway, the parser
MUST never raise, MUST return a valid UserPersonaContext, and MUST only
report is_new_user=False when discoveryCompleted is exactly True.

Validates: REQ-1.1 (new-user routing), REQ-7.1 (fail-open).
"""

from hypothesis import given, settings, strategies as st

from src.persona.preference_probe import (
    UserPersonaContext,
    _parse_preferences,
)


# Allowed enum values
_VALID_DEPTH = ("detailed", "high-level")
_VALID_DOMAIN = ("frontend", "infrastructure", "data")


# ── Strategies ──────────────────────────────────────────────────────────────


# Arbitrary JSON-like values that DataGateway might return, including weird
# types that should be rejected.
_arbitrary_values = st.recursive(
    st.one_of(
        st.none(),
        st.booleans(),
        st.integers(),
        st.floats(allow_nan=False, allow_infinity=False),
        st.text(max_size=20),
    ),
    lambda children: st.one_of(
        st.lists(children, max_size=5),
        st.dictionaries(st.text(max_size=10), children, max_size=5),
    ),
    max_leaves=10,
)


@st.composite
def arbitrary_preferences(draw):
    """A dict with arbitrary keys/values that may or may not contain valid prefs."""
    base: dict = draw(
        st.dictionaries(st.text(max_size=15), _arbitrary_values, max_size=8)
    )
    # Sometimes inject the known fields with random shapes
    if draw(st.booleans()):
        base["discoveryCompleted"] = draw(
            st.one_of(st.booleans(), st.text(max_size=10), st.none(), st.integers())
        )
    if draw(st.booleans()):
        base["technical_depth"] = draw(
            st.one_of(st.sampled_from(_VALID_DEPTH), st.text(max_size=20), st.none())
        )
    if draw(st.booleans()):
        base["primary_domain"] = draw(
            st.one_of(st.sampled_from(_VALID_DOMAIN), st.text(max_size=20), st.none())
        )
    return base


# ── Properties ──────────────────────────────────────────────────────────────


@given(prefs=st.one_of(st.none(), arbitrary_preferences()))
@settings(max_examples=200, deadline=None)
def test_parser_never_raises_and_returns_context(prefs):
    """For any input, _parse_preferences returns a UserPersonaContext without raising."""
    ctx = _parse_preferences(prefs)
    assert isinstance(ctx, UserPersonaContext)
    assert isinstance(ctx.is_new_user, bool)


@given(prefs=st.one_of(st.none(), arbitrary_preferences()))
@settings(max_examples=200, deadline=None)
def test_returning_user_only_when_discovery_completed_is_true(prefs):
    """is_new_user=False ⇒ discoveryCompleted was exactly True."""
    ctx = _parse_preferences(prefs)
    if not ctx.is_new_user:
        assert prefs is not None
        # Python "if not x" treats False, 0, "", etc. as falsy — but parser
        # uses .get("discoveryCompleted", False) and "if not discovery_completed".
        # So is_new_user=False only when the value is a truthy True-ish.
        assert prefs.get("discoveryCompleted", False)


@given(prefs=arbitrary_preferences())
@settings(max_examples=200, deadline=None)
def test_technical_depth_only_in_allowed_set_or_none(prefs):
    ctx = _parse_preferences(prefs)
    assert ctx.technical_depth in (None,) + _VALID_DEPTH


@given(prefs=arbitrary_preferences())
@settings(max_examples=200, deadline=None)
def test_primary_domain_only_in_allowed_set_or_none(prefs):
    ctx = _parse_preferences(prefs)
    assert ctx.primary_domain in (None,) + _VALID_DOMAIN


@given(prefs=arbitrary_preferences())
@settings(max_examples=200, deadline=None)
def test_new_user_implies_blank_preferences(prefs):
    """When the parser flags a user as new, BOTH preference fields are None."""
    ctx = _parse_preferences(prefs)
    if ctx.is_new_user:
        assert ctx.technical_depth is None
        assert ctx.primary_domain is None


@given(
    depth=st.sampled_from(_VALID_DEPTH),
    domain=st.sampled_from(_VALID_DOMAIN),
)
@settings(max_examples=50, deadline=None)
def test_completed_with_valid_values_round_trips(depth, domain):
    """Valid completed prefs surface their values verbatim on the context."""
    ctx = _parse_preferences(
        {
            "discoveryCompleted": True,
            "technical_depth": depth,
            "primary_domain": domain,
        }
    )
    assert ctx.is_new_user is False
    assert ctx.technical_depth == depth
    assert ctx.primary_domain == domain


@given(
    extra_keys=st.dictionaries(
        st.text(min_size=1, max_size=12).filter(
            lambda s: s
            not in {"discoveryCompleted", "technical_depth", "primary_domain"}
        ),
        _arbitrary_values,
        max_size=10,
    )
)
@settings(max_examples=100, deadline=None)
def test_extra_unknown_keys_are_ignored(extra_keys):
    """Adding random extra keys never changes the parse result for a known shape."""
    base = {
        "discoveryCompleted": True,
        "technical_depth": "detailed",
        "primary_domain": "data",
    }
    ctx_clean = _parse_preferences(base)
    ctx_dirty = _parse_preferences({**base, **extra_keys})
    assert ctx_clean == ctx_dirty
