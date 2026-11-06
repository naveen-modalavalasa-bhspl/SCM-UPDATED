"""A PO's despatch stage is DERIVED from its submitted despatch notes (pure rule)."""
from decimal import Decimal

from app.modules.procurement.service import _despatch_status_from
from app.shared.enums import DespatchStatus


def test_nothing_sent_is_no_stage():
    assert _despatch_status_from(Decimal(10), Decimal(0)) is None


def test_part_sent_is_partially_dispatched():
    assert _despatch_status_from(Decimal(10), Decimal(4)) == \
        DespatchStatus.PARTIALLY_DISPATCHED.value


def test_everything_sent_is_dispatched():
    assert _despatch_status_from(Decimal(10), Decimal(10)) == DespatchStatus.DISPATCHED.value
    assert _despatch_status_from(Decimal(10), Decimal(12)) == DespatchStatus.DISPATCHED.value
