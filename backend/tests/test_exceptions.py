"""SCM_0084/SCM_0070: a bound violation names the actual number.

`PaymentTermIn.advance_days` etc. are `Field(ge=0, le=3650)`. Before this,
`_issue_sentence` turned a `ge`/`le` violation into "must not be smaller than the
minimum allowed" — which says there IS a rule without saying what it is, the exact
complaint on the bug sheet. It should name the number pydantic already carries in
`ctx`, pure function, no database needed.
"""
from app.core.exceptions import _issue_sentence


def test_ge_violation_names_the_minimum():
    issue = {
        "type": "greater_than_equal",
        "loc": ("body", "advance_days"),
        "msg": "Input should be greater than or equal to 0",
        "ctx": {"ge": 0},
    }
    assert _issue_sentence(issue) == "advance_days cannot be less than 0."


def test_le_violation_names_the_maximum():
    issue = {
        "type": "less_than_equal",
        "loc": ("body", "advance_days"),
        "msg": "Input should be less than or equal to 3650",
        "ctx": {"le": 3650},
    }
    assert _issue_sentence(issue) == "advance_days cannot be more than 3650."


def test_bound_violation_with_no_ctx_falls_back_to_the_plain_phrase():
    # Defensive: a limit of 0 must not be treated as "no limit given" (`is not
    # None`, not truthiness), and a genuinely missing ctx still reads as English.
    issue = {"type": "greater_than_equal", "loc": ("body", "qty"), "msg": "..."}
    assert _issue_sentence(issue) == "qty must not be smaller than the minimum allowed."


def test_zero_limit_is_not_treated_as_missing():
    issue = {
        "type": "greater_than_equal", "loc": ("body", "qty"),
        "msg": "...", "ctx": {"ge": 0},
    }
    assert _issue_sentence(issue) == "qty cannot be less than 0."
