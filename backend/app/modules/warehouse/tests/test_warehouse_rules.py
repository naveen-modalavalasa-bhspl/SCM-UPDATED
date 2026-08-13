"""Pure-logic tests for the warehouse module.

These need no database, so they still run on a machine with no MySQL and still catch
the regressions that matter most: a derived quantity that stops being derived, a
status guard that stops guarding, and an enum value that drifts from the column it
mirrors.
"""
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import mysql

from app.core.exceptions import ValidationError
from app.modules.warehouse import service
from app.modules.warehouse.enums import (
    InspectionResult, IssueStatus, PutawayStatus, PutawayType, ReceiptStatus, SerialStatus,
)
from app.modules.warehouse.models import (
    Batch, Dispatch,
    DispatchItem,
    DispatchPackage,
    MaterialIssue,
    MaterialIssueLine,
    Receipt,
    ReceiptItem,
)


def test_decimal_coercion_survives_the_junk_mysql_sends():
    # DECIMAL columns arrive as strings over the wire; a bad one must not 500.
    assert service._d("12.500") == Decimal("12.500")
    assert service._d(None) == Decimal("0")
    assert service._d("not a number") == Decimal("0")


def test_guard_names_the_status_and_the_way_out():
    # An error that says only "invalid status" leaves the user guessing.
    with pytest.raises(ValidationError) as exc:
        service._guard("COMPLETED", {"DRAFT"}, "edit", "receipt")
    message = str(exc.value.message)
    assert "COMPLETED" in message
    assert "DRAFT" in message
    assert "edit" in message


def test_guard_allows_a_status_in_the_set():
    service._guard("DRAFT", {"DRAFT", "GATE_ENTRY"}, "edit", "receipt")


def test_receipt_rollups_add_the_lines_up():
    receipt = Receipt()
    receipt.items = [
        ReceiptItem(received_qty=Decimal("10"), accepted_qty=Decimal("8"),
                    rejected_qty=Decimal("2"), amount=Decimal("80")),
        ReceiptItem(received_qty=Decimal("5"), accepted_qty=Decimal("5"),
                    rejected_qty=Decimal("0"), amount=Decimal("50")),
    ]
    service._receipt_totals(receipt)

    assert receipt.total_items == 2
    assert receipt.total_received_qty == Decimal("15")
    assert receipt.total_accepted_qty == Decimal("13")
    assert receipt.total_rejected_qty == Decimal("2")
    assert receipt.total_value == Decimal("130")


def test_receipt_rollups_go_to_zero_when_every_line_is_removed():
    receipt = Receipt()
    receipt.items = []
    service._receipt_totals(receipt)
    assert receipt.total_items == 0
    assert receipt.total_received_qty == Decimal("0")


def test_issue_rollup_counts_issued_not_requested():
    # A short issue must roll up as short; totalling the request would hide it.
    issue = MaterialIssue()
    issue.items = [
        MaterialIssueLine(
            requested_qty=Decimal("10"),
            issued_qty=Decimal("7"),
            amount=Decimal("70"),
        ),
        MaterialIssueLine(
            requested_qty=Decimal("4"),
            issued_qty=Decimal("4"),
            amount=Decimal("40"),
        ),
    ]
    service._issue_totals(issue)

    assert issue.total_items == 2
    assert issue.total_qty == Decimal("11")
    assert issue.total_value == Decimal("110")


def test_dispatch_rollup_counts_packages_and_weight():
    dispatch = Dispatch()
    dispatch.items = []
    dispatch.packages = [
        DispatchPackage(weight_kg=Decimal("12.5")),
        DispatchPackage(weight_kg=Decimal("7.5")),
    ]
    service._dispatch_totals(dispatch)

    assert dispatch.total_packages == 2
    assert dispatch.total_weight_kg == Decimal("20.0")


@pytest.mark.parametrize(
    ("inspected", "accepted", "expected"),
    [
        ("0", "0", InspectionResult.PENDING.value),
        ("10", "10", InspectionResult.PASSED.value),
        ("10", "0", InspectionResult.FAILED.value),
        ("10", "6", InspectionResult.PARTIAL.value),
    ],
)
def test_inspection_result_follows_the_split(inspected, accepted, expected):
    assert service._derive_result(Decimal(inspected), Decimal(accepted)) == expected


def test_approver_label_reads_as_who_is_holding_it():
    assert service._approver_label([]) is None
    assert service._approver_label([{"name": "Asha"}]) == "Asha"
    assert service._approver_label(
        [{"name": "Asha"}, {"name": "Ravi"}, {"name": "Sam"}]) == "Asha +2"


def test_approver_label_ignores_rows_with_no_name():
    assert service._approver_label([{"id": 4}]) is None


