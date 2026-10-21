"""Accounts arithmetic — pure, no database."""
from datetime import date
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.modules.accounts.service import milestone_state, split_amounts
from app.shared.masters.defs import PaymentTermIn


def test_shares_add_up_to_the_order_total_exactly():
    shares = split_amounts(Decimal("1000.00"), [33.33, 33.33, 33.34])
    assert sum(shares) == Decimal("1000.00")
    assert split_amounts(100, [30, 70]) == [Decimal("30.00"), Decimal("70.00")]


def test_milestone_state_reads_paid_before_due():
    today = date(2026, 10, 6)
    assert milestone_state(Decimal(100), Decimal(100), True, None, today) == "PAID"
    assert milestone_state(Decimal(100), Decimal(40), True, None, today) == "PART_PAID"
    assert milestone_state(Decimal(100), Decimal(0), None, None, today) == "CONFIRM"
    assert milestone_state(Decimal(100), Decimal(0), False, None, today) == "NOT_DUE"
    assert milestone_state(Decimal(100), Decimal(0), True, date(2026, 10, 1), today) == "OVERDUE"
    assert milestone_state(Decimal(100), Decimal(0), True, date(2026, 10, 9), today) == "DUE"


def test_a_payment_term_must_split_the_whole_order():
    PaymentTermIn(code="T1", name="30/70", advance_pct=30, delivery_pct=70)
    with pytest.raises(ValidationError):
        PaymentTermIn(code="T2", name="Short", advance_pct=30, delivery_pct=60)


# --- Payment terms paid in instalments (2026-10-06) ------------------------------ #
from app.shared.masters.defs import term_instalments, term_wording  # noqa: E402


def _order_pcts(term, field):
    return [p["order_pct"] for p in term_instalments(term, field)]


def test_equal_instalments_divide_the_order_share_and_add_up_exactly():
    term = PaymentTermIn(code="E", name="Equal", advance_pct=50, delivery_pct=50,
                         delivery_split="EQUAL", delivery_instalment_days="30,60,90")
    assert _order_pcts(term, "delivery") == [Decimal("16.67"), Decimal("16.67"),
                                             Decimal("16.66")]
    assert [p["days"] for p in term_instalments(term, "delivery")] == [30, 60, 90]
    assert term.delivery_days == 30          # mirrors the first instalment
    assert term.delivery_instalment_pcts is None


def test_custom_instalments_take_each_share_of_the_stage():
    term = PaymentTermIn(code="C", name="Custom", advance_pct=70, delivery_pct=30,
                         delivery_split="CUSTOM", delivery_instalment_days="30,60,90,120",
                         delivery_instalment_pcts="30,40,10,20")
    assert _order_pcts(term, "delivery") == [Decimal("9.00"), Decimal("12.00"),
                                             Decimal("3.00"), Decimal("6.00")]


def test_custom_shares_must_make_the_whole_stage():
    with pytest.raises(ValidationError, match="add up to 100% of the stage"):
        PaymentTermIn(code="C", name="C", delivery_pct=100, delivery_split="CUSTOM",
                      delivery_instalment_days="30,60", delivery_instalment_pcts="50,40")


def test_instalment_days_must_move_forward_and_number_two_or_more():
    with pytest.raises(ValidationError, match="must fall after"):
        PaymentTermIn(code="D", name="D", delivery_pct=100, delivery_split="EQUAL",
                      delivery_instalment_days="60,30")
    with pytest.raises(ValidationError, match="at least 2"):
        PaymentTermIn(code="D", name="D", delivery_pct=100, delivery_split="EQUAL",
                      delivery_instalment_days="30")


def test_a_stage_at_zero_or_paid_once_drops_its_instalment_lists():
    term = PaymentTermIn(code="O", name="O", delivery_pct=100, delivery_days=45,
                         advance_split="EQUAL", advance_instalment_days="0,30")
    assert term.advance_split.value == "ONE" and term.advance_instalment_days is None
    assert [(p["order_pct"], p["days"]) for p in term_instalments(term, "delivery")] \
        == [(Decimal("100.00"), 45)]


def test_po_wording_leads_with_the_term_code_and_milestone_codes():
    term = PaymentTermIn(code="ADV20-D4", name="20/80 in four", advance_pct=20,
                         delivery_pct=80, delivery_split="EQUAL",
                         delivery_instalment_days="30,60,90,120")
    lines = term_wording(term).splitlines()
    assert lines[0] == "[ADV20-D4] 20/80 in four"
    assert lines[1].startswith("• ADV: 20% advance")
    assert lines[2].startswith("• DLV: 80% against delivery in 4 equal instalments")
