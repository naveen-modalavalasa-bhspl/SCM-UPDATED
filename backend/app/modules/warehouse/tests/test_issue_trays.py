"""Trays on a material issue line (MoM 2026-11-18, point 14) — the pure rules."""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import issue_trays


def test_trays_are_kept_in_order_and_may_be_short_while_filling():
    out = issue_trays.clean([{"tray_no": " T-1 ", "quantity": 3, "codes": ["A", "B"]},
                             {"tray_no": "T-2", "quantity": "2", "codes": []}],
                            issued=Decimal("10"), label="Line 1")
    assert out == [{"tray_no": "T-1", "quantity": 3.0, "codes": ["A", "B"]},
                   {"tray_no": "T-2", "quantity": 2.0, "codes": []}]
    assert issue_trays.clean([], issued=5, label="Line 1") is None


@pytest.mark.parametrize("trays, message", [
    ([{"tray_no": "", "quantity": 1}], "no tray number"),
    ([{"tray_no": "T1", "quantity": 1}, {"tray_no": "t1", "quantity": 1}], "listed twice"),
    ([{"tray_no": "T1", "quantity": 0}], "how much goes into tray T1"),
    ([{"tray_no": "T1", "quantity": 1, "codes": ["A", "B"]}], "holds 1 but 2 codes"),
    ([{"tray_no": "T1", "quantity": 2, "codes": ["A"]},
      {"tray_no": "T2", "quantity": 2, "codes": ["A"]}], "one tray only"),
    ([{"tray_no": "T1", "quantity": 6}], "trays hold 6 but the pick is 5"),
    ([{"tray_no": "T1", "quantity": 1, "codes": ["Z"]}], "not one of this pick's codes"),
])
def test_what_cannot_be_a_tray_is_refused(trays, message):
    with pytest.raises(ValidationError, match=message):
        issue_trays.clean(trays, issued=5, label="Line 1", line_codes=["A", "B"])


def test_submit_wants_every_unit_in_a_tray():
    line = SimpleNamespace(line_no=1, item_name="Tablet", item_code="T", issued_qty=Decimal("5"),
                           trays=[{"tray_no": "T1", "quantity": 3}])
    with pytest.raises(ValidationError, match="2 not yet in a tray"):
        issue_trays.assert_complete(SimpleNamespace(items=[line]))
    line.trays.append({"tray_no": "T2", "quantity": 2})
    issue_trays.assert_complete(SimpleNamespace(items=[line]))
    line.trays = None
    issue_trays.assert_complete(SimpleNamespace(items=[line]))


def test_a_code_names_its_tray():
    trays = [{"tray_no": "T1", "codes": ["A"]}, {"tray_no": "T2", "codes": ["B"]}]
    assert issue_trays.tray_for(trays, "B") == "T2"
    assert issue_trays.tray_for(trays, "C") is None
