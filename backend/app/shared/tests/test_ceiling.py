"""A quantity that was asked for may come down, never go up (2026-11-03)."""
from decimal import Decimal

import pytest

from app.core.exceptions import ValidationError
from app.shared import ceiling


def test_lower_and_unchanged_pass():
    ceiling.assert_not_raised(7, Decimal("10"), label="IT-1", uom="NOS")
    ceiling.assert_not_raised(10, Decimal("10"), label="IT-1", uom="NOS")


def test_raising_is_refused_and_names_the_item_and_the_limit():
    with pytest.raises(ValidationError) as err:
        ceiling.assert_not_raised(12, Decimal("10"), label="ELEC-1003", uom="NOS")
    message = str(err.value)
    assert "ELEC-1003" in message and "10 NOS" in message and "12 NOS" in message
    assert "never increased" in message


def test_no_ceiling_means_no_limit():
    ceiling.assert_not_raised(500, None, label="IT-1")


def test_a_row_saved_before_the_ceiling_uses_what_it_holds_now():
    assert ceiling.ceiling_of(None, Decimal("8")) == Decimal("8")
    assert ceiling.ceiling_of(Decimal("10"), Decimal("8")) == Decimal("10")


def test_numbers_read_cleanly():
    assert ceiling.fmt(Decimal("12.000")) == "12"
    assert ceiling.fmt(Decimal("2.500")) == "2.5"
