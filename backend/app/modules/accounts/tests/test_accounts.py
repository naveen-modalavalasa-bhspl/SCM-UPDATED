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
