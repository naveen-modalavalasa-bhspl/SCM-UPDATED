"""SCM_0172: an RFQ may not be raised, or moved, onto a closing date already behind us.

Pure — the rule takes `today` as an argument, so no database and no clock.
"""
from datetime import date

import pytest

from app.core.exceptions import ValidationError
from app.modules.procurement.service import assert_rfq_due_date

TODAY = date(2026, 11, 12)


def test_a_date_in_a_previous_month_is_refused():
    with pytest.raises(ValidationError, match="already passed"):
        assert_rfq_due_date(date(2026, 10, 20), today=TODAY)


def test_yesterday_is_refused():
    with pytest.raises(ValidationError):
        assert_rfq_due_date(date(2026, 11, 11), today=TODAY)


def test_today_and_later_are_allowed():
    assert_rfq_due_date(TODAY, today=TODAY)
    assert_rfq_due_date(date(2026, 12, 1), today=TODAY)


def test_no_closing_date_is_allowed():
    assert_rfq_due_date(None, today=TODAY)
