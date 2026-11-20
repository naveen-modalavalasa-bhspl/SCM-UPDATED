"""The delivery window and the Delivery Challan's arithmetic (2026-11-19). Pure.

What these pin:

- a consignment states its expected delivery as a WINDOW, both ends, neither before it
  leaves and never running backwards — and the old single-date paths stay optional;
- the challan prints one line per item / batch / price inside a package, however many
  per-unit rows a coded item was stored as, and prices EVERY line: the line's own rate,
  else the item master's purchase price, saying which;
- an unmeasured package has no volume, not zero.
"""
from datetime import date
from decimal import Decimal

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import models as m
from app.modules.warehouse.delivery_challan import _summarise_lines, _volume_cbm
from app.modules.warehouse.service import _guard_delivery_window

LEAVES = date(2026, 11, 19)


def test_a_consignment_must_state_both_ends_of_the_window():
    with pytest.raises(ValidationError, match="dispatch date"):
        _guard_delivery_window(LEAVES, None, date(2026, 11, 25), required=True)
    with pytest.raises(ValidationError, match="expected delivery date"):
        _guard_delivery_window(LEAVES, date(2026, 11, 22), None, required=True)
    _guard_delivery_window(LEAVES, date(2026, 11, 22), date(2026, 11, 25), required=True)


def test_the_window_cannot_open_before_the_goods_leave_or_run_backwards():
    with pytest.raises(ValidationError, match="before the consignment date"):
        _guard_delivery_window(LEAVES, date(2026, 11, 18), date(2026, 11, 25), required=True)
    with pytest.raises(ValidationError, match="before the dispatch date"):
        _guard_delivery_window(LEAVES, date(2026, 11, 25), date(2026, 11, 22), required=True)
    with pytest.raises(ValidationError, match="before the consignment leaves"):
        _guard_delivery_window(LEAVES, None, date(2026, 11, 18), required=False)


def test_paths_that_never_asked_for_a_window_still_save_without_one():
    _guard_delivery_window(LEAVES, None, None, required=False)
    _guard_delivery_window(LEAVES, None, date(2026, 11, 25), required=False)


def _row(item_id, qty, *, rate=None, batch="B1", serial=None, line_no=1):
    return m.DispatchItem(
        item_id=item_id, item_code=f"IT-{item_id}", item_name=f"Item {item_id}",
        uom_code="NOS", batch_no=batch, quantity=Decimal(qty), delivered_qty=Decimal("0"),
        rate=None if rate is None else Decimal(rate), serial_no=serial, line_no=line_no,
        brand_id=0, variant_id=0, model_id=0)


def test_per_unit_rows_print_as_one_line_with_their_codes():
    rows = [_row(1, "1", rate="250", serial=f"SN{i}") for i in range(3)]
    lines = _summarise_lines(rows, {1: {"hsn_code": "3004", "purchase_price": Decimal("9")}})
    assert len(lines) == 1
    assert lines[0]["quantity"] == Decimal("3")
    assert lines[0]["unit_price"] == Decimal("250")
    assert lines[0]["price_source"] == "LINE"
    assert lines[0]["amount"] == Decimal("750.00")
    assert lines[0]["hsn_code"] == "3004"
    assert lines[0]["codes"] == ["SN0", "SN1", "SN2"]


def test_a_line_with_no_rate_is_priced_off_the_item_master_and_says_so():
    lines = _summarise_lines([_row(2, "4")], {2: {"hsn_code": None,
                                                 "purchase_price": Decimal("12.5")}})
    assert lines[0]["unit_price"] == Decimal("12.5")
    assert lines[0]["price_source"] == "ITEM_MASTER"
    assert lines[0]["amount"] == Decimal("50.00")


def test_two_batches_of_one_item_stay_two_lines():
    lines = _summarise_lines([_row(3, "2", rate="10", batch="A"),
                              _row(3, "5", rate="10", batch="B")], {})
    assert [line["batch_no"] for line in lines] == ["A", "B"]


def test_an_unmeasured_package_has_no_volume_not_zero():
    full = m.DispatchPackage(length_cm=Decimal("40"), width_cm=Decimal("30"),
                             height_cm=Decimal("25"))
    part = m.DispatchPackage(length_cm=Decimal("40"), width_cm=None,
                             height_cm=Decimal("25"))
    assert _volume_cbm(full) == Decimal("0.030")
    assert _volume_cbm(part) is None


def test_the_printed_challan_carries_no_codes_and_adds_packages_up():
    rows = [_row(1, "1", rate="250", serial="SN1"), _row(1, "1", rate="250", serial="SN2"),
            _row(1, "3", rate="250")]
    lines = _summarise_lines(rows, {}, with_codes=False)
    assert len(lines) == 1
    assert lines[0]["quantity"] == Decimal("5")
    assert lines[0]["codes"] == []
