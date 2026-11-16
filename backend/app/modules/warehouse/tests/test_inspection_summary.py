"""SCM_0164 / 0165 / 0166: an inspection's totals are counted by QUANTITY.

Pure — `inspection_quantity_summary` takes plain rows, no database.
"""
from decimal import Decimal
from types import SimpleNamespace

from app.modules.warehouse.service import inspection_quantity_summary


def line(inspected, accepted, result="PENDING", rejected=None):
    rejected = Decimal(str(inspected)) - Decimal(str(accepted)) if rejected is None else rejected
    return SimpleNamespace(inspected_qty=Decimal(str(inspected)),
                           accepted_qty=Decimal(str(accepted)),
                           rejected_qty=Decimal(str(rejected)), result=result)


def test_a_partly_rejected_line_is_partial_and_its_rejection_is_counted():
    # The bug: 8 of 10 kept read "0/1 passed", 0 failed, 0 % and no rejected total.
    summary = inspection_quantity_summary([line(10, 8, "PARTIAL")])
    assert summary["partial_items"] == 1
    assert summary["inspected_qty"] == 10
    assert summary["accepted_qty"] == 8
    assert summary["rejected_qty"] == 2
    assert summary["pass_rate"] == 80.0


def test_pending_lines_are_judged_off_their_own_split():
    summary = inspection_quantity_summary([line(5, 5), line(4, 0), line(6, 3), line(0, 0)])
    assert summary["partial_items"] == 1
    assert summary["pending_items"] == 1
    assert summary["accepted_qty"] == 8
    assert summary["rejected_qty"] == 7
    assert summary["pass_rate"] == round(8 / 15 * 100, 1)


def test_nothing_inspected_has_no_pass_rate_rather_than_zero():
    summary = inspection_quantity_summary([line(0, 0)])
    assert summary["pass_rate"] is None
    assert inspection_quantity_summary([])["pass_rate"] is None


def test_all_accepted_is_a_full_pass():
    summary = inspection_quantity_summary([line(3, 3, "PASSED"), line(7, 7, "PASSED")])
    assert summary["pass_rate"] == 100.0
    assert summary["rejected_qty"] == 0