def test_lower_case_enums_match_the_mysql_enum_members():
    # `whs_warehouse_items` and `whs_serial_numbers` are MySQL ENUMs whose members the
    # DB team defined in lower case. Upper-casing them raises a truncation error on
    # insert, so this is the test that stops a well-meaning tidy-up.
    assert PutawayStatus.COMPLETED.value == "completed"
    assert PutawayStatus.IN_PROGRESS.value == "in_progress"
    assert PutawayType.SYSTEM_DIRECTED.value == "system_directed"
    assert SerialStatus.AVAILABLE.value == "available"

    # Everything else is UPPER_SNAKE, as the varchar columns store it.
    assert ReceiptStatus.COMPLETED.value == "COMPLETED"
    assert IssueStatus.PENDING_APPROVAL.value == "PENDING_APPROVAL"


def test_report_column_helper_marks_numeric_columns():
    assert service._col("qty", "Quantity", True) == {
        "key": "qty", "header": "Quantity", "numeric": True}
    assert service._col("code", "Code")["numeric"] is False


def test_batch_expiry_order_is_valid_mysql():
    stmt = select(Batch).order_by(Batch.expiry_date.is_(None), Batch.expiry_date.asc())
    sql = str(stmt.compile(dialect=mysql.dialect()))
    assert "NULLS LAST" not in sql
    assert "stk_batches.expiry_date IS NULL" in sql


# --------------------------------------------------------------------------- #
#  The consignment -> GRN line grouping (the 10-rows-of-1 bug)
# --------------------------------------------------------------------------- #

def _dispatch_line(**overrides):
    """A dispatch line with every field the grouper reads, defaulted to "nothing"."""
    line = DispatchItem(
        item_id=overrides.pop("item_id", 1),
        quantity=Decimal(str(overrides.pop("quantity", 1))),
    )
    defaults = {
        "item_code": "ITM-1", "item_name": "8 GB Memory Card", "uom_code": "NOS",
        "indent_id": None, "indent_no": None, "rate": None, "batch_id": None,
        "batch_no": None, "mfg_date": None, "expiry_date": None,
        "serial_no": None, "imei_no": None,
    }
    for field, value in {**defaults, **overrides}.items():
        setattr(line, field, value)
    return line


def test_serialised_units_collapse_into_one_line():
    # The bug: ten handsets dispatched as ten rows of qty 1 arrived at the LIP as ten
    # GRN lines, and were inwarded as ten separate stock lines.
    lines = [_dispatch_line(serial_no=f"SN{n}") for n in range(10)]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert len(rows) == 1
    assert rows[0]["ordered_qty"] == Decimal("10")
    assert rows[0]["received_qty"] == Decimal("10")
    assert rows[0]["accepted_qty"] == Decimal("10")
    # Collapsing the rows must not lose the units — every serial is still named.
    assert rows[0]["serial_numbers"] == [f"SN{n}" for n in range(10)]


def test_imeis_are_collected_onto_the_line_too():
    lines = [_dispatch_line(serial_no=f"SN{n}", imei_no=f"IMEI{n}") for n in range(3)]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert rows[0]["imei_numbers"] == ["IMEI0", "IMEI1", "IMEI2"]


def test_two_batches_of_one_item_stay_two_lines():
    # Each batch has its own expiry, so adding them together would receive stock the
    # receiver cannot tell apart afterwards.
    lines = [
        _dispatch_line(quantity=4, batch_no="B1"),
        _dispatch_line(quantity=6, batch_no="B2"),
    ]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert [r["ordered_qty"] for r in rows] == [Decimal("4"), Decimal("6")]
    assert [r["batch_no"] for r in rows] == ["B1", "B2"]


def test_one_item_serving_two_indents_stays_two_lines():
    # A consolidated consignment owes each request separately.
    lines = [
        _dispatch_line(quantity=2, indent_id=11, indent_no="IND/1"),
        _dispatch_line(quantity=3, indent_id=22, indent_no="IND/2"),
    ]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert [r["indent_no"] for r in rows] == ["IND/1", "IND/2"]
    assert [r["ordered_qty"] for r in rows] == [Decimal("2"), Decimal("3")]


def test_different_items_are_never_merged():
    lines = [_dispatch_line(item_id=1, quantity=5), _dispatch_line(item_id=2, quantity=7)]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert [r["item_id"] for r in rows] == [1, 2]


def test_an_unserialised_line_is_left_exactly_as_it_was():
    # The common case must be untouched by the grouping: one line in, one line out,
    # with no serial list invented for it.
    rows = service._group_dispatch_lines([_dispatch_line(quantity=25)], {}, {}, {})

    assert len(rows) == 1
    assert rows[0]["ordered_qty"] == Decimal("25")
    assert rows[0]["serial_numbers"] is None
    assert rows[0]["imei_numbers"] is None
